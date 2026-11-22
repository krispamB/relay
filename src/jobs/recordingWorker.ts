/**
 * Recording attach worker. docs/live-sos-plan.md §4.3, D7, D10.
 *
 * Each pass takes the due `pending` recordings, oldest first, and attaches each to its Core call with
 * SaveCallFile, one at a time. The claim is `FOR UPDATE SKIP LOCKED` on the recording row and the Core
 * call runs inside that transaction, as the delivery worker does, so two instances never send one
 * recording twice at once. Core documents no Idempotency-Key for SaveCallFile, so a lost 201 can attach
 * a file twice; the retry count is kept low for that reason (plan §2.2).
 *
 * Every change of a recording's status bumps the SOS's live version in the transaction that makes it.
 * A reschedule is not a status change and does not.
 *
 * The audio is never logged: this file logs recording and receipt ids and the Core status only.
 */
import { ALERT_CODES } from '../alerts.js';
import { addMs, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { Recording } from '../db/types.js';
import { nextAttemptAt } from '../delivery/backoff.js';
import { safeError } from '../errors.js';
import { bumpLiveVersion } from '../live/version.js';
import { METRICS } from '../metrics.js';
import { pauseDelivery } from '../state.js';
import type { Job } from './runner.js';

export const RECORDING_INTERVAL_MS = 1000;
/** Rows looked at per pass. The next pass, a second later, picks up the rest. */
const BATCH = 25;
/** Plan §4.3: at most this many SaveCallFile attempts, then the recording is dropped. */
export const MAX_ATTACH_ATTEMPTS = 5;
/** Plan §4.3: how long a recording waits for its call to exist before the worker looks again. */
export const WAIT_FOR_CALL_MS = 5 * SECOND;

/** Why a recording ended `dropped`. These are the values of `recordings.drop_reason` and the metric label. */
export type DropReason =
  | 'call_closed'
  | 'sos_closed'
  | 'sos_failed'
  | 'attempts_exhausted'
  | 'core_rejected'
  | 'window_ended'
  | 'no_bytes';

export function createRecordingWorker(ctx: AppContext): Job {
  return { name: 'recordings', intervalMs: RECORDING_INTERVAL_MS, run: () => runRecordingPass(ctx) };
}

/** One worker pass. Exported for tests. */
export async function runRecordingPass(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  const due = await ctx.db
    .selectFrom('recordings')
    .select('id')
    .where('status', '=', 'pending')
    .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
    .orderBy('created_at')
    .orderBy('id')
    .limit(BATCH)
    .execute();

  for (const { id } of due) {
    try {
      await attachOne(ctx, id);
    } catch (err) {
      // One failing row must not hold up the ones behind it; it is due again on the next pass.
      ctx.log.error({ error: safeError(err), recordingId: id }, 'recording attach failed');
    }
  }
}

/** What the transaction decided; logs, metrics and alerts run after it commits. */
type Decision =
  | { kind: 'skipped' }
  | { kind: 'waiting' }
  | { kind: 'paused' }
  | { kind: 'attached'; ids: Ids; demo: boolean }
  | { kind: 'dropped'; ids: Ids; demo: boolean; reason: DropReason; httpStatus?: number }
  | { kind: 'retry'; ids: Ids; attempts: number; reason: string }
  | { kind: 'auth'; ids: Ids; httpStatus: number };

interface Ids {
  recordingId: string;
  receiptId: string;
  reference: string;
  seq: number;
}

/** Runs inside the claiming transaction: ends the recording as dropped and tells the live view. */
async function drop(
  trx: Db,
  rec: Recording,
  reason: DropReason,
  extra: { attempts?: number } = {},
): Promise<void> {
  await trx
    .updateTable('recordings')
    .set({ status: 'dropped', drop_reason: reason, bytes: null, next_attempt_at: null, ...extra })
    .where('id', '=', rec.id)
    .execute();
  await bumpLiveVersion(trx, rec.submission_id);
}

async function attachOne(ctx: AppContext, recordingId: string): Promise<void> {
  const decision = await ctx.db.transaction().execute(async (trx): Promise<Decision> => {
    // The claim: a row another pass holds is skipped, never waited on.
    const rec = await trx
      .selectFrom('recordings')
      .selectAll()
      .where('id', '=', recordingId)
      .where('status', '=', 'pending')
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!rec) return { kind: 'skipped' };
    const claimedAt = ctx.clock.now();
    // A row another instance just rescheduled is not attempted again before its time.
    if (rec.next_attempt_at !== null && rec.next_attempt_at > claimedAt) return { kind: 'skipped' };

    const sub = await trx
      .selectFrom('submissions')
      .select(['status', 'reference', 'is_demo', 'core_call_id'])
      .where('id', '=', rec.submission_id)
      .executeTakeFirstOrThrow();
    const ids: Ids = {
      recordingId: rec.id,
      receiptId: rec.submission_id,
      reference: sub.reference,
      seq: rec.seq,
    };
    const demo = sub.is_demo;

    // The audio can never be attached once the SOS has ended (plan D10).
    if (sub.status === 'closed' || sub.status === 'failed') {
      const reason = sub.status === 'closed' ? 'sos_closed' : 'sos_failed';
      await drop(trx, rec, reason);
      return { kind: 'dropped', ids, demo, reason };
    }
    if (rec.bytes === null) {
      await drop(trx, rec, 'no_bytes');
      return { kind: 'dropped', ids, demo, reason: 'no_bytes' };
    }

    // PRD §6.3: a demo submission never reaches Core.
    if (demo) {
      await markAttached(trx, rec, null, claimedAt);
      return { kind: 'attached', ids, demo };
    }

    // No Core call yet (the SOS is still queued): look again soon, and do not count an attempt.
    if (sub.core_call_id === null) {
      await trx
        .updateTable('recordings')
        .set({ next_attempt_at: addMs(claimedAt, WAIT_FOR_CALL_MS) })
        .where('id', '=', rec.id)
        .execute();
      return { kind: 'waiting' };
    }

    // PRD §8.4: while paused, no Core calls of any kind.
    const state = await trx
      .selectFrom('relay_state')
      .select('paused')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (state.paused) return { kind: 'paused' };

    let result: Awaited<ReturnType<AppContext['core']['saveCallFile']>>;
    try {
      result = await ctx.core.saveCallFile({
        callId: sub.core_call_id,
        name: `${sub.reference}-${rec.seq}.m4a`,
        data: rec.bytes,
      });
    } catch (err) {
      // The client is not supposed to throw; if it does, the outcome is unknown, so retry.
      ctx.log.error({ error: safeError(err), ...ids }, 'core client threw');
      result = { kind: 'retryable', reason: 'client error' };
    }
    const now = ctx.clock.now();
    const attempts = rec.attempts + 1;

    switch (result.kind) {
      case 'ok':
        await markAttached(trx, rec, result.data.fileId, now, attempts);
        return { kind: 'attached', ids, demo };
      case 'call_closed':
        await drop(trx, rec, 'call_closed', { attempts });
        return { kind: 'dropped', ids, demo, reason: 'call_closed' };
      case 'rejected':
        await drop(trx, rec, 'core_rejected', { attempts });
        return { kind: 'dropped', ids, demo, reason: 'core_rejected', httpStatus: result.httpStatus };
      case 'auth':
        // Core's refusal says nothing about this recording: leave it as it is, pending.
        return { kind: 'auth', ids, httpStatus: result.httpStatus };
      case 'conflict':
      case 'retryable': {
        const reason = result.kind === 'retryable' ? result.reason : 'HTTP 409';
        if (attempts >= MAX_ATTACH_ATTEMPTS) {
          await drop(trx, rec, 'attempts_exhausted', { attempts });
          return { kind: 'dropped', ids, demo, reason: 'attempts_exhausted' };
        }
        await trx
          .updateTable('recordings')
          .set({
            attempts,
            next_attempt_at: nextAttemptAt(
              now,
              attempts,
              result.kind === 'retryable' ? result.retryAfterSeconds : undefined,
            ),
          })
          .where('id', '=', rec.id)
          .execute();
        return { kind: 'retry', ids, attempts, reason };
      }
    }
  });

  await afterCommit(ctx, decision);
}

async function markAttached(
  trx: Db,
  rec: Recording,
  coreFileId: string | null,
  now: Date,
  attempts = rec.attempts,
): Promise<void> {
  await trx
    .updateTable('recordings')
    .set({
      status: 'attached',
      core_file_id: coreFileId,
      bytes: null,
      attached_at: now,
      next_attempt_at: null,
      attempts,
    })
    .where('id', '=', rec.id)
    .execute();
  await bumpLiveVersion(trx, rec.submission_id);
}

async function afterCommit(ctx: AppContext, decision: Decision): Promise<void> {
  switch (decision.kind) {
    case 'skipped':
    case 'waiting':
    case 'paused':
      return;
    case 'attached':
      ctx.log.info({ ...decision.ids, demo: decision.demo }, 'recording attached');
      if (!decision.demo) ctx.metrics.inc(METRICS.recordingsAttached);
      return;
    case 'dropped': {
      const { ids, reason, demo } = decision;
      ctx.log.warn({ ...ids, reason, demo }, 'recording dropped');
      if (!demo) ctx.metrics.inc(METRICS.recordingsDropped, { reason });
      if (demo) return;
      if (reason === 'core_rejected') {
        await ctx.alerts.raise({
          severity: 'high',
          code: ALERT_CODES.recordingRejected,
          message: `Core rejected the recording of SOS ${ids.reference} with HTTP ${decision.httpStatus}; it was dropped`,
          reference: ids.reference,
          receiptId: ids.receiptId,
          always: true,
        });
      } else if (reason === 'attempts_exhausted') {
        await ctx.alerts.raise({
          severity: 'warning',
          code: ALERT_CODES.recordingDropped,
          message: `The recording of SOS ${ids.reference} could not be attached to the Core call after ${MAX_ATTACH_ATTEMPTS} attempts and was dropped`,
          reference: ids.reference,
          receiptId: ids.receiptId,
        });
      }
      return;
    }
    case 'retry':
      ctx.log.warn(
        { ...decision.ids, attempts: decision.attempts, reason: decision.reason },
        'recording attach will be retried',
      );
      return;
    case 'auth': {
      const flipped = await pauseDelivery(
        ctx.db,
        ctx.clock.now(),
        `Core returned ${decision.httpStatus} on SaveCallFile`,
      );
      ctx.log.error(
        { ...decision.ids, httpStatus: decision.httpStatus, flipped },
        'Core refused the API key on SaveCallFile; delivery paused',
      );
      if (flipped) {
        ctx.metrics.set(METRICS.paused, 1);
        await ctx.alerts.raise({
          severity: 'critical',
          code: ALERT_CODES.deliveryPaused,
          message: `SOS delivery paused: Core returned ${decision.httpStatus} on SaveCallFile`,
        });
      }
      return;
    }
  }
}
