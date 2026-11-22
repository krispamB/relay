/**
 * Retention purge. sos-relay-PRD.md §10.5 and docs/auth-contract.md §8. Hourly, hard deletes, in small
 * batches so no pass holds a long lock. Logs counts only. Users are never deleted.
 *
 * Auth token families (the safe rule): a family is deleted only when it has no refresh_token rows
 * left, and only if it was revoked more than 7 days ago or created more than 7 days ago. Tokens are
 * removed first — those whose expires_at is more than 7 days ago, and every token of a family revoked
 * more than 7 days ago — so a family that still holds a token, including an unexpired one, is kept.
 * An empty family younger than 7 days and not revoked that long ago is kept too. The "created more
 * than 7 days ago and empty" clause is what removes a family whose newest token expired more than 7
 * days ago: that token is gone, and a 90-day token lifetime means the family is far older than 7 days.
 * A row exactly on a cutoff (7 days, 24 hours for sign-up records, 1 hour for sign-in attempts)
 * is kept; only older rows go.
 */

import { DAY, HOUR } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Job } from './runner.js';

export const PURGE_INTERVAL_MS = HOUR;
export const SUBMISSION_RETENTION_MS = 30 * DAY;
export const ALERT_LOG_RETENTION_MS = DAY;
/** Auth contract §8. Expired tokens, and tokens of a family revoked this long ago. */
export const AUTH_TOKEN_RETENTION_MS = 7 * DAY;
/** Auth contract §8. Sign-up idempotency rows and per-phone attempt rows. */
export const AUTH_SIGNUP_RETENTION_MS = DAY;
/** Sign-in attempts are only needed for the 1-hour per-phone limit (contract §6). */
export const AUTH_SIGNIN_ATTEMPT_RETENTION_MS = HOUR;
/** Rows per DELETE statement; each statement is its own short transaction. */
export const PURGE_BATCH = 500;
/** Upper bound on statements per table per pass; the next hour continues. */
const MAX_BATCHES = 200;

export interface PurgeCounts {
  submissions: number;
  strikes: number;
  blocks: number;
  alertLog: number;
  refreshTokens: number;
  tokenFamilies: number;
  signupIdempotency: number;
  signupPhoneAttempts: number;
  signinAttempts: number;
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
  const alertCutoff = new Date(now.getTime() - ALERT_LOG_RETENTION_MS);
  const tokenCutoff = new Date(now.getTime() - AUTH_TOKEN_RETENTION_MS);
  const signupCutoff = new Date(now.getTime() - AUTH_SIGNUP_RETENTION_MS);
  const signinCutoff = new Date(now.getTime() - AUTH_SIGNIN_ATTEMPT_RETENTION_MS);

  // Postgres has no DELETE ... LIMIT, so each batch is DELETE ... WHERE key IN (SELECT key ... LIMIT n).
  const counts: PurgeCounts = {
    // Events, recordings and units go with their submission (ON DELETE CASCADE).
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
    // Expired tokens first, then every token of a family revoked more than 7 days ago. A token that
    // matches both is counted once. Families are considered only after these deletes.
    refreshTokens:
      (await inBatches(async () =>
        count(
          await db
            .deleteFrom('refresh_tokens')
            .where(
              'id',
              'in',
              db
                .selectFrom('refresh_tokens')
                .select('id')
                .where('expires_at', '<', tokenCutoff)
                .limit(PURGE_BATCH),
            )
            .executeTakeFirst(),
        ),
      )) +
      (await inBatches(async () =>
        count(
          await db
            .deleteFrom('refresh_tokens')
            .where(
              'id',
              'in',
              db
                .selectFrom('refresh_tokens')
                .select('id')
                .where(
                  'family_id',
                  'in',
                  db
                    .selectFrom('token_families')
                    .select('id')
                    .where('revoked_at', 'is not', null)
                    .where('revoked_at', '<', tokenCutoff),
                )
                .limit(PURGE_BATCH),
            )
            .executeTakeFirst(),
        ),
      )),
    tokenFamilies: await inBatches(async () =>
      count(
        await db
          .deleteFrom('token_families')
          .where(
            'id',
            'in',
            db
              .selectFrom('token_families')
              .select('id')
              .where((eb) => eb.or([eb('revoked_at', '<', tokenCutoff), eb('created_at', '<', tokenCutoff)]))
              .where(({ not, exists, selectFrom }) =>
                not(
                  exists(
                    selectFrom('refresh_tokens')
                      .select('refresh_tokens.id')
                      .whereRef('refresh_tokens.family_id', '=', 'token_families.id'),
                  ),
                ),
              )
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    signupIdempotency: await inBatches(async () =>
      count(
        await db
          .deleteFrom('signup_idempotency')
          .where(
            'key',
            'in',
            db
              .selectFrom('signup_idempotency')
              .select('key')
              .where('created_at', '<', signupCutoff)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    signupPhoneAttempts: await inBatches(async () =>
      count(
        await db
          .deleteFrom('signup_phone_attempts')
          .where(
            'id',
            'in',
            db
              .selectFrom('signup_phone_attempts')
              .select('id')
              .where('created_at', '<', signupCutoff)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
    signinAttempts: await inBatches(async () =>
      count(
        await db
          .deleteFrom('signin_attempts')
          .where(
            'id',
            'in',
            db
              .selectFrom('signin_attempts')
              .select('id')
              .where('created_at', '<', signinCutoff)
              .limit(PURGE_BATCH),
          )
          .executeTakeFirst(),
      ),
    ),
  };
  ctx.log.info({ deleted: counts }, 'purge pass complete');
  return counts;
}
