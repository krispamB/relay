import { Type } from '@sinclair/typebox';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { ALERT_CODES } from '../alerts.js';
import { DAY } from '../clock.js';
import type { AppContext } from '../context.js';
import { phoneHash } from '../crypto.js';
import type { Block, SubmissionStatus } from '../db/types.js';
import { ApiError, errors } from '../errors.js';
import { newBlockId } from '../ids.js';
import { METRICS } from '../metrics.js';
import { getState, pauseDelivery, resumeDelivery, unavailableReason } from '../state.js';
import type { AdminApp } from './app.js';

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

const StateBody = Type.Object({
  paused: Type.Boolean(),
  pausedReason: NullableString,
  pausedAt: NullableString,
});

const HealthBody = Type.Object({
  paused: Type.Boolean(),
  pausedReason: NullableString,
  pausedAt: NullableString,
  available: Type.Boolean(),
  unavailableReason: NullableString,
  check: Type.Object({
    status: Type.String(),
    detail: NullableString,
    at: NullableString,
    okAt: NullableString,
  }),
  required: Type.Object({ location: Type.Boolean(), address: Type.Boolean(), name: Type.Boolean() }),
  resgridKey: Type.Object({ expiresOn: Type.String(), daysRemaining: Type.Number() }),
  queue: Type.Object({ depth: Type.Number(), oldestAgeSeconds: NullableNumber }),
  openSubmissions: Type.Object({ queued: Type.Number(), received: Type.Number(), dispatched: Type.Number() }),
});

const SubmissionBody = Type.Object({
  reference: Type.String(),
  receiptId: Type.String(),
  status: Type.String(),
  isDemo: Type.Boolean(),
  attempts: Type.Number(),
  coreCallId: NullableString,
  coreState: NullableNumber,
  failureReason: NullableString,
  acceptedAt: Type.String(),
  deliveredAt: NullableString,
  closedAt: NullableString,
  updatedAt: Type.String(),
  events: Type.Array(
    Type.Object({
      fromStatus: NullableString,
      toStatus: Type.String(),
      cause: Type.String(),
      at: Type.String(),
    }),
  ),
});

const BlockBody = Type.Object({
  id: Type.String(),
  subjectType: Type.String(),
  subject: Type.String(),
  reason: Type.String(),
  source: Type.String(),
  createdAt: Type.String(),
  expiresAt: NullableString,
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The stored failure_reason may hold text returned by Core, which can echo caller input.
 * Only the fixed strings deliver.ts writes pass; the Core message is dropped.
 */
export function safeFailureReason(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === 'not delivered within 30 minutes') return raw;
  const m = /^Core rejected the call: HTTP (\d{3})(?::|$)/.exec(raw);
  if (m) return `Core rejected the call: HTTP ${m[1]}`;
  return 'delivery failed';
}

function blockView(b: Block) {
  return {
    id: b.id,
    subjectType: b.subject_type,
    subject: b.subject,
    reason: b.reason,
    source: b.source,
    createdAt: b.created_at.toISOString(),
    expiresAt: iso(b.expires_at),
  };
}

export async function adminRoutes(app: AdminApp, ctx: AppContext): Promise<void> {
  const { db, clock } = ctx;

  const stateView = async () => {
    const s = await getState(db);
    return { paused: s.paused, pausedReason: s.paused_reason, pausedAt: iso(s.paused_at) };
  };

  app.get('/admin/v1/health', { schema: { response: { 200: HealthBody } } }, async () => {
    const now = clock.now();
    const s = await getState(db);
    const reason = unavailableReason(s, now);

    const open = await db
      .selectFrom('submissions')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('is_demo', '=', false)
      .where('status', 'in', ['queued', 'received', 'dispatched'])
      .groupBy('status')
      .execute();
    const counts: Record<string, number> = { queued: 0, received: 0, dispatched: 0 };
    for (const r of open) counts[r.status as SubmissionStatus] = Number(r.n);

    const oldest = await db
      .selectFrom('submissions')
      .select((eb) => eb.fn.min('accepted_at').as('oldest'))
      .where('is_demo', '=', false)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    const oldestAt = oldest?.oldest ?? null;

    const expiresOn = ctx.config.resgrid.apiKeyExpiresOn;
    const daysRemaining = Math.floor((new Date(`${expiresOn}T00:00:00Z`).getTime() - now.getTime()) / DAY);

    return {
      paused: s.paused,
      pausedReason: s.paused_reason,
      pausedAt: iso(s.paused_at),
      available: reason === undefined,
      unavailableReason: reason ?? null,
      check: {
        status: s.check_status,
        detail: s.check_detail,
        at: iso(s.check_at),
        okAt: iso(s.check_ok_at),
      },
      required: { location: s.required_location, address: s.required_address, name: s.required_name },
      resgridKey: { expiresOn, daysRemaining },
      queue: {
        depth: counts.queued ?? 0,
        oldestAgeSeconds: oldestAt
          ? Math.max(0, Math.floor((now.getTime() - oldestAt.getTime()) / 1000))
          : null,
      },
      openSubmissions: {
        queued: counts.queued ?? 0,
        received: counts.received ?? 0,
        dispatched: counts.dispatched ?? 0,
      },
    };
  });

  app.post('/admin/v1/delivery/pause', { schema: { response: { 200: StateBody } } }, async (req) => {
    // The body is optional, so it is checked by hand: a missing body fails schema validation.
    const raw = (req.body as { reason?: unknown } | undefined | null)?.reason;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length < 1 || raw.length > 200)) {
      throw errors.badRequest('invalid_request', 'reason must be a string of 1 to 200 characters.');
    }
    const reason = raw ? `Paused by an operator: ${raw}` : 'Paused by an operator';
    const changed = await pauseDelivery(db, clock.now(), reason);
    ctx.metrics.set(METRICS.paused, 1);
    if (changed) {
      req.log.warn('delivery paused by hand');
      await ctx.alerts.raise({
        severity: 'critical',
        code: ALERT_CODES.deliveryPaused,
        message: 'SOS delivery paused by an operator',
      });
    }
    return stateView();
  });

  app.post('/admin/v1/delivery/resume', { schema: { response: { 200: StateBody } } }, async (req) => {
    const s = await getState(db);
    if (!s.paused) return stateView();
    const res = await ctx.core.getFieldPolicy();
    switch (res.kind) {
      case 'ok':
        await resumeDelivery(db);
        ctx.metrics.set(METRICS.paused, 0);
        req.log.info('delivery resumed by an operator');
        return stateView();
      case 'auth':
        throw new ApiError(
          409,
          'core_auth_failed',
          `Core still refuses the API key (HTTP ${res.httpStatus}). Delivery stays paused. Fix the key, then resume.`,
        );
      case 'retryable':
        throw new ApiError(
          503,
          'core_unreachable',
          'Core could not be reached to check the API key. Delivery stays paused. Try again shortly.',
        );
      default:
        throw new ApiError(
          502,
          'core_unexpected_answer',
          'Core gave an unexpected answer to the key check. Delivery stays paused.',
        );
    }
  });

  app.get(
    '/admin/v1/submissions/:reference',
    {
      schema: {
        params: Type.Object({ reference: Type.String({ minLength: 1, maxLength: 32 }) }),
        response: { 200: SubmissionBody },
      },
    },
    async (req) => {
      const row = await db
        .selectFrom('submissions')
        .select([
          'id',
          'reference',
          'status',
          'is_demo',
          'attempts',
          'core_call_id',
          'core_state',
          'failure_reason',
          'accepted_at',
          'delivered_at',
          'closed_at',
          'updated_at',
        ])
        .where('reference', '=', req.params.reference.trim().toUpperCase())
        .executeTakeFirst();
      if (!row) throw errors.notFound();
      const events = await db
        .selectFrom('submission_events')
        .select(['from_status', 'to_status', 'cause', 'at'])
        .where('submission_id', '=', row.id)
        .orderBy('id')
        .execute();
      return {
        reference: row.reference,
        receiptId: row.id,
        status: row.status,
        isDemo: row.is_demo,
        attempts: row.attempts,
        coreCallId: row.core_call_id,
        coreState: row.core_state,
        failureReason: row.status === 'failed' ? safeFailureReason(row.failure_reason) : null,
        acceptedAt: row.accepted_at.toISOString(),
        deliveredAt: iso(row.delivered_at),
        closedAt: iso(row.closed_at),
        updatedAt: row.updated_at.toISOString(),
        events: events.map((e) => ({
          fromStatus: e.from_status,
          toStatus: e.to_status,
          cause: e.cause,
          at: e.at.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/admin/v1/blocks',
    { schema: { response: { 200: Type.Object({ blocks: Type.Array(BlockBody) }) } } },
    async () => {
      const rows = await db
        .selectFrom('blocks')
        .selectAll()
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', clock.now())]))
        .orderBy('created_at', 'desc')
        .execute();
      return { blocks: rows.map(blockView) };
    },
  );

  const days = Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 }));
  const reasonField = Type.String({ minLength: 1, maxLength: 200 });
  app.post(
    '/admin/v1/blocks',
    {
      schema: {
        body: Type.Union([
          Type.Object(
            { userId: Type.String({ minLength: 1, maxLength: 64 }), reason: reasonField, days },
            { additionalProperties: false },
          ),
          Type.Object(
            { phone: Type.String({ minLength: 3, maxLength: 32 }), reason: reasonField, days },
            { additionalProperties: false },
          ),
        ]),
        response: { 201: BlockBody },
      },
    },
    async (req, reply) => {
      const body = req.body as { userId?: string; phone?: string; reason: string; days?: number };
      let subjectType: 'user' | 'phone';
      let subject: string;
      if (body.userId !== undefined) {
        subjectType = 'user';
        subject = body.userId;
      } else {
        const parsed = parsePhoneNumberFromString(body.phone ?? '');
        if (!parsed?.isValid()) {
          throw errors.badRequest(
            'invalid_phone',
            'Give the phone number in international format, e.g. +2348012345678.',
          );
        }
        subjectType = 'phone';
        subject = phoneHash(ctx.config.phoneHashSecret, parsed.number);
      }
      const now = clock.now();
      const ttlDays = body.days ?? ctx.config.limits.blockTtlDays;
      const row = await db
        .insertInto('blocks')
        .values({
          id: newBlockId(now.getTime()),
          subject_type: subjectType,
          subject,
          reason: body.reason,
          source: 'manual',
          created_at: now,
          expires_at: new Date(now.getTime() + ttlDays * DAY),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      req.log.info({ blockId: row.id, subjectType }, 'manual block created');
      return reply.status(201).send(blockView(row));
    },
  );

  app.delete(
    '/admin/v1/blocks/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
        response: { 200: Type.Object({ deleted: Type.Boolean() }) },
      },
    },
    async (req) => {
      const res = await db.deleteFrom('blocks').where('id', '=', req.params.id).executeTakeFirst();
      if (Number(res.numDeletedRows) === 0) throw errors.notFound();
      req.log.info({ blockId: req.params.id }, 'block removed');
      return { deleted: true };
    },
  );

  app.post(
    '/admin/v1/erasure',
    {
      schema: {
        body: Type.Union([
          Type.Object(
            { phone: Type.String({ minLength: 3, maxLength: 32 }) },
            { additionalProperties: false },
          ),
          Type.Object(
            { reference: Type.String({ minLength: 1, maxLength: 32 }) },
            { additionalProperties: false },
          ),
        ]),
        response: { 200: Type.Object({ deleted: Type.Number() }) },
      },
    },
    async (req) => {
      const body = req.body as { phone?: string; reference?: string };
      let q = db.deleteFrom('submissions');
      let by: 'phone' | 'reference';
      if (body.phone !== undefined) {
        const parsed = parsePhoneNumberFromString(body.phone);
        if (!parsed?.isValid()) {
          throw errors.badRequest(
            'invalid_phone',
            'Give the phone number in international format, e.g. +2348012345678.',
          );
        }
        q = q.where('phone_hash', '=', phoneHash(ctx.config.phoneHashSecret, parsed.number));
        by = 'phone';
      } else {
        q = q.where('reference', '=', (body.reference ?? '').trim().toUpperCase());
        by = 'reference';
      }
      const rows = await q.returning('id').execute();
      req.log.warn({ by, deleted: rows.length }, 'erasure performed');
      return { deleted: rows.length };
    },
  );

  app.get('/metrics', async (_req, reply) => {
    const m = ctx.metrics as { render?: () => Promise<string>; contentType?: string };
    if (typeof m.render !== 'function') throw errors.notFound();
    const text = await m.render();
    return reply.header('content-type', m.contentType ?? 'text/plain; version=0.0.4').send(text);
  });
}
