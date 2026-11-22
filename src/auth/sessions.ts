import { randomUUID } from 'node:crypto';
import { addMs, DAY, MINUTE, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { Platform } from '../db/types.js';
import type { AuthKeys } from './keys.js';
import {
  deriveChildRefreshToken,
  isWellFormedRefreshToken,
  newRefreshToken,
  refreshTokenHash,
  signAccessToken,
} from './tokens.js';

/** Contract §3: access tokens live 15 minutes. */
export const ACCESS_TTL_MS = 15 * MINUTE;
/** Contract §3: refresh tokens live 90 days from their own issue, so each rotation slides the expiry. */
export const REFRESH_TTL_MS = 90 * DAY;
/** Contract §3.2: a rotated token presented again within 30 s (inclusive) gets the same pair back. */
export const GRACE_MS = 30 * SECOND;

/** The session object of contract §3.1. Times are RFC 3339 UTC without fractional seconds. */
export interface Session {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface DeviceInfo {
  platform: Platform;
  appVersion: string;
  installId: string;
}

export type RotateResult =
  | { kind: 'rotated'; session: Session; userId: string; familyId: string }
  /** A grace-window replay: byte-identical to the pair the original rotation returned. */
  | { kind: 'grace'; session: Session; userId: string; familyId: string }
  /** Reuse after the grace window. The family has been revoked in the same transaction. */
  | { kind: 'reuse_detected' }
  /** The token's family is revoked (sign-out, or an earlier reuse). */
  | { kind: 'revoked' }
  /** Unknown, malformed or expired. */
  | { kind: 'invalid' };

export type FamilyState = 'active' | 'revoked' | 'missing';

/** RFC 3339 in UTC without milliseconds, e.g. `2026-11-18T12:15:00Z`. */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Every stored token time is whole seconds, so a re-signed access token and the reported times match. */
function wholeSeconds(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

interface TokenRowForSession {
  id: string;
  family_id: string;
  user_id: string;
  expires_at: Date;
  access_iat: Date;
  access_exp: Date;
}

function sessionFor(keys: AuthKeys, row: TokenRowForSession, refreshToken: string): Session {
  return {
    accessToken: signAccessToken(keys.access, {
      sub: row.user_id,
      fam: row.family_id,
      jti: row.id,
      iat: row.access_iat,
      exp: row.access_exp,
    }),
    accessTokenExpiresAt: rfc3339(row.access_exp),
    refreshToken,
    refreshTokenExpiresAt: rfc3339(row.expires_at),
  };
}

/** Inserts a refresh-token row issued at `now` and returns the session for it. */
async function insertRefreshToken(
  db: Db,
  keys: AuthKeys,
  token: string,
  row: { familyId: string; userId: string; parentId: string | null; now: Date },
): Promise<Session> {
  const issued = wholeSeconds(row.now);
  const values = {
    id: randomUUID(),
    family_id: row.familyId,
    user_id: row.userId,
    parent_id: row.parentId,
    token_hash: refreshTokenHash(token),
    issued_at: issued,
    expires_at: addMs(issued, REFRESH_TTL_MS),
    access_iat: issued,
    access_exp: addMs(issued, ACCESS_TTL_MS),
  };
  await db.insertInto('refresh_tokens').values(values).execute();
  return sessionFor(keys, values, token);
}

/**
 * Starts a new token family with a random root refresh token. Pass the caller's transaction as `db`
 * when the session must commit or roll back together with other writes (sign-up does).
 */
export async function issueSession(
  db: Db,
  keys: AuthKeys,
  input: { userId: string; device: DeviceInfo; now: Date },
): Promise<{ familyId: string; session: Session }> {
  const familyId = randomUUID();
  await db
    .insertInto('token_families')
    .values({
      id: familyId,
      user_id: input.userId,
      install_id: input.device.installId,
      platform: input.device.platform,
      app_version: input.device.appVersion,
      created_at: input.now,
    })
    .execute();
  const session = await insertRefreshToken(db, keys, newRefreshToken(), {
    familyId,
    userId: input.userId,
    parentId: null,
    now: input.now,
  });
  return { familyId, session };
}

/**
 * Contract §3.2, in one transaction. The presented token's row is locked FOR UPDATE, then its family
 * row FOR UPDATE (always in that order, so concurrent refreshes and revocations cannot deadlock), so
 * concurrent rotations of one token serialise: the first rotates, the others find it rotated a moment
 * ago and replay the same pair.
 *
 * Order of checks:
 * 1. Malformed or unknown: `invalid`.
 * 2. Family revoked: `revoked`, even inside the grace window.
 * 3. Rotated within GRACE_MS (inclusive): re-derive the child, re-sign from its stored claims, and
 *    return the identical pair, with no write. This is checked before expiry, so a retry of a rotation
 *    made in the token's last seconds still gets its answer. But if the child has itself been rotated,
 *    the replay is not a lost response (the client got and used the child), so it is treated as reuse.
 * 4. Expired: `invalid`. Expiry wins over reuse: a token past its 90 days revokes nothing.
 * 5. Rotated longer ago: reuse. Revoke the family and answer `reuse_detected`.
 * 6. Otherwise: rotate, giving the child a fresh REFRESH_TTL_MS.
 */
export async function rotateRefreshToken(
  ctx: Pick<AppContext, 'db' | 'clock'>,
  keys: AuthKeys,
  presented: string,
): Promise<RotateResult> {
  if (!isWellFormedRefreshToken(presented)) return { kind: 'invalid' };
  const now = ctx.clock.now();

  return ctx.db.transaction().execute(async (trx): Promise<RotateResult> => {
    const token = await trx
      .selectFrom('refresh_tokens')
      .select(['id', 'family_id', 'user_id', 'expires_at', 'rotated_at'])
      .where('token_hash', '=', refreshTokenHash(presented))
      .forUpdate()
      .executeTakeFirst();
    if (!token) return { kind: 'invalid' };

    const family = await trx
      .selectFrom('token_families')
      .select('revoked_at')
      .where('id', '=', token.family_id)
      .forUpdate()
      .executeTakeFirst();
    if (!family) return { kind: 'invalid' };
    if (family.revoked_at) return { kind: 'revoked' };

    const owner = { userId: token.user_id, familyId: token.family_id };

    if (token.rotated_at && now.getTime() - token.rotated_at.getTime() <= GRACE_MS) {
      const childToken = deriveChildRefreshToken(keys.refresh, presented);
      const child = await trx
        .selectFrom('refresh_tokens')
        .select(['id', 'family_id', 'user_id', 'expires_at', 'access_iat', 'access_exp', 'rotated_at'])
        .where('token_hash', '=', refreshTokenHash(childToken))
        .executeTakeFirst();
      if (!child) return { kind: 'invalid' };
      if (child.rotated_at === null) {
        return { kind: 'grace', session: sessionFor(keys, child, childToken), ...owner };
      }
      // Falls through to reuse below.
    } else if (now.getTime() >= token.expires_at.getTime()) {
      return { kind: 'invalid' };
    }

    if (token.rotated_at) {
      await revokeFamily(trx, token.family_id, now);
      return { kind: 'reuse_detected' };
    }

    const childToken = deriveChildRefreshToken(keys.refresh, presented);
    const session = await insertRefreshToken(trx, keys, childToken, { ...owner, parentId: token.id, now });
    await trx.updateTable('refresh_tokens').set({ rotated_at: now }).where('id', '=', token.id).execute();
    return { kind: 'rotated', session, ...owner };
  });
}

/**
 * Every revocation of a family (revoked_at set, or the row deleted) is announced on this channel with
 * the family id, by a trigger on token_families (migration 008), inside the revoking transaction. The
 * live socket listens on it and closes that session's sockets on every instance.
 */
export const SESSION_REVOKED_CHANNEL = 'session_revoked';

/**
 * Revokes a family. Idempotent: returns true only for the call that revoked it, and keeps that time.
 * The trigger announces it on SESSION_REVOKED_CHANNEL when the caller's transaction commits.
 */
export async function revokeFamily(db: Db, familyId: string, now: Date): Promise<boolean> {
  const r = await db
    .updateTable('token_families')
    .set({ revoked_at: now })
    .where('id', '=', familyId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}

/** `missing` means the family is gone: its user was deleted, or it was purged. */
export async function familyState(db: Db, familyId: string): Promise<FamilyState> {
  const row = await db
    .selectFrom('token_families')
    .select('revoked_at')
    .where('id', '=', familyId)
    .executeTakeFirst();
  if (!row) return 'missing';
  return row.revoked_at ? 'revoked' : 'active';
}

/** Who a refresh token belongs to, whatever its expiry, rotation or revocation. For sign-out. */
export async function findRefreshTokenOwner(
  db: Db,
  presented: string,
): Promise<{ familyId: string; userId: string } | undefined> {
  if (!isWellFormedRefreshToken(presented)) return undefined;
  const row = await db
    .selectFrom('refresh_tokens')
    .select(['family_id', 'user_id'])
    .where('token_hash', '=', refreshTokenHash(presented))
    .executeTakeFirst();
  return row && { familyId: row.family_id, userId: row.user_id };
}
