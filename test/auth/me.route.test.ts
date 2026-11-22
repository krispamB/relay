import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { issueSession, revokeFamily } from '../../src/auth/sessions.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { FakeClock } from '../../src/clock.js';
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
  platform: 'android' as const,
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
      // Above the per-user cap, so a 429 here is the user limit and not the relay's per-IP limit.
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

function getMe(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('GET /v1/me', () => {
  it('returns the signed-in user', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { session } = await issue(ctx, 'user-1');

    const res = await getMe(app, `Bearer ${session.accessToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: {
        id: 'user-1',
        fullName: 'Ada Okafor',
        phone: '+2348000000001',
        phoneVerified: false,
        createdAt: '2026-11-18T12:00:00Z',
      },
    });
  });

  it('answers token_expired for an access token past its exp, not invalid_token', async () => {
    const { app, ctx, clock } = await setup();
    await insertUser('user-1');
    const { session } = await issue(ctx, 'user-1');
    clock.advanceMinutes(15);

    const res = await getMe(app, `Bearer ${session.accessToken}`);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'token_expired', message: 'The access token has expired.' },
    });
  });

  it.each([
    ['forged', (token: string) => `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`],
    ['garbage', () => 'not-a-token'],
    [
      'wrong-key',
      () =>
        signAccessToken(deriveAuthKeys('another-auth-secret-0123456789abcdef').access, {
          sub: 'user-1',
          fam: 'fam',
          jti: 'jti',
          iat: new Date(START),
          exp: new Date('2026-11-18T12:15:00.000Z'),
        }),
    ],
  ])('answers invalid_token for a %s access token', async (_label, tokenFor) => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { session } = await issue(ctx, 'user-1');

    const res = await getMe(app, `Bearer ${tokenFor(session.accessToken)}`);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'invalid_token', message: 'The access token is not valid.' },
    });
  });

  it('answers invalid_token when the header is missing or blank', async () => {
    const { app } = await setup();
    for (const authorization of [undefined, 'Bearer', 'Bearer ']) {
      const res = await getMe(app, authorization);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_token');
    }
  });

  it('answers session_revoked when the family is revoked', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { familyId, session } = await issue(ctx, 'user-1');
    await revokeFamily(ctx.db, familyId, ctx.clock.now());

    const res = await getMe(app, `Bearer ${session.accessToken}`);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'session_revoked', message: 'This session has ended.' },
    });
  });

  it('answers session_revoked when the user has been deleted', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    const { session } = await issue(ctx, 'user-1');
    await ctx.db.deleteFrom('users').where('id', '=', 'user-1').execute();

    const res = await getMe(app, `Bearer ${session.accessToken}`);

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('session_revoked');
  });

  it('answers 429 on the 121st request in the minute, and a second user is unaffected', async () => {
    const { app, ctx } = await setup();
    await insertUser('user-1');
    await insertUser('user-2');
    const first = await issue(ctx, 'user-1');
    const second = await issue(ctx, 'user-2');

    for (let i = 0; i < 120; i++) {
      const ok = await getMe(app, `Bearer ${first.session.accessToken}`);
      expect(ok.statusCode).toBe(200);
    }

    const limited = await getMe(app, `Bearer ${first.session.accessToken}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 60 },
    });

    const other = await getMe(app, `Bearer ${second.session.accessToken}`);
    expect(other.statusCode).toBe(200);
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
    const op = doc.paths['/v1/me']?.get;
    expect(op?.tags).toEqual(['auth']);
    expect(op?.security).toEqual([{ accessToken: [] }]);
    expect(op?.summary).toEqual(expect.any(String));
    expect(op?.responses).toMatchObject({
      200: expect.any(Object),
      401: expect.any(Object),
      429: expect.any(Object),
    });
  });
});
