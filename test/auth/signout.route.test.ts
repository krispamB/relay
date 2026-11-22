import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { familyState, issueSession, REFRESH_TTL_MS } from '../../src/auth/sessions.js';
import { newRefreshToken, signAccessToken } from '../../src/auth/tokens.js';
import { DAY, FakeClock } from '../../src/clock.js';
import {
  closeTestDb,
  createTestContext,
  resetDb,
  type TestContext,
  testConfig,
  testDb,
} from '../helpers/context.js';

const START = '2026-11-18T12:00:00.000Z';
const SECRET = 'auth-token-secret-for-tests-0123456789ab';
const keys = deriveAuthKeys(SECRET);
const device = {
  platform: 'ios' as const,
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
};

let seq = 0;
const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});
afterAll(() => closeTestDb());

async function setup() {
  await resetDb();
  seq = 0;
  const base = testConfig();
  const clock = new FakeClock(START);
  const ctx = createTestContext({
    clock,
    config: {
      ...base,
      auth: { enabled: true, tokenSecret: SECRET },
      limits: { ...base.limits, requestsPerIpPerMinute: 10_000 },
    },
  });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { app, ctx, clock };
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

async function issue(ctx: TestContext, userId: string) {
  return issueSession(ctx.db, keys, { userId, device, now: ctx.clock.now() });
}

function postSignout(app: FastifyInstance, authorization: string | undefined, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    payload: JSON.stringify(body),
  });
}

describe('POST /v1/auth/signout', () => {
  it('returns 204 and revokes the refresh token family', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');

    const res = await postSignout(app, `Bearer ${session.accessToken}`, {
      refreshToken: session.refreshToken,
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await familyState(ctx.db, familyId)).toBe('revoked');
  });

  it('revokes the family when the access token expired 10 days ago', async () => {
    const { app, ctx, clock } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');
    clock.advance(10 * DAY);

    const res = await postSignout(app, `Bearer ${session.accessToken}`, {
      refreshToken: session.refreshToken,
    });

    expect(res.statusCode).toBe(204);
    expect(await familyState(ctx.db, familyId)).toBe('revoked');
  });

  it('is idempotent: a second call is still 204', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');
    const body = { refreshToken: session.refreshToken };
    const header = `Bearer ${session.accessToken}`;

    expect((await postSignout(app, header, body)).statusCode).toBe(204);
    expect((await postSignout(app, header, body)).statusCode).toBe(204);
    expect(await familyState(ctx.db, familyId)).toBe('revoked');
  });

  it('returns 204 and leaves another user family active', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-a');
    await insertUser('user-b');
    const mine = await issue(ctx, 'user-a');
    const theirs = await issue(ctx, 'user-b');

    const res = await postSignout(app, `Bearer ${mine.session.accessToken}`, {
      refreshToken: theirs.session.refreshToken,
    });

    expect(res.statusCode).toBe(204);
    expect(await familyState(ctx.db, mine.familyId)).toBe('active');
    expect(await familyState(ctx.db, theirs.familyId)).toBe('active');
  });

  it('returns 204 for an unknown refresh token and revokes nothing', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');

    const res = await postSignout(app, `Bearer ${session.accessToken}`, { refreshToken: newRefreshToken() });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await familyState(ctx.db, familyId)).toBe('active');
  });

  it('returns 400 validation_failed when refreshToken is missing', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { session } = await issue(ctx, 'user-1');

    const res = await postSignout(app, `Bearer ${session.accessToken}`, {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: 'Some fields are invalid.',
        fields: [{ field: 'refreshToken', code: 'required' }],
      },
    });
  });

  it('returns 401 invalid_token for a forged access token and revokes nothing', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');
    const forged = signAccessToken(deriveAuthKeys('another-auth-secret-0123456789abcdef').access, {
      sub: 'user-1',
      fam: familyId,
      jti: 'jti',
      iat: new Date(START),
      exp: new Date('2026-11-18T12:15:00.000Z'),
    });

    const res = await postSignout(app, `Bearer ${forged}`, { refreshToken: session.refreshToken });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'invalid_token', message: 'The access token is not valid.' },
    });
    expect(await familyState(ctx.db, familyId)).toBe('active');
  });

  it('still revokes the refresh family when the access token family is already revoked', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const access = await issue(ctx, 'user-1');
    const refresh = await issue(ctx, 'user-1');
    await ctx.db
      .updateTable('token_families')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', access.familyId)
      .execute();

    const res = await postSignout(app, `Bearer ${access.session.accessToken}`, {
      refreshToken: refresh.session.refreshToken,
    });

    expect(res.statusCode).toBe(204);
    expect(await familyState(ctx.db, refresh.familyId)).toBe('revoked');
  });

  it('does not revoke a family whose refresh token has expired', async () => {
    const { app, ctx, clock } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');
    clock.advance(REFRESH_TTL_MS);

    const res = await postSignout(app, `Bearer ${session.accessToken}`, {
      refreshToken: session.refreshToken,
    });

    expect(res.statusCode).toBe(204);
    expect(await familyState(ctx.db, familyId)).toBe('active');
  });

  it('is documented under the auth tag with the accessToken scheme', async () => {
    const { app } = await setup();
    await app.ready();
    const doc = app.swagger() as {
      paths: Record<
        string,
        Record<string, { tags?: string[]; security?: unknown[]; summary?: string; responses?: object }>
      >;
    };
    const op = doc.paths['/v1/auth/signout']?.post;
    expect(op?.tags).toEqual(['auth']);
    expect(op?.security).toEqual([{ accessToken: [] }]);
    expect(op?.summary).toEqual(expect.any(String));
    expect(op?.responses).toMatchObject({
      204: expect.any(Object),
      400: expect.any(Object),
      401: expect.any(Object),
      429: expect.any(Object),
    });
  });
});

describe('per-user limit and stale access tokens', () => {
  it('sign-outs with an old access token do not spend the live session budget', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const old = await issue(ctx, 'user-1');
    await postSignout(app, `Bearer ${old.session.accessToken}`, { refreshToken: old.session.refreshToken });
    const live = await issue(ctx, 'user-1');

    for (let i = 0; i < 125; i++) {
      await postSignout(app, `Bearer ${old.session.accessToken}`, { refreshToken: newRefreshToken() });
    }
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${live.session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });
});
