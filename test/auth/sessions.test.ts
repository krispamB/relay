import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import {
  ACCESS_TTL_MS,
  familyState,
  findRefreshTokenOwner,
  GRACE_MS,
  issueSession,
  REFRESH_TTL_MS,
  revokeFamily,
  rotateRefreshToken,
  type Session,
} from '../../src/auth/sessions.js';
import {
  deriveChildRefreshToken,
  newRefreshToken,
  refreshTokenHash,
  verifyAccessToken,
} from '../../src/auth/tokens.js';
import { DAY, FakeClock } from '../../src/clock.js';
import { closeTestDb, createTestContext, resetDb, type TestContext, testDb } from '../helpers/context.js';

const START = '2026-11-18T12:00:00.000Z';
const device = {
  platform: 'android',
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
} as const;

let ctx: TestContext;
const keys = deriveAuthKeys('auth-token-secret-for-tests-0123456789ab');

async function insertUser(id = 'user-1') {
  const now = new Date(START);
  await testDb()
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone: `+23480${id.length}${id.charCodeAt(id.length - 1)}12345`,
      email: `${id}@example.com`,
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function count(table: 'token_families' | 'refresh_tokens'): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(testDb());
  return Number(r.rows[0]?.n);
}

async function tokenRow(token: string) {
  return testDb()
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', refreshTokenHash(token))
    .executeTakeFirstOrThrow();
}

async function issue(userId = 'user-1') {
  return issueSession(ctx.db, keys, { userId, device, now: ctx.clock.now() });
}

async function rotated(token: string): Promise<{ session: Session; userId: string; familyId: string }> {
  const r = await rotateRefreshToken(ctx, keys, token);
  if (r.kind !== 'rotated') throw new Error(`expected rotated, got ${r.kind}`);
  return r;
}

describe('auth sessions', () => {
  beforeEach(async () => {
    await resetDb();
    ctx = createTestContext({ clock: new FakeClock(START) });
    await insertUser();
  });
  afterAll(() => closeTestDb());

  describe('issueSession', () => {
    it('creates a family and a root refresh token, and returns the contract session', async () => {
      const { familyId, session } = await issue();

      expect(session).toEqual({
        accessToken: expect.any(String),
        accessTokenExpiresAt: '2026-11-18T12:15:00Z',
        refreshToken: expect.stringMatching(/^rt_[A-Za-z0-9_-]{43}$/),
        refreshTokenExpiresAt: '2027-02-16T12:00:00Z',
      });

      const family = await testDb()
        .selectFrom('token_families')
        .selectAll()
        .where('id', '=', familyId)
        .executeTakeFirstOrThrow();
      expect(family).toMatchObject({
        user_id: 'user-1',
        platform: 'android',
        app_version: '0.3.0',
        install_id: device.installId,
        created_at: new Date(START),
        revoked_at: null,
      });

      const row = await tokenRow(session.refreshToken);
      expect(row).toMatchObject({
        family_id: familyId,
        user_id: 'user-1',
        parent_id: null,
        rotated_at: null,
        issued_at: new Date(START),
        expires_at: new Date('2027-02-16T12:00:00Z'),
        access_iat: new Date(START),
        access_exp: new Date('2026-11-18T12:15:00Z'),
      });

      const check = verifyAccessToken(keys.access, session.accessToken, ctx.clock.now());
      expect(check).toEqual({
        kind: 'valid',
        claims: {
          sub: 'user-1',
          fam: familyId,
          jti: row.id,
          iat: new Date(START),
          exp: new Date('2026-11-18T12:15:00Z'),
        },
      });
    });

    it('stores and reports times in whole seconds', async () => {
      ctx.clock.set('2026-11-18T12:00:00.750Z');
      const { session } = await issue();
      expect(session.accessTokenExpiresAt).toBe('2026-11-18T12:15:00Z');
      expect(session.refreshTokenExpiresAt).toBe('2027-02-16T12:00:00Z');
      const row = await tokenRow(session.refreshToken);
      for (const d of [row.issued_at, row.expires_at, row.access_iat, row.access_exp]) {
        expect(d.getTime() % 1000).toBe(0);
      }
    });

    it('starts a new family for every session', async () => {
      const a = await issue();
      const b = await issue();
      expect(a.familyId).not.toBe(b.familyId);
      expect(a.session.refreshToken).not.toBe(b.session.refreshToken);
      expect(await count('token_families')).toBe(2);
    });

    it('leaves nothing behind when the caller rolls its transaction back', async () => {
      const failure = await ctx.db
        .transaction()
        .execute(async (trx) => {
          await issueSession(trx, keys, { userId: 'user-1', device, now: ctx.clock.now() });
          expect(await trx.selectFrom('refresh_tokens').select('id').execute()).toHaveLength(1);
          throw new Error('roll back');
        })
        .catch((e: Error) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(await count('token_families')).toBe(0);
      expect(await count('refresh_tokens')).toBe(0);
    });
  });

  describe('rotateRefreshToken', () => {
    it('consumes the token and issues a derived child with a fresh access token', async () => {
      const { familyId, session } = await issue();
      ctx.clock.advanceMinutes(20);

      const r = await rotated(session.refreshToken);

      expect(r.userId).toBe('user-1');
      expect(r.familyId).toBe(familyId);
      expect(r.session.refreshToken).toBe(deriveChildRefreshToken(keys.refresh, session.refreshToken));
      expect(r.session.accessTokenExpiresAt).toBe('2026-11-18T12:35:00Z');

      const parent = await tokenRow(session.refreshToken);
      const child = await tokenRow(r.session.refreshToken);
      expect(parent.rotated_at).toEqual(ctx.clock.now());
      expect(child).toMatchObject({
        parent_id: parent.id,
        family_id: familyId,
        user_id: 'user-1',
        rotated_at: null,
      });

      const check = verifyAccessToken(keys.access, r.session.accessToken, ctx.clock.now());
      expect(check.kind).toBe('valid');
      if (check.kind === 'valid')
        expect(check.claims).toMatchObject({ sub: 'user-1', fam: familyId, jti: child.id });
    });

    it('slides the refresh expiry: the child gets a fresh 90 days', async () => {
      const { session } = await issue();
      ctx.clock.advance(60 * DAY);
      const r = await rotated(session.refreshToken);
      expect(r.session.refreshTokenExpiresAt).toBe('2027-04-17T12:00:00Z');
      expect((await tokenRow(r.session.refreshToken)).expires_at).toEqual(
        new Date(ctx.clock.now().getTime() + REFRESH_TTL_MS),
      );
      // And the chain keeps going past the first token's 90 days.
      ctx.clock.advance(60 * DAY);
      const again = await rotated(r.session.refreshToken);
      expect(again.session.refreshTokenExpiresAt).toBe('2027-06-16T12:00:00Z');
    });

    it('rotates a token one second before it expires', async () => {
      const { session } = await issue();
      ctx.clock.advance(REFRESH_TTL_MS - 1000);
      await rotated(session.refreshToken);
    });

    it('answers invalid for an expired refresh token, at and after its expiry', async () => {
      const { session } = await issue();
      ctx.clock.advance(REFRESH_TTL_MS);
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'invalid' });
      ctx.clock.advance(DAY);
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'invalid' });
      expect(await count('refresh_tokens')).toBe(1);
      expect((await tokenRow(session.refreshToken)).rotated_at).toBeNull();
    });

    it('answers invalid for an unknown or malformed token', async () => {
      await issue();
      for (const token of [
        newRefreshToken(),
        '',
        'rt_',
        'garbage',
        `rt_${'A'.repeat(42)}`,
        'x'.repeat(5000),
      ]) {
        expect(await rotateRefreshToken(ctx, keys, token), token).toEqual({ kind: 'invalid' });
      }
    });

    it('replays the identical pair within the grace window, at 29 s and at exactly 30 s', async () => {
      const { familyId, session } = await issue();
      ctx.clock.advanceMinutes(20);
      const first = await rotated(session.refreshToken);
      const childBefore = await tokenRow(first.session.refreshToken);

      ctx.clock.advanceSeconds(29);
      const replay = await rotateRefreshToken(ctx, keys, session.refreshToken);
      expect(replay).toEqual({ kind: 'grace', session: first.session, userId: 'user-1', familyId });

      ctx.clock.advanceSeconds(1);
      expect(GRACE_MS).toBe(30_000);
      const edge = await rotateRefreshToken(ctx, keys, session.refreshToken);
      expect(edge).toEqual({ kind: 'grace', session: first.session, userId: 'user-1', familyId });

      // Nothing was extended or added.
      expect(await count('refresh_tokens')).toBe(2);
      expect(await tokenRow(first.session.refreshToken)).toEqual(childBefore);
    });

    it('treats reuse after the grace window as theft: revokes the family, and the child stops working', async () => {
      const { familyId, session } = await issue();
      const first = await rotated(session.refreshToken);

      ctx.clock.advanceSeconds(31);
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'reuse_detected' });
      expect(await familyState(ctx.db, familyId)).toBe('revoked');

      expect(await rotateRefreshToken(ctx, keys, first.session.refreshToken)).toEqual({ kind: 'revoked' });
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'revoked' });
      expect(await count('refresh_tokens')).toBe(2);
    });

    it('revokes the whole chain when an older ancestor is reused', async () => {
      const { familyId, session: root } = await issue();
      const c1 = await rotated(root.refreshToken);
      ctx.clock.advanceMinutes(20);
      const c2 = await rotated(c1.session.refreshToken);
      ctx.clock.advanceMinutes(20);

      expect(await rotateRefreshToken(ctx, keys, root.refreshToken)).toEqual({ kind: 'reuse_detected' });
      expect(await familyState(ctx.db, familyId)).toBe('revoked');
      for (const token of [c1.session.refreshToken, c2.session.refreshToken]) {
        expect(await rotateRefreshToken(ctx, keys, token)).toEqual({ kind: 'revoked' });
      }
    });

    it('does not apply the grace window once the child has itself been rotated', async () => {
      const { familyId, session: root } = await issue();
      const c1 = await rotated(root.refreshToken);
      ctx.clock.advanceSeconds(10);
      await rotated(c1.session.refreshToken);
      ctx.clock.advanceSeconds(10);

      // Root was rotated 20 s ago, but its child is already consumed: someone else holds the chain.
      expect(await rotateRefreshToken(ctx, keys, root.refreshToken)).toEqual({ kind: 'reuse_detected' });
      expect(await familyState(ctx.db, familyId)).toBe('revoked');
    });

    it('answers revoked for any token of a revoked family, without rotating it', async () => {
      const { familyId, session } = await issue();
      await revokeFamily(ctx.db, familyId, ctx.clock.now());
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'revoked' });
      expect(await count('refresh_tokens')).toBe(1);
      expect((await tokenRow(session.refreshToken)).rotated_at).toBeNull();
    });

    it('answers revoked, not grace, for a replay within the window after the family was revoked', async () => {
      const { familyId, session } = await issue();
      await rotated(session.refreshToken);
      ctx.clock.advanceSeconds(5);
      await revokeFamily(ctx.db, familyId, ctx.clock.now());
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({ kind: 'revoked' });
    });

    it('still replays within the grace window if the parent expired in the meantime', async () => {
      const { familyId, session } = await issue();
      ctx.clock.advance(REFRESH_TTL_MS - 10_000);
      const first = await rotated(session.refreshToken);
      ctx.clock.advanceSeconds(20); // the parent is now past its expiry, but rotated 20 s ago
      expect(await rotateRefreshToken(ctx, keys, session.refreshToken)).toEqual({
        kind: 'grace',
        session: first.session,
        userId: 'user-1',
        familyId,
      });
    });

    it('lets concurrent rotations of one token both succeed with the same pair and one child', async () => {
      const { session } = await issue();
      ctx.clock.advanceMinutes(20);

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => rotateRefreshToken(ctx, keys, session.refreshToken)),
      );

      expect(results.filter((r) => r.kind === 'rotated')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'grace')).toHaveLength(3);
      const sessions = results.map((r) =>
        r.kind === 'rotated' || r.kind === 'grace' ? r.session : undefined,
      );
      for (const s of sessions) expect(s).toEqual(sessions[0]);
      expect(await count('refresh_tokens')).toBe(2);
    });

    it('re-signs a byte-identical access token on replay even when issued at a sub-second instant', async () => {
      const { session } = await issue();
      ctx.clock.set('2026-11-18T12:20:00.999Z');
      const first = await rotated(session.refreshToken);
      ctx.clock.advance(1);
      const replay = await rotateRefreshToken(ctx, keys, session.refreshToken);
      expect(replay.kind).toBe('grace');
      if (replay.kind === 'grace') expect(replay.session.accessToken).toBe(first.session.accessToken);
      expect(first.session.accessTokenExpiresAt).toBe('2026-11-18T12:35:00Z');
      expect(ACCESS_TTL_MS).toBe(15 * 60_000);
    });
  });

  describe('revokeFamily and familyState', () => {
    it('reports active, revoked and missing', async () => {
      const { familyId } = await issue();
      expect(await familyState(ctx.db, familyId)).toBe('active');
      await revokeFamily(ctx.db, familyId, ctx.clock.now());
      expect(await familyState(ctx.db, familyId)).toBe('revoked');
      expect(await familyState(ctx.db, 'no-such-family')).toBe('missing');
    });

    it('is idempotent and keeps the first revocation time', async () => {
      const { familyId } = await issue();
      const first = ctx.clock.now();
      expect(await revokeFamily(ctx.db, familyId, first)).toBe(true);
      ctx.clock.advanceMinutes(5);
      expect(await revokeFamily(ctx.db, familyId, ctx.clock.now())).toBe(false);
      expect(await revokeFamily(ctx.db, 'no-such-family', ctx.clock.now())).toBe(false);
      const row = await testDb()
        .selectFrom('token_families')
        .select('revoked_at')
        .where('id', '=', familyId)
        .executeTakeFirstOrThrow();
      expect(row.revoked_at).toEqual(first);
    });

    it('revokes only the given family', async () => {
      const a = await issue();
      const b = await issue();
      await revokeFamily(ctx.db, a.familyId, ctx.clock.now());
      expect(await familyState(ctx.db, b.familyId)).toBe('active');
      await rotated(b.session.refreshToken);
    });

    it('reports missing once the user is deleted', async () => {
      const { familyId } = await issue();
      await testDb().deleteFrom('users').where('id', '=', 'user-1').execute();
      expect(await familyState(ctx.db, familyId)).toBe('missing');
    });
  });

  describe('findRefreshTokenOwner', () => {
    it('finds the family and user of a token, whatever its state', async () => {
      const { familyId, session } = await issue();
      const expected = { familyId, userId: 'user-1' };
      expect(await findRefreshTokenOwner(ctx.db, session.refreshToken)).toEqual(expected);

      const child = await rotated(session.refreshToken);
      expect(await findRefreshTokenOwner(ctx.db, session.refreshToken)).toEqual(expected);
      expect(await findRefreshTokenOwner(ctx.db, child.session.refreshToken)).toEqual(expected);

      await revokeFamily(ctx.db, familyId, ctx.clock.now());
      ctx.clock.advance(REFRESH_TTL_MS + DAY);
      expect(await findRefreshTokenOwner(ctx.db, child.session.refreshToken)).toEqual(expected);
    });

    it('returns undefined for an unknown or malformed token', async () => {
      await issue();
      for (const token of [newRefreshToken(), '', 'garbage']) {
        expect(await findRefreshTokenOwner(ctx.db, token)).toBeUndefined();
      }
    });

    it('tells users apart', async () => {
      await insertUser('user-2');
      const a = await issue('user-1');
      const b = await issue('user-2');
      expect((await findRefreshTokenOwner(ctx.db, a.session.refreshToken))?.userId).toBe('user-1');
      expect((await findRefreshTokenOwner(ctx.db, b.session.refreshToken))?.userId).toBe('user-2');
    });
  });
});
