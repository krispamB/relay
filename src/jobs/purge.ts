/**
 * Retention purge. sos-relay-PRD.md §10.5. Hourly, hard deletes, in small batches so no pass holds a
 * long lock. Logs counts only.
 */

import { DAY, HOUR } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Job } from './runner.js';

export const PURGE_INTERVAL_MS = HOUR;
export const SUBMISSION_RETENTION_MS = 30 * DAY;
export const DEVICE_RETENTION_AFTER_EXPIRY_MS = 30 * DAY;
export const ALERT_LOG_RETENTION_MS = DAY;
/** Rows per DELETE statement; each statement is its own short transaction. */
export const PURGE_BATCH = 500;
/** Upper bound on statements per table per pass; the next hour continues. */
const MAX_BATCHES = 200;

export interface PurgeCounts {
  submissions: number;
  devices: number;
  strikes: number;
  blocks: number;
  nonces: number;
  alertLog: number;
}

export function createPurgeJob(ctx: AppContext): Job {
  return {
    name: 'purge',
    intervalMs: PURGE_INTERVAL_MS,
    run: async () => {
      await runPurgePass(ctx);
    },
  };
}

/** Repeats a batched delete until a batch comes back short. */
async function inBatches(del: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await del();
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

/** Rows deleted by one statement. */
function count(res: { numDeletedRows: bigint }): number {
  return Number(res.numDeletedRows);
}

/** One purge pass. Exported for tests. */
export async function runPurgePass(ctx: AppContext): Promise<PurgeCounts> {
  const { db } = ctx;
  const now = ctx.clock.now();
  const submissionCutoff = new Date(now.getTime() - SUBMISSION_RETENTION_MS);
  const deviceCutoff = new Date(now.getTime() - DEVICE_RETENTION_AFTER_EXPIRY_MS);
  const alertCutoff = new Date(now.getTime() - ALERT_LOG_RETENTION_MS);

  // Postgres has no DELETE ... LIMIT, so each batch is DELETE ... WHERE key IN (SELECT key ... LIMIT n).
  const counts: PurgeCounts = {
    // Events go with their submission (ON DELETE CASCADE).
    submissions: await inBatches(async () =>
      count(
        await db
          .deleteFrom('submissions')
          .where(
            'id',
            'in',
            db
              .selectFrom('submissions')
              .select('id')
              .where('accepted_at', '<', submissionCutoff)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    // Registrations go with their device (ON DELETE CASCADE). A device with a submission left is kept.
    devices: await inBatches(async () =>
      count(
        await db
          .deleteFrom('devices')
          .where(
            'id',
            'in',
            db
              .selectFrom('devices')
              .select('devices.id')
              .where('token_expires_at', '<', deviceCutoff)
              .where(({ not, exists, selectFrom }) =>
                not(
                  exists(
                    selectFrom('submissions')
                      .select('submissions.id')
                      .whereRef('submissions.device_id', '=', 'devices.id'),
                  ),
                ),
              )
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    strikes: await inBatches(async () =>
      count(
        await db
          .deleteFrom('strikes')
          .where(
            'id',
            'in',
            db.selectFrom('strikes').select('id').where('expires_at', '<=', now).limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    // Manual blocks without an expiry stay until an operator removes them.
    blocks: await inBatches(async () =>
      count(
        await db
          .deleteFrom('blocks')
          .where(
            'id',
            'in',
            db
              .selectFrom('blocks')
              .select('id')
              .where('expires_at', 'is not', null)
              .where('expires_at', '<=', now)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    nonces: await inBatches(async () =>
      count(
        await db
          .deleteFrom('nonces')
          .where(
            'nonce',
            'in',
            db.selectFrom('nonces').select('nonce').where('expires_at', '<=', now).limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    alertLog: await inBatches(async () =>
      count(
        await db
          .deleteFrom('alert_log')
          .where(
            'code',
            'in',
            db
              .selectFrom('alert_log')
              .select('code')
              .where('last_sent_at', '<', alertCutoff)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
  };
  ctx.log.info({ deleted: counts }, 'purge pass complete');
  return counts;
}
