/** Registration nonces (PRD §7.2): random, single use, five-minute life, stored in Postgres. */
import { addMs, MINUTE } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';

export const NONCE_TTL_MS = 5 * MINUTE;

/** randomToken(32) is 43 characters of URL-safe base64 without padding (Play Integrity's classic format). */
export const NONCE_PATTERN = '^[A-Za-z0-9_-]{43}$';

export interface IssuedNonce {
  nonce: string;
  expiresAt: Date;
}

export async function issueNonce(db: Db, now: Date): Promise<IssuedNonce> {
  const nonce = randomToken(32);
  const expiresAt = addMs(now, NONCE_TTL_MS);
  await db.insertInto('nonces').values({ nonce, expires_at: expiresAt, used_at: null }).execute();
  return { nonce, expiresAt };
}

/**
 * Marks the nonce used if it exists, is unexpired and unused, in one statement. Returns false
 * otherwise. Under concurrent calls with one nonce, Postgres row locking lets exactly one
 * UPDATE match: the loser re-evaluates `used_at IS NULL` after the winner commits.
 */
export async function consumeNonce(db: Db, nonce: string, now: Date): Promise<boolean> {
  const row = await db
    .updateTable('nonces')
    .set({ used_at: now })
    .where('nonce', '=', nonce)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning('nonce')
    .executeTakeFirst();
  return row !== undefined;
}
