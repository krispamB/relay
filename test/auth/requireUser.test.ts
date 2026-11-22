import type { FastifyRequest } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { authenticate, requireUser } from '../../src/auth/requireUser.js';
import { issueSession } from '../../src/auth/sessions.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { FakeClock, MINUTE } from '../../src/clock.js';
import { silentLogger } from '../../src/logger.js';
import { closeTestDb, createTestContext, resetDb, type TestContext, testDb } from '../helpers/context.js';

const START = '2026-11-18T12:00:00.000Z';
const keys = deriveAuthKeys('auth-token-secret-for-tests-0123456789ab');
const device = {
  platform: 'android' as const,
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
};

let ctx: TestContext;
let seq = 0;

function request(authorization?: string): FastifyRequest {
  const headers: FastifyRequest['headers'] = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return { headers, log: silentLogger() } as unknown as FastifyRequest;
}

async function insertUser(id: string) {
  seq += 1;
  const now = new Date(START);
  await testDb()
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone: `+2348${String(seq).padStart(9, '0')}`,
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function issue(userId: string) {
  return issueSession(ctx.db, keys, { userId, device, now: ctx.clock.now() });
}

describe('requireUser / authenticate', () => {
  beforeEach(async () => {
    await resetDb();
    ctx = createTestContext({ clock: new FakeClock(START) });
    await insertUser('user-1');
  });
  afterAll(() => closeTestDb());

  it('returns the access token claims when the family is active and belongs to the user', async () => {
    const { familyId, session } = await issue('user-1');
    const row = await testDb()
      .selectFrom('refresh_tokens')
      .select('id')
      .where('family_id', '=', familyId)
      .executeTakeFirstOrThrow();

    await expect(requireUser(ctx, keys, request(`Bearer ${session.accessToken}`))).resolves.toEqual({
      userId: 'user-1',
      familyId,
      jti: row.id,
      expiresAt: new Date(session.accessTokenExpiresAt),
    });
  });

  it('rejects a missing or blank bearer as invalid_token', async () => {
    for (const header of [undefined, 'Bearer', 'Bearer ', 'Bearer    ']) {
      await expect(requireUser(ctx, keys, request(header))).rejects.toMatchObject({
        status: 401,
        code: 'invalid_token',
      });
    }
  });

  it('rejects a token signed by another key, and distinguishes expiry from a bad signature', async () => {
    const { session } = await issue('user-1');
    const other = deriveAuthKeys('another-auth-secret-0123456789abcdef');
    const forged = signAccessToken(other.access, {
      sub: 'user-1',
      fam: '00000000-0000-4000-8000-000000000001',
      jti: '00000000-0000-4000-8000-000000000002',
      iat: new Date(START),
      exp: new Date('2026-11-18T12:15:00.000Z'),
    });

    await expect(requireUser(ctx, keys, request(`Bearer ${forged}`))).rejects.toMatchObject({
      code: 'invalid_token',
    });
    await expect(requireUser(ctx, keys, request('Bearer not-a-token'))).rejects.toMatchObject({
      code: 'invalid_token',
    });

    ctx.clock.advanceMinutes(15);
    await expect(requireUser(ctx, keys, request(`Bearer ${session.accessToken}`))).rejects.toMatchObject({
      status: 401,
      code: 'token_expired',
    });
    await expect(
      authenticate(ctx, keys, request(`Bearer ${session.accessToken}`), { allowExpired: true }),
    ).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('answers session_revoked when the family is revoked or the user has been deleted', async () => {
    const revoked = await issue('user-1');
    await ctx.db
      .updateTable('token_families')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', revoked.familyId)
      .execute();
    await expect(
      requireUser(ctx, keys, request(`Bearer ${revoked.session.accessToken}`)),
    ).rejects.toMatchObject({ code: 'session_revoked' });

    const gone = await issue('user-1');
    await ctx.db.deleteFrom('users').where('id', '=', 'user-1').execute();
    await expect(requireUser(ctx, keys, request(`Bearer ${gone.session.accessToken}`))).rejects.toMatchObject(
      {
        code: 'session_revoked',
      },
    );
  });

  it('answers invalid_token when the family belongs to a different user', async () => {
    await insertUser('user-2');
    const { familyId, session } = await issue('user-1');
    await ctx.db
      .updateTable('token_families')
      .set({ user_id: 'user-2' })
      .where('id', '=', familyId)
      .execute();

    await expect(requireUser(ctx, keys, request(`Bearer ${session.accessToken}`))).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('does not consult the family when checkFamily is false', async () => {
    const { familyId, session } = await issue('user-1');
    await ctx.db
      .updateTable('token_families')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', familyId)
      .execute();

    await expect(
      authenticate(ctx, keys, request(`Bearer ${session.accessToken}`), {
        allowExpired: true,
        checkFamily: false,
      }),
    ).resolves.toMatchObject({ userId: 'user-1', familyId });
  });

  it('allows 120 authenticated requests per user per minute, then 429, without spending a failed attempt', async () => {
    const { session } = await issue('user-1');
    const req = request(`Bearer ${session.accessToken}`);
    for (let i = 0; i < 5; i++) {
      await expect(requireUser(ctx, keys, request('Bearer nope'))).rejects.toMatchObject({
        code: 'invalid_token',
      });
    }
    for (let i = 0; i < 120; i++) await requireUser(ctx, keys, req);

    await expect(requireUser(ctx, keys, req)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 60,
    });

    await insertUser('user-2');
    const other = await issue('user-2');
    await expect(
      requireUser(ctx, keys, request(`Bearer ${other.session.accessToken}`)),
    ).resolves.toMatchObject({
      userId: 'user-2',
    });

    ctx.clock.advance(MINUTE);
    await expect(requireUser(ctx, keys, req)).resolves.toMatchObject({ userId: 'user-1' });
  });
});
