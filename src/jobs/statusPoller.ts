/**
 * Status poller. sos-relay-PRD.md §6.3, §8.4, §8.5, §9.2; integration.md §5.
 *
 * Each pass, in order:
 * 1. The 24-hour window (runs even while paused): a submission accepted 24 hours ago or more stops
 *    being polled, and one still `received` or `dispatched` is closed.
 * 2. Demo submissions move on their configured timetable (runs even while paused; never touches Core).
 * 3. Unless delivery is paused: one GetPendingCalls for every due `received` submission, with one
 *    GetCall for each whose call has left the list; then a GetCall for each due `dispatched` (60 s)
 *    and `closed` (5 min) submission.
 *
 * Scheduling lives in `next_poll_at`, so intervals hold across restarts. Rows are claimed by moving
 * `next_poll_at` to the next interval inside a short locking transaction, before Core is called, so a
 * second instance never polls the same row in the same interval. The result is then applied in its
 * own transaction, which re-reads the row and ignores the result if the row changed meanwhile.
 * Alerts are raised only after that transaction commits.
 */

import { sql } from 'kysely';
import { raiseStrikeAlerts, recordHoaxStrikes, removeStrikes, type StrikeOutcome } from '../abuse/strikes.js';
import { ALERT_CODES } from '../alerts.js';
import { addMs, HOUR, MINUTE, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { CallStateResult, CoreResult } from '../core/types.js';
import { type Db, isUniqueViolation } from '../db/index.js';
import { OPEN_STATUSES, type Submission, type SubmissionStatus, type SubmissionUpdate } from '../db/types.js';
import { safeError } from '../errors.js';
import { bumpLiveVersion } from '../live/version.js';
import { METRICS } from '../metrics.js';
import { getState, pauseDelivery } from '../state.js';
import type { Job } from './runner.js';

export const POLLER_TICK_MS = 1000;
/** PRD §8.5 intervals. 15 s is also Core's floor for reading any one call (PRD §5.2). */
export const RECEIVED_INTERVAL_MS = 15 * SECOND;
export const DISPATCHED_INTERVAL_MS = 60 * SECOND;
export const CLOSED_INTERVAL_MS = 5 * MINUTE;
/** PRD §8.5: polling stops this long after acceptance. */
export const STATUS_WINDOW_MS = 24 * HOUR;

/** Event causes written by the poller. */
export const POLL_CAUSES = {
  windowEnded: 'status_window_ended',
  notFound: 'core_not_found',
  reopenSuppressed: 'core_reopen_suppressed_newer_open',
  demoDispatched: 'demo_dispatched',
  demoClosed: 'demo_closed',
} as const;

export function coreStateCause(state: number): string {
  return `core_state_${state}`;
}

/** Rows per GetCall phase; the next pass, a second later, takes the rest. */
const BATCH = 50;
/** Received rows covered by one GetPendingCalls. */
const RECEIVED_BATCH = 500;
/** Serialises the received-batch claim across instances, so GetPendingCalls stays >= 15 s apart. */
const RECEIVED_CLAIM_LOCK = 0x534f_5301;

type PolledStatus = 'received' | 'dispatched' | 'closed';

export function pollIntervalMs(status: PolledStatus): number {
  switch (status) {
    case 'received':
      return RECEIVED_INTERVAL_MS;
    case 'dispatched':
      return DISPATCHED_INTERVAL_MS;
    case 'closed':
      return CLOSED_INTERVAL_MS;
  }
}

const ROW_COLUMNS = [
  'id',
  'reference',
  'status',
  'is_demo',
  'core_call_id',
  'core_state',
  'user_id',
  'phone_hash',
  'accepted_at',
  'delivered_at',
  'next_poll_at',
] as const;

type Row = Pick<Submission, (typeof ROW_COLUMNS)[number]>;

/** Per-pass memory: whether the key was confirmed good, and whether the pass must stop. */
interface PassState {
  keyConfirmed: boolean;
  stop: boolean;
}

export function createStatusPoller(ctx: AppContext): Job {
  return { name: 'status-poller', intervalMs: POLLER_TICK_MS, run: () => runStatusPollerPass(ctx) };
}

/** One full poller pass. Exported for tests. */
export async function runStatusPollerPass(ctx: AppContext): Promise<void> {
  await closeExpiredWindows(ctx);
  await advanceDemo(ctx);

  // PRD §8.4: while paused, no Core calls of any kind.
  if ((await getState(ctx.db)).paused) return;
  const pass: PassState = { keyConfirmed: false, stop: false };
  await pollReceived(ctx, pass);
  if (pass.stop) return;
  await pollDispatchedAndClosed(ctx, pass);
}

function ids(row: Pick<Row, 'id' | 'reference'>): { receiptId: string; reference: string } {
  return { receiptId: row.id, reference: row.reference };
}

function pastWindow(acceptedAt: Date, now: Date): boolean {
  return now.getTime() - acceptedAt.getTime() >= STATUS_WINDOW_MS;
}

/** A status change, its event, and the live version bump, inside the caller's transaction. */
async function writeTransition(
  trx: Db,
  row: Pick<Row, 'id' | 'status'>,
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
  // Units are shown only while dispatched (plan §5.1): their rows go when the SOS leaves it.
  if (row.status === 'dispatched' && to !== 'dispatched') {
    await trx.deleteFrom('submission_units').where('submission_id', '=', row.id).execute();
  }
  await bumpLiveVersion(trx, row.id);
}

// ---------------------------------------------------------------------------------------------
// 1. The 24-hour window
// ---------------------------------------------------------------------------------------------

/**
 * PRD §8.5: after 24 hours, stop polling and close what is still open, or a call nobody closes in
 * Resgrid would keep the user from ever sending again. Clearing next_poll_at also means a later
 * re-open in Core can never resurrect the submission.
 */
async function closeExpiredWindows(ctx: AppContext): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - STATUS_WINDOW_MS);
  const due = await ctx.db
    .selectFrom('submissions')
    .select('id')
    .where('next_poll_at', 'is not', null)
    .where('accepted_at', '<=', cutoff)
    .orderBy('accepted_at')
    .limit(BATCH)
    .execute();

  for (const { id } of due) {
    const closed = await ctx.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('submissions')
        .select(ROW_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      const now = ctx.clock.now();
      if (!row || row.next_poll_at === null || !pastWindow(row.accepted_at, now)) return undefined;
      if (row.status === 'received' || row.status === 'dispatched') {
        await writeTransition(trx, row, 'closed', POLL_CAUSES.windowEnded, now, {
          closed_at: now,
          next_poll_at: null,
        });
        return row;
      }
      await trx.updateTable('submissions').set({ next_poll_at: null }).where('id', '=', row.id).execute();
      return undefined;
    });
    if (closed) {
      ctx.log.info(
        { ...ids(closed), from: closed.status, demo: closed.is_demo },
        'status window ended; submission closed',
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Demo submissions (PRD §6.3)
// ---------------------------------------------------------------------------------------------

const DEMO_STEPS: readonly PolledStatus[] = ['received', 'dispatched', 'closed'];

async function advanceDemo(ctx: AppContext): Promise<void> {
  const due = await ctx.db
    .selectFrom('submissions')
    .select('id')
    .where('is_demo', '=', true)
    .where('status', 'in', DEMO_STEPS)
    .where('next_poll_at', '<=', ctx.clock.now())
    .orderBy('next_poll_at')
    .limit(BATCH)
    .execute();

  for (const { id } of due) {
    const moved = await ctx.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('submissions')
        .select(ROW_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      const now = ctx.clock.now();
      if (!row?.is_demo || row.next_poll_at === null || row.next_poll_at > now) return undefined;
      const current = DEMO_STEPS.indexOf(row.status as PolledStatus);
      if (current < 0) return undefined;

      const base = (row.delivered_at ?? row.accepted_at).getTime();
      const dispatchAt = new Date(base + ctx.config.demoDispatchAfterS * SECOND);
      const closeAt = new Date(base + ctx.config.demoCloseAfterS * SECOND);
      const target = now >= closeAt ? 2 : now >= dispatchAt ? 1 : 0;

      // A late pass still walks through every step, so the history reads received, dispatched, closed.
      let from: SubmissionStatus = row.status;
      for (let step = current + 1; step <= target; step++) {
        const to = DEMO_STEPS[step]!;
        await writeTransition(
          trx,
          { id: row.id, status: from },
          to,
          to === 'closed' ? POLL_CAUSES.demoClosed : POLL_CAUSES.demoDispatched,
          now,
          to === 'closed' ? { closed_at: now } : {},
        );
        from = to;
      }
      const reached = Math.max(current, target);
      const nextPoll = reached === 0 ? dispatchAt : reached === 1 ? closeAt : null;
      await trx.updateTable('submissions').set({ next_poll_at: nextPoll }).where('id', '=', row.id).execute();
      return target > current ? { row, to: DEMO_STEPS[target]! } : undefined;
    });
    if (moved) ctx.log.info({ ...ids(moved.row), demo: true, status: moved.to }, 'demo SOS status changed');
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Core reads
// ---------------------------------------------------------------------------------------------

/** The client is not supposed to throw; if it does, treat it as a transient failure. */
async function safely<T>(ctx: AppContext, fn: () => Promise<CoreResult<T>>): Promise<CoreResult<T>> {
  try {
    return await fn();
  } catch (err) {
    ctx.log.error({ error: safeError(err) }, 'core client threw');
    return { kind: 'retryable', reason: 'client error' };
  }
}

/** PRD §8.4: pause, and raise the critical alert only if this call is the one that paused. */
async function pauseForAuth(ctx: AppContext, reason: string): Promise<void> {
  const flipped = await pauseDelivery(ctx.db, ctx.clock.now(), reason);
  ctx.log.error({ reason, flipped }, 'Core refused the API key; delivery paused');
  if (flipped) {
    ctx.metrics.set(METRICS.paused, 1);
    await ctx.alerts.raise({
      severity: 'critical',
      code: ALERT_CODES.deliveryPaused,
      message: `SOS delivery paused: ${reason}`,
    });
  }
}

async function pollReceived(ctx: AppContext, pass: PassState): Promise<void> {
  const claimed = await ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${RECEIVED_CLAIM_LOCK}::bigint)`.execute(trx);
    const now = ctx.clock.now();
    const windowStart = new Date(now.getTime() - STATUS_WINDOW_MS);
    const anyDue = await trx
      .selectFrom('submissions')
      .select('id')
      .where('status', '=', 'received')
      .where('is_demo', '=', false)
      .where('next_poll_at', '<=', now)
      .where('accepted_at', '>', windowStart)
      .limit(1)
      .executeTakeFirst();
    if (!anyDue) return [];
    // Also take the rows that would fall due before the next batch: one GetPendingCalls covers them
    // all, and keeping every received row on the same 15 s beat keeps GetPendingCalls >= 15 s apart.
    const rows = await trx
      .selectFrom('submissions')
      .select(ROW_COLUMNS)
      .where('status', '=', 'received')
      .where('is_demo', '=', false)
      .where('next_poll_at', '<=', addMs(now, RECEIVED_INTERVAL_MS))
      .where('accepted_at', '>', windowStart)
      .orderBy('next_poll_at')
      .limit(RECEIVED_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length > 0) {
      await trx
        .updateTable('submissions')
        .set({ next_poll_at: addMs(now, RECEIVED_INTERVAL_MS) })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
    }
    return rows;
  });
  if (claimed.length === 0) return;

  const res = await safely(ctx, () => ctx.core.getPendingCalls());
  if (res.kind === 'auth') {
    // GetPendingCalls takes no id, so a 401 or 403 here can only mean the key.
    await pauseForAuth(ctx, `Core returned ${res.httpStatus} on GetPendingCalls`);
    pass.stop = true;
    return;
  }
  if (res.kind !== 'ok') {
    ctx.log.warn(
      { result: res.kind, reason: res.kind === 'retryable' ? res.reason : undefined, rows: claimed.length },
      'GetPendingCalls failed; received submissions will be polled at the next interval',
    );
    return;
  }

  const pending = new Set(res.data.callIds);
  for (const row of claimed) {
    if (row.core_call_id === null) {
      ctx.log.error(ids(row), 'received submission has no Core call id');
      continue;
    }
    // Still in the pending list: still received. Nothing to read, nothing to write.
    if (pending.has(row.core_call_id)) continue;
    await pollOne(ctx, pass, row);
    if (pass.stop) return;
  }
}

async function pollDispatchedAndClosed(ctx: AppContext, pass: PassState): Promise<void> {
  const claimed = await ctx.db.transaction().execute(async (trx) => {
    const now = ctx.clock.now();
    const rows = await trx
      .selectFrom('submissions')
      .select(ROW_COLUMNS)
      .where('status', 'in', ['dispatched', 'closed'])
      .where('is_demo', '=', false)
      .where('next_poll_at', '<=', now)
      .where('accepted_at', '>', new Date(now.getTime() - STATUS_WINDOW_MS))
      .orderBy('next_poll_at')
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const status of ['dispatched', 'closed'] as const) {
      const of = rows.filter((r) => r.status === status).map((r) => r.id);
      if (of.length === 0) continue;
      await trx
        .updateTable('submissions')
        .set({ next_poll_at: addMs(now, pollIntervalMs(status)) })
        .where('id', 'in', of)
        .execute();
    }
    return rows;
  });

  for (const row of claimed) {
    if (row.core_call_id === null) {
      ctx.log.error(ids(row), 'submission has no Core call id; cannot poll');
      continue;
    }
    await pollOne(ctx, pass, row);
    if (pass.stop) return;
  }
}

/**
 * integration.md §5.1: a 401 from GetCall may only mean the call belongs to another department.
 * Returns 'good' when GetNewCallFieldPolicy works (once per pass), 'bad' when it is also refused.
 */
async function confirmKey(ctx: AppContext, pass: PassState): Promise<'good' | 'bad' | 'unknown'> {
  if (pass.keyConfirmed) return 'good';
  const res = await safely(ctx, () => ctx.core.getFieldPolicy());
  if (res.kind === 'ok') {
    pass.keyConfirmed = true;
    return 'good';
  }
  return res.kind === 'auth' ? 'bad' : 'unknown';
}

async function pollOne(ctx: AppContext, pass: PassState, row: Row): Promise<void> {
  const callId = row.core_call_id as string;
  const res = await safely(ctx, () => ctx.core.getCall(callId));
  if (res.kind === 'auth') {
    const key = await confirmKey(ctx, pass);
    if (key === 'bad') {
      await pauseForAuth(ctx, `Core returned ${res.httpStatus} on GetCall and on GetNewCallFieldPolicy`);
      pass.stop = true;
    } else if (key === 'good') {
      ctx.log.warn(
        { ...ids(row), httpStatus: res.httpStatus },
        'GetCall refused for this call while the key works; call unreadable, status kept',
      );
    } else {
      // Cannot tell a bad key from a foreign call: stop reading for this pass rather than send
      // more requests a bad key would count toward Core's lockout (integration.md §2.4).
      ctx.log.warn(
        { ...ids(row), httpStatus: res.httpStatus },
        'GetCall refused and the key could not be confirmed; stopping this pass',
      );
      pass.stop = true;
    }
    return;
  }
  if (res.kind !== 'ok') {
    ctx.log.warn(
      { ...ids(row), result: res.kind, reason: res.kind === 'retryable' ? res.reason : undefined },
      'GetCall failed; status kept, will poll at the next interval',
    );
    return;
  }
  try {
    await applyCallState(ctx, row, res.data);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A newer SOS for the user was accepted between our check and the update: same as suppressed.
    ctx.log.warn(ids(row), 'status change collided with a newer open SOS; will retry at the next poll');
  }
}

type Applied =
  | { kind: 'stale' }
  | { kind: 'unknown'; row: Row; state: number | undefined }
  | { kind: 'same'; row: Row; strikeOutcomes: StrikeOutcome[] }
  | { kind: 'transition'; row: Row; to: PolledStatus; strikeOutcomes: StrikeOutcome[] }
  | {
      kind: 'suppressed';
      row: Row;
      newer: { id: string; reference: string };
      strikeOutcomes: StrikeOutcome[];
    };

async function applyCallState(ctx: AppContext, claimed: Row, result: CallStateResult): Promise<void> {
  const applied = await ctx.db.transaction().execute(async (trx): Promise<Applied> => {
    const row = await trx
      .selectFrom('submissions')
      .select(ROW_COLUMNS)
      .where('id', '=', claimed.id)
      .forUpdate()
      .executeTakeFirst();
    const now = ctx.clock.now();
    // Changed since the claim (another instance, erasure), or the window ended while we read Core:
    // the window pass owns it now.
    if (
      !row ||
      row.status !== claimed.status ||
      row.next_poll_at === null ||
      pastWindow(row.accepted_at, now)
    ) {
      return { kind: 'stale' };
    }
    // integration.md §5.3: an unknown state keeps the last known status.
    if (result.status === undefined) return { kind: 'unknown', row, state: result.state };

    // PRD §9.2: strikes follow the Core state. A not_found (deleted call) says nothing about whether
    // it was a hoax, so it leaves strikes as they are.
    let strikeOutcomes: StrikeOutcome[] = [];
    if (result.hoax) strikeOutcomes = await recordHoaxStrikes(trx, row, now, ctx.config.limits);
    else if (!result.notFound) strikeOutcomes = await removeStrikes(trx, row, now, ctx.config.limits);

    const coreState = result.notFound ? null : (result.state ?? null);
    const to = result.status;
    if (to === row.status) {
      if (coreState !== row.core_state) {
        await trx
          .updateTable('submissions')
          .set({ core_state: coreState, updated_at: now })
          .where('id', '=', row.id)
          .execute();
      }
      return { kind: 'same', row, strikeOutcomes };
    }

    // A re-open while the user already has a newer open SOS: the one-open-per-user rule holds,
    // the newer SOS is the caller's live one, and this submission stays closed (see report).
    if (row.status === 'closed') {
      const newer = await trx
        .selectFrom('submissions')
        .select(['id', 'reference'])
        .where('user_id', '=', row.user_id)
        .where('id', '!=', row.id)
        .where('is_demo', '=', row.is_demo)
        .where('status', 'in', OPEN_STATUSES)
        .limit(1)
        .executeTakeFirst();
      if (newer) {
        if (coreState !== row.core_state) {
          await trx
            .updateTable('submissions')
            .set({ core_state: coreState, updated_at: now })
            .where('id', '=', row.id)
            .execute();
          await trx
            .insertInto('submission_events')
            .values({
              submission_id: row.id,
              from_status: 'closed',
              to_status: 'closed',
              cause: POLL_CAUSES.reopenSuppressed,
              at: now,
            })
            .execute();
        }
        return { kind: 'suppressed', row, newer, strikeOutcomes };
      }
    }

    await writeTransition(
      trx,
      row,
      to,
      result.notFound ? POLL_CAUSES.notFound : coreStateCause(result.state as number),
      now,
      {
        core_state: coreState,
        closed_at: to === 'closed' ? now : null,
        next_poll_at: addMs(now, pollIntervalMs(to)),
      },
    );
    return { kind: 'transition', row, to, strikeOutcomes };
  });

  switch (applied.kind) {
    case 'stale':
      return;
    case 'unknown': {
      const shown = applied.state === undefined ? 'no state' : `state ${applied.state}`;
      ctx.log.warn(
        { ...ids(applied.row), coreState: applied.state, status: applied.row.status },
        'unknown Core call state; status kept',
      );
      await ctx.alerts.raise({
        severity: 'warning',
        code: ALERT_CODES.unknownCallState,
        message: `Core reported ${shown} for SOS ${applied.row.reference}; its status stays ${applied.row.status}`,
        ...ids(applied.row),
      });
      return;
    }
    case 'same':
      break;
    case 'transition':
      ctx.log.info(
        { ...ids(applied.row), from: applied.row.status, to: applied.to, coreState: result.state },
        'SOS status changed',
      );
      break;
    case 'suppressed':
      ctx.log.warn(
        {
          ...ids(applied.row),
          coreState: result.state,
          newerReceiptId: applied.newer.id,
          newerReference: applied.newer.reference,
        },
        'call re-opened in Core while the user has a newer open SOS; submission kept closed',
      );
      break;
  }
  await raiseStrikeAlerts(ctx, applied.strikeOutcomes);
}
