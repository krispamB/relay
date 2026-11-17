/**
 * `POST /v1/sos`. sos-relay-PRD.md §7.4 (the order of checks is followed exactly), §8.1, §8.3, §9.1.
 *
 * Steps 1 and 2 (device token, device block) run in onRequest, before the body is parsed or
 * validated, so a bad token is a 401 whatever the body. Step 3 is Fastify's schema validation plus
 * `validateStatic`. Checks that depend on the intake, the clock or the field policy run after the
 * replay and open-SOS checks, so a retry of an accepted SOS always gets its receipt back.
 *
 * Logs name a submission by receiptId and reference only. The body is never logged.
 */
import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { isBlocked } from '../abuse/blocks.js';
import { ALERT_CODES } from '../alerts.js';
import { clientIp, type PublicApp } from '../app.js';
import type { AppContext } from '../context.js';
import { bindingHash, phoneHash } from '../crypto.js';
import type { Device, Submission, SubmissionStatus } from '../db/types.js';
import { attemptDelivery, type DeliveryOutcome } from '../delivery/deliver.js';
import { requireDevice } from '../devices/auth.js';
import { ApiError, errors } from '../errors.js';
import { METRICS } from '../metrics.js';
import { inlineTimeoutMs, sosBudget } from '../sos/budget.js';
import {
  findByIdempotencyKey,
  findOpenSubmission,
  getSubmissionById,
  persistSubmission,
  releaseInlineHold,
} from '../sos/persist.js';
import { httpStatusFor, openSubmissionError, receiptFor } from '../sos/receipt.js';
import { SosBody, SosHeaders, SosResponses } from '../sos/schemas.js';
import { validateContent, validateStatic } from '../sos/validate.js';
import { getState } from '../state.js';

/** Retry-After for a 503 while the intake is unavailable: the app does not auto-retry anyway. */
export const UNAVAILABLE_RETRY_AFTER_S = 60;

interface RequestState {
  /** Monotonic start, for the time budget and the latency histogram. */
  startedAt: number;
  device?: Device;
  /** Set once the intake is known; demo requests stay out of operational metrics (PRD §6.3). */
  demo: boolean;
}

const requestState = new WeakMap<FastifyRequest, RequestState>();

function stateOf(req: FastifyRequest): RequestState {
  let st = requestState.get(req);
  if (!st) {
    st = { startedAt: performance.now(), demo: false };
    requestState.set(req, st);
  }
  return st;
}

/** A Postgres error can carry the failing row in `detail`; log only what cannot hold caller data. */
function safeErr(err: unknown): { errName?: string; errCode?: string } {
  const e = err as { name?: unknown; code?: unknown } | null;
  return {
    errName: typeof e?.name === 'string' ? e.name : undefined,
    errCode: typeof e?.code === 'string' ? e.code : undefined,
  };
}

export async function sosRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const secret = ctx.config.statusTokenSecret;

  app.post(
    '/v1/sos',
    {
      schema: {
        summary: 'Send an SOS',
        description:
          'Order of checks: device token (401), device block (403), headers and body (400), attestation (403), ' +
          'intake (404/410), replay of the same Idempotency-Key (201/202), open SOS (409), phone block (403), ' +
          'rate limits (429, or 503 for the whole-intake breaker), availability (503), then persist and deliver.',
        tags: ['sos'],
        security: [{ deviceToken: [] }],
        headers: SosHeaders,
        body: SosBody,
        response: SosResponses,
      },
      onRequest: async (req) => {
        const st = stateOf(req);
        // Step 1.
        const device = await requireDevice(ctx, req);
        // Step 2.
        if (await isBlocked(ctx.db, 'device', device.id, ctx.clock.now())) {
          req.log.info({ deviceId: device.id }, 'SOS refused: device blocked');
          throw errors.forbidden();
        }
        st.device = device;
      },
      onResponse: async (req) => {
        const st = requestState.get(req);
        if (st && !st.demo)
          ctx.metrics.observe(METRICS.sosLatency, (performance.now() - st.startedAt) / 1000);
      },
    },
    async (req, reply) => {
      try {
        return await handle(req, req.body, req.headers['idempotency-key'], reply);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // Replace the error so the shared handler cannot log a database detail holding caller data.
        req.log.error(safeErr(err), 'SOS request failed');
        throw new Error('SOS request failed');
      }
    },
  );

  async function handle(
    req: FastifyRequest,
    body: SosBody,
    idempotencyKey: string,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const st = stateOf(req);
    const device = st.device;
    if (!device) throw errors.unauthorized();

    // Step 3 (the schema part already ran).
    const sos = validateStatic(body);

    // Step 4.
    await verifyAttestation(req, device, idempotencyKey);

    // Step 5.
    const intake = ctx.intakes.get(sos.intakeCode);
    if (!intake) throw errors.notFound();
    if (!intake.enabled) throw errors.gone();
    st.demo = intake.demo;

    // Step 6: a replay sends nothing and answers with the current state.
    const prior = await findByIdempotencyKey(ctx.db, device.id, idempotencyKey);
    if (prior) return sendReplay(req.log, reply, prior, st.demo);

    // Step 7.
    const open = await findOpenSubmission(ctx.db, device.id, intake.demo);
    if (open) throw conflict(req.log, open, st.demo);

    // The checks that depend on the intake, the clock and the field policy.
    const state = await getState(ctx.db);
    const content = validateContent(sos, intake, ctx.clock.now(), {
      // The demo intake never reaches Core, so Core's field policy does not apply to it (PRD §7.1).
      requiredLocation: intake.demo ? false : state.required_location,
    });

    // Step 8.
    const ph = phoneHash(ctx.config.phoneHashSecret, content.phoneE164);
    if (await isBlocked(ctx.db, 'phone', ph, ctx.clock.now())) {
      req.log.info({ deviceId: device.id }, 'SOS refused: phone number blocked');
      throw errors.forbidden();
    }

    // Steps 9, 10, 11 (with 6 and 7 repeated under the intake lock).
    const outcome = await persistSubmission(ctx, {
      device,
      idempotencyKey,
      intake,
      content,
      phoneHash: ph,
      ip: clientIp(req, ctx.config.clientIpHeader),
    });

    switch (outcome.kind) {
      case 'replay':
        return sendReplay(req.log, reply, outcome.row, st.demo);
      case 'open':
        throw conflict(req.log, outcome.row, st.demo);
      case 'limited': {
        const { rule, retryAfterSeconds } = outcome.hit;
        req.log.warn({ rule, demo: st.demo, retryAfterSeconds }, 'SOS refused: rate limit');
        if (!st.demo) ctx.metrics.inc(METRICS.rateLimited, { rule });
        if (rule !== 'intake_breaker') throw errors.rateLimited(retryAfterSeconds);
        if (!st.demo) {
          const { intakeBreakerCount, intakeBreakerWindowS } = ctx.config.limits;
          // Not awaited: alerts never sit on the SOS request path (PRD §11.2).
          ctx.alerts
            .raise({
              severity: 'critical',
              code: ALERT_CODES.intakeBreaker,
              message: `Whole-intake breaker tripped: ${intakeBreakerCount} SOS in ${intakeBreakerWindowS} s; new SOS are refused with 503`,
            })
            .catch(() => {});
        }
        throw errors.unavailable(retryAfterSeconds, 'intake_busy');
      }
      case 'unavailable':
        req.log.warn({ reason: outcome.reason }, 'SOS refused: intake unavailable');
        throw errors.unavailable(UNAVAILABLE_RETRY_AFTER_S);
      case 'created':
        req.log.info(
          { receiptId: outcome.row.id, reference: outcome.row.reference, demo: st.demo },
          'SOS accepted',
        );
        return deliverInline(req, reply, outcome.row, st);
    }
  }

  async function verifyAttestation(
    req: FastifyRequest,
    device: Device,
    idempotencyKey: string,
  ): Promise<void> {
    const header = req.headers['x-attestation'];
    const result = await ctx.attestation.verifyRequest({
      platform: device.platform,
      attestation: typeof header === 'string' && header !== '' ? header : undefined,
      // The bytes as received (PRD §7.4), never re-serialised JSON.
      bindingHash: bindingHash(idempotencyKey, req.rawBody ?? Buffer.alloc(0)),
      device: { iosPublicKeyPem: device.ios_public_key, iosCounter: Number(device.ios_counter) },
    });
    if (!result.accepted) {
      req.log.warn({ deviceId: device.id, reason: result.reason }, 'SOS refused: attestation');
      throw errors.forbidden();
    }
    if (result.iosCounter === undefined) return;
    // Stored only if still greater than what is stored: of two requests racing with assertions
    // verified against the same stored counter, exactly one advances it. The other used a counter
    // that is no longer greater than the stored one, which the rule forbids (PRD §7.4).
    const res = await ctx.db
      .updateTable('devices')
      .set({ ios_counter: result.iosCounter, updated_at: ctx.clock.now() })
      .where('id', '=', device.id)
      .where('ios_counter', '<', String(result.iosCounter))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) {
      req.log.warn(
        { deviceId: device.id },
        'SOS attestation: iOS counter was not greater than the stored one',
      );
      if (ctx.config.attestation.mode === 'enforce') throw errors.forbidden();
    }
  }

  function sendReplay(
    log: FastifyBaseLogger,
    reply: FastifyReply,
    row: Submission,
    demo: boolean,
  ): FastifyReply {
    log.info({ receiptId: row.id, reference: row.reference, status: row.status }, 'SOS replay');
    if (!demo) ctx.metrics.inc(METRICS.submissions, { outcome: 'replay' });
    return reply.code(httpStatusFor(row.status)).send(receiptFor(secret, row));
  }

  function conflict(log: FastifyBaseLogger, open: Submission, demo: boolean): ApiError {
    log.info({ receiptId: open.id, reference: open.reference }, 'SOS refused: one already open');
    if (!demo) ctx.metrics.inc(METRICS.submissions, { outcome: 'conflict' });
    return openSubmissionError(secret, open);
  }

  /** PRD §8.1 steps 2 and 3. Every path ends in an honest answer within the budget. */
  async function deliverInline(
    req: FastifyRequest,
    reply: FastifyReply,
    row: Submission,
    st: RequestState,
  ): Promise<FastifyReply> {
    const ids = { receiptId: row.id, reference: row.reference };
    const timeoutMs = inlineTimeoutMs(performance.now() - st.startedAt, sosBudget());
    let outcome: DeliveryOutcome | 'not_attempted' = 'not_attempted';
    if (timeoutMs !== undefined) {
      try {
        outcome = await attemptDelivery(ctx, row.id, { timeoutMs });
      } catch (err) {
        // The row is committed as queued; whatever happened, the worker retries it with the same
        // Idempotency-Key, so Core cannot create a second call.
        req.log.error({ ...ids, ...safeErr(err) }, 'inline delivery attempt failed; left to the worker');
      }
    } else {
      req.log.warn(ids, 'no time left for an inline attempt; left to the worker');
    }

    switch (outcome) {
      case 'received':
      case 'failed':
        return reply.code(201).send(receiptFor(secret, row, outcome));
      case 'skipped': {
        // Someone else holds or already finished it: answer from what is stored now.
        let status: SubmissionStatus = 'queued';
        try {
          status = (await getSubmissionById(ctx.db, row.id))?.status ?? 'queued';
        } catch (err) {
          req.log.error({ ...ids, ...safeErr(err) }, 'could not re-read submission; answering queued');
        }
        if (status === 'queued' && !st.demo) ctx.metrics.inc(METRICS.submissions, { outcome: 'queued' });
        return reply.code(httpStatusFor(status)).send(receiptFor(secret, row, status));
      }
      case 'queued':
      case 'not_attempted':
        await releaseHold(req, row);
        if (!st.demo) ctx.metrics.inc(METRICS.submissions, { outcome: 'queued' });
        return reply.code(202).send(receiptFor(secret, row, 'queued'));
    }
  }

  /** See releaseInlineHold. Not fatal on failure: the hold runs out on its own within seconds. */
  async function releaseHold(req: FastifyRequest, row: Submission): Promise<void> {
    try {
      await releaseInlineHold(ctx.db, row.id, ctx.clock.now());
    } catch (err) {
      req.log.error(
        { receiptId: row.id, reference: row.reference, ...safeErr(err) },
        'could not release hold',
      );
    }
  }
}
