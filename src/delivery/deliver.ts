/**
 * One delivery attempt for one submission. sos-relay-PRD.md §6.3, §8.1, §8.3, §8.4.
 * Used by the HTTP route (inline attempt) and by the delivery worker.
 */

import { ALERT_CODES } from '../alerts.js';
import { addMs, MINUTE, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { CoreResult } from '../core/types.js';
import type { Db } from '../db/index.js';
import type { Submission, SubmissionStatus, SubmissionUpdate } from '../db/types.js';
import { safeError } from '../errors.js';
import { bumpLiveVersion } from '../live/version.js';
import { METRICS } from '../metrics.js';
import { pauseDelivery } from '../state.js';
import { nextAttemptAt } from './backoff.js';
import { buildSaveCallInput } from './mapping.js';

/** PRD §8.1 step 5: a queued submission fails this long after acceptance. */
export const HARD_STOP_MS = 30 * MINUTE;
/** First status poll after Core accepted the call (PRD §8.5). */
export const FIRST_POLL_DELAY_MS = 15 * SECOND;

/**
 * `not_sent` is for the inline attempt only (AttemptOptions.inline): the submission could not move
 * because delivery is paused, and has been marked failed so that the 503 the caller gets stays true.
 */
export type DeliveryOutcome = 'received' | 'failed' | 'queued' | 'skipped' | 'not_sent';

/** Event causes for a submission that was saved but answered 503 (PRD §8.1). */
export const NOT_SENT_CAUSES = {
  paused: 'not_sent_paused',
  coreAuth: (httpStatus: number) => `not_sent_core_auth_${httpStatus}`,
} as const;

export interface AttemptOptions {
  /** Budget for the SaveCall request. Defaults to the client's 6 s. */
  timeoutMs?: number;
  /**
   * The inline attempt of `POST /v1/sos` (PRD §8.1). When delivery is paused before the attempt, or
   * Core answers 401/403 to it, the caller is about to be told 503 ("not sent, call instead"), so the
   * submission is marked `failed` rather than left queued: it must not reach dispatch later when an
   * operator resumes, nor hold the user's one open SOS. Without this flag (the worker) such a
   * submission stays queued, as before.
   */
  inline?: boolean;
  /**
   * Worker use: skip the row unless next_attempt_at is due at claim time, so a row another
   * instance just retried is not attempted again before its backoff.
   */
  dueOnly?: boolean;
}

/**
 * Runs inside the claiming transaction: status change, its event row, updated_at, and the live
 * version bump the snapshot needs (docs/live-sos-plan.md §5.3).
 */
async function transition(
  trx: Db,
  row: Pick<Submission, 'id' | 'status'>,
  to: SubmissionStatus,
  cause: string,
  now: Date,
  extra: SubmissionUpdate,
): Promise<void> {
  await trx
    .updateTable('submissions')
    .set({ ...extra, status: to, updated_at: now })
    .where('id', '=', row.id)
    .execute();
  await trx
    .insertInto('submission_events')
    .values({ submission_id: row.id, from_status: row.status, to_status: to, cause, at: now })
    .execute();
  await bumpLiveVersion(trx, row.id);
}

export function isPastHardStop(acceptedAt: Date, now: Date): boolean {
  return now.getTime() - acceptedAt.getTime() >= HARD_STOP_MS;
}

/** Marks a claimed queued row failed at the 30-minute mark (inside the claiming transaction). */
export async function failExpiredInTrx(trx: Db, row: Submission, now: Date): Promise<void> {
  await trx
    .updateTable('submissions')
    .set({
      status: 'failed',
      failure_reason: 'not delivered within 30 minutes',
      next_attempt_at: null,
      updated_at: now,
    })
    .where('id', '=', row.id)
    .execute();
  await trx
    .insertInto('submission_events')
    .values({ submission_id: row.id, from_status: 'queued', to_status: 'failed', cause: 'expired', at: now })
    .execute();
  await bumpLiveVersion(trx, row.id);
}

/**
 * Marks a claimed queued row failed because it was not sent and the caller is answered 503 (inside
 * the claiming transaction). See AttemptOptions.inline.
 */
async function failNotSentInTrx(
  trx: Db,
  row: Submission,
  now: Date,
  cause: string,
  reason: string,
  extra: SubmissionUpdate = {},
): Promise<void> {
  await transition(trx, row, 'failed', cause, now, {
    ...extra,
    failure_reason: `not sent: ${reason}; the caller was answered 503`,
    next_attempt_at: null,
  });
}

/**
 * For an inline attempt that never started (no time left in the request budget): if delivery is
 * paused, marks the submission failed as not sent, as attemptDelivery does with `inline`, and
 * returns true so the route answers 503. Otherwise leaves it queued for the worker.
 */
export async function failIfPausedInline(ctx: AppContext, submissionId: string): Promise<boolean> {
  const failed = await ctx.db.transaction().execute(async (trx): Promise<Submission | undefined> => {
    const row = await trx
      .selectFrom('submissions')
      .selectAll()
      .where('id', '=', submissionId)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (row?.status !== 'queued' || row.is_demo) return undefined;
    const state = await trx
      .selectFrom('relay_state')
      .select('paused')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (!state.paused) return undefined;
    await failNotSentInTrx(trx, row, ctx.clock.now(), NOT_SENT_CAUSES.paused, 'delivery is paused');
    return row;
  });
  if (!failed) return false;
  reportNotSent(ctx, failed, 'delivery is paused');
  return true;
}

/** Log and metric for a submission answered 503 after it was saved. No alert: the pause has its own. */
function reportNotSent(ctx: AppContext, row: Submission, why: string): void {
  ctx.log.warn(
    { receiptId: row.id, reference: row.reference },
    `SOS not sent (${why}); marked failed and answered 503`,
  );
  ctx.metrics.inc(METRICS.submissions, { outcome: 'not_sent' });
}

/** Alert and metric for a submission that hit the hard stop. Called after commit. */
export async function reportExpired(ctx: AppContext, row: Submission): Promise<void> {
  ctx.log.error(
    { receiptId: row.id, reference: row.reference, demo: row.is_demo },
    'submission expired undelivered',
  );
  if (row.is_demo) return;
  ctx.metrics.inc(METRICS.submissions, { outcome: 'failed' });
  await ctx.alerts.raise({
    severity: 'high',
    code: ALERT_CODES.submissionFailed,
    message: `SOS ${row.reference} was not delivered to Core within 30 minutes and has been marked failed`,
    reference: row.reference,
    receiptId: row.id,
    always: true,
  });
}

/** What the transaction decided; side effects (alerts, pause, metrics) run after commit. */
type Decision =
  | { kind: 'skipped' }
  | { kind: 'paused' }
  | { kind: 'not_sent_paused'; row: Submission }
  | { kind: 'expired'; row: Submission }
  | { kind: 'demo'; row: Submission }
  | { kind: 'core'; row: Submission; result: CoreResult<{ callId: string }>; now: Date };

export async function attemptDelivery(
  ctx: AppContext,
  submissionId: string,
  opts: AttemptOptions = {},
): Promise<DeliveryOutcome> {
  const decision = await ctx.db.transaction().execute(async (trx): Promise<Decision> => {
    // The claim: a row another attempt holds is skipped, never waited on, so one submission is
    // never sent twice at once (two instances, or the inline attempt and the worker).
    const row = await trx
      .selectFrom('submissions')
      .selectAll()
      .where('id', '=', submissionId)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (row?.status !== 'queued') return { kind: 'skipped' };

    const claimedAt = ctx.clock.now();
    if (opts.dueOnly && row.next_attempt_at !== null && row.next_attempt_at > claimedAt) {
      return { kind: 'skipped' };
    }
    if (isPastHardStop(row.accepted_at, claimedAt)) {
      await failExpiredInTrx(trx, row, claimedAt);
      return { kind: 'expired', row };
    }

    // PRD §6.3: a demo submission never reaches Core.
    if (row.is_demo) {
      await transition(trx, row, 'received', 'demo', claimedAt, {
        delivered_at: claimedAt,
        next_attempt_at: null,
        next_poll_at: addMs(claimedAt, FIRST_POLL_DELAY_MS),
      });
      return { kind: 'demo', row };
    }

    // PRD §8.4: while paused, no Core calls of any kind.
    const state = await trx
      .selectFrom('relay_state')
      .select(['paused', 'required_address', 'required_name'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (state.paused) {
      if (!opts.inline) return { kind: 'paused' };
      await failNotSentInTrx(trx, row, claimedAt, NOT_SENT_CAUSES.paused, 'delivery is paused');
      return { kind: 'not_sent_paused', row };
    }

    // ContactName is the account's name (docs/live-sos-plan.md §3.2). The user row cannot be gone:
    // deleting a user deletes their submissions.
    const user = await trx
      .selectFrom('users')
      .select('full_name')
      .where('id', '=', row.user_id)
      .executeTakeFirst();
    const input = buildSaveCallInput({ ...row, contact_name: user?.full_name ?? null }, ctx.config.resgrid, {
      requiredAddress: state.required_address,
      requiredName: state.required_name,
    });
    let result: CoreResult<{ callId: string }>;
    try {
      result = await ctx.core.saveCall(
        input,
        row.id,
        opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs },
      );
    } catch (err) {
      // The client is not supposed to throw; if it does, the outcome is unknown, so retry.
      ctx.log.error(
        { error: safeError(err), receiptId: row.id, reference: row.reference },
        'core client threw',
      );
      result = { kind: 'retryable', reason: 'client error' };
    }
    const now = ctx.clock.now();
    const attempts = row.attempts + 1;

    switch (result.kind) {
      case 'ok':
        await transition(trx, row, 'received', 'core_created', now, {
          attempts,
          core_call_id: result.data.callId,
          core_state: 8,
          delivered_at: now,
          next_attempt_at: null,
          next_poll_at: addMs(now, FIRST_POLL_DELAY_MS),
        });
        break;
      case 'rejected':
        await transition(trx, row, 'failed', `core_rejected_${result.httpStatus}`, now, {
          attempts,
          failure_reason: `Core rejected the call: HTTP ${result.httpStatus}${result.message ? `: ${result.message}` : ''}`,
          next_attempt_at: null,
        });
        break;
      case 'auth':
        if (opts.inline) {
          // Core created nothing. The caller is told 503 and phones; see AttemptOptions.inline.
          await failNotSentInTrx(
            trx,
            row,
            now,
            NOT_SENT_CAUSES.coreAuth(result.httpStatus),
            `Core returned ${result.httpStatus} on SaveCall and delivery was paused`,
            { attempts },
          );
          break;
        }
        // Worker: stays queued; the pause stops further attempts until an operator resumes.
        await trx
          .updateTable('submissions')
          .set({ attempts, updated_at: now })
          .where('id', '=', row.id)
          .execute();
        break;
      case 'conflict':
      case 'retryable':
        await trx
          .updateTable('submissions')
          .set({
            attempts,
            next_attempt_at: nextAttemptAt(
              now,
              attempts,
              result.kind === 'retryable' ? result.retryAfterSeconds : undefined,
            ),
            updated_at: now,
          })
          .where('id', '=', row.id)
          .execute();
        break;
    }
    return { kind: 'core', row, result, now };
  });

  switch (decision.kind) {
    case 'skipped':
      return 'skipped';
    case 'paused':
      return 'queued';
    case 'not_sent_paused':
      reportNotSent(ctx, decision.row, 'delivery is paused');
      return 'not_sent';
    case 'expired':
      await reportExpired(ctx, decision.row);
      return 'failed';
    case 'demo':
      ctx.log.info(
        { receiptId: decision.row.id, reference: decision.row.reference, demo: true },
        'demo SOS received',
      );
      return 'received';
    case 'core':
      return afterCore(ctx, decision.row, decision.result, decision.now, opts.inline === true);
  }
}

async function afterCore(
  ctx: AppContext,
  row: Submission,
  result: CoreResult<{ callId: string }>,
  now: Date,
  inline: boolean,
): Promise<DeliveryOutcome> {
  const ids = { receiptId: row.id, reference: row.reference };
  switch (result.kind) {
    case 'ok':
      ctx.metrics.inc(METRICS.submissions, { outcome: 'received' });
      ctx.log.info({ ...ids, requestId: result.requestId }, 'SOS delivered to Core');
      return 'received';
    case 'rejected': {
      ctx.metrics.inc(METRICS.submissions, { outcome: 'failed' });
      ctx.log.error({ ...ids, httpStatus: result.httpStatus }, 'Core rejected SOS');
      // Only Core's field-policy list goes into the alert text: it names policy keys, never caller data.
      const policy = /^Required call fields are missing: [A-Za-z0-9, ]{0,200}$/.test(result.message)
        ? ` (${result.message})`
        : '';
      await ctx.alerts.raise({
        severity: 'high',
        code: ALERT_CODES.coreRejected,
        message: `Core rejected SOS ${row.reference} with HTTP ${result.httpStatus}${policy}; it will not be retried`,
        ...ids,
        always: true,
      });
      return 'failed';
    }
    case 'auth': {
      const flipped = await pauseDelivery(ctx.db, now, `Core returned ${result.httpStatus} on SaveCall`);
      ctx.log.error(
        { ...ids, httpStatus: result.httpStatus, flipped },
        'Core refused the API key; delivery paused',
      );
      if (flipped) {
        ctx.metrics.set(METRICS.paused, 1);
        await ctx.alerts.raise({
          severity: 'critical',
          code: ALERT_CODES.deliveryPaused,
          message: `SOS delivery paused: Core returned ${result.httpStatus} on SaveCall`,
        });
      }
      if (!inline) return 'queued';
      reportNotSent(ctx, row, `Core returned ${result.httpStatus}`);
      return 'not_sent';
    }
    case 'conflict':
    case 'retryable':
      ctx.log.warn(
        { ...ids, result: result.kind, reason: result.kind === 'retryable' ? result.reason : undefined },
        'SOS delivery will be retried',
      );
      return 'queued';
  }
}
