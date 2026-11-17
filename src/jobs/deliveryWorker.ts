/**
 * Delivery worker. sos-relay-PRD.md §8.1 steps 4 and 5, §8.3, §8.4, §11.2, §11.3.
 *
 * Each pass: fail submissions past the 30-minute hard stop (even while paused), then, unless delivery
 * is paused, deliver due submissions oldest first, one at a time; then refresh the queue gauges.
 */
import { sql } from 'kysely';
import { ALERT_CODES } from '../alerts.js';
import type { AppContext } from '../context.js';
import {
  attemptDelivery,
  failExpiredInTrx,
  HARD_STOP_MS,
  isPastHardStop,
  reportExpired,
} from '../delivery/deliver.js';
import { METRICS } from '../metrics.js';
import { getState } from '../state.js';
import type { Job } from './runner.js';

export const DELIVERY_INTERVAL_MS = 1000;
/** Rows looked at per pass. The next pass, a second later, picks up the rest. */
const BATCH = 50;

export function createDeliveryWorker(ctx: AppContext): Job {
  return { name: 'delivery', intervalMs: DELIVERY_INTERVAL_MS, run: () => runDeliveryPass(ctx) };
}

/** One full worker pass. Exported for tests. */
export async function runDeliveryPass(ctx: AppContext): Promise<void> {
  await failExpired(ctx);

  const state = await getState(ctx.db);
  if (state.paused) {
    // The Alerter de-duplicates the code to once per 15 minutes: that is the reminder (PRD §8.4).
    await ctx.alerts.raise({
      severity: 'critical',
      code: ALERT_CODES.deliveryPaused,
      message: `SOS delivery is paused${state.paused_reason ? `: ${state.paused_reason}` : ''}. Resume through the admin API once the key is fixed.`,
    });
    // Demo submissions never touch Core, so the pause does not hold them back.
    await deliverDue(ctx, true);
  } else {
    await deliverDue(ctx, false);
  }

  await updateGauges(ctx);
}

/** Every queued submission accepted 30 minutes ago or more becomes failed. */
async function failExpired(ctx: AppContext): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - HARD_STOP_MS);
  const ids = await ctx.db
    .selectFrom('submissions')
    .select('id')
    .where('status', '=', 'queued')
    .where('accepted_at', '<=', cutoff)
    .orderBy('accepted_at')
    .execute();

  for (const { id } of ids) {
    const expired = await ctx.db.transaction().execute(async (trx) => {
      // A row held by an in-flight attempt is left alone: that attempt either delivers it or
      // fails it at the hard stop itself; otherwise the next pass gets it.
      const row = await trx
        .selectFrom('submissions')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      const now = ctx.clock.now();
      if (row?.status !== 'queued' || !isPastHardStop(row.accepted_at, now)) return undefined;
      await failExpiredInTrx(trx, row, now);
      return row;
    });
    if (expired) await reportExpired(ctx, expired);
  }
}

/** Due queued submissions, oldest first, strictly one at a time. Stops as soon as delivery pauses. */
async function deliverDue(ctx: AppContext, demoOnly: boolean): Promise<void> {
  let query = ctx.db
    .selectFrom('submissions')
    .select('id')
    .where('status', '=', 'queued')
    .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', ctx.clock.now())]))
    .orderBy('accepted_at')
    .orderBy('id')
    .limit(BATCH);
  if (demoOnly) query = query.where('is_demo', '=', true);
  const due = await query.execute();

  for (const { id } of due) {
    const outcome = await attemptDelivery(ctx, id, { dueOnly: true });
    if (outcome === 'queued' && !demoOnly && (await getState(ctx.db)).paused) {
      ctx.log.warn('delivery paused during a worker pass; stopping');
      return;
    }
  }
}

async function updateGauges(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  const row = await ctx.db
    .selectFrom('submissions')
    .select([sql<string>`count(*)`.as('depth'), sql<Date | null>`min(accepted_at)`.as('oldest')])
    .where('status', '=', 'queued')
    .where('is_demo', '=', false)
    .executeTakeFirstOrThrow();
  const depth = Number(row.depth);
  const oldestAgeS = row.oldest ? Math.max(0, (now.getTime() - new Date(row.oldest).getTime()) / 1000) : 0;
  const paused = (await getState(ctx.db)).paused;

  ctx.metrics.set(METRICS.queueDepth, depth);
  ctx.metrics.set(METRICS.oldestQueuedAge, oldestAgeS);
  ctx.metrics.set(METRICS.paused, paused ? 1 : 0);

  const { queueDepthWarn, oldestQueuedWarnS } = ctx.config.limits;
  if (depth > queueDepthWarn || oldestAgeS > oldestQueuedWarnS) {
    await ctx.alerts.raise({
      severity: 'warning',
      code: ALERT_CODES.queueBacklog,
      message: `SOS delivery backlog: ${depth} queued, oldest ${Math.round(oldestAgeS)} s`,
    });
  }
}
