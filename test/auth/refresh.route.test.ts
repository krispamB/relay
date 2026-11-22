/**
 * POST /v1/auth/refresh over HTTP (docs/auth-contract.md §3.2, §4.2, §5), against real Postgres.
 *
 * Users and sessions are created directly (a users insert + issueSession), since this file must not
 * depend on the sign-up route. The rotation rules themselves are covered in sessions.test.ts; this file
 * covers the route: status codes, bodies, the per-family limit and logging.
 */
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { issueSession, revokeFamily, type Session } from '../../src/auth/sessions.js';
import { newRefreshToken, verifyAccessToken } from '../../src/auth/tokens.js';
import { DAY, FakeClock, HOUR } from '../../src/clock.js';
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
  platform: 'android',
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
} as const;

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function setup(opts: { perIp?: number; logLines?: string[] } = {}) {
  const base = testConfig();
  const config = {
    ...base,
    auth: { tokenSecret: SECRET },
    limits: { ...base.limits, ...(opts.perIp === undefined ? {} : { requestsPerIpPerMinute: opts.perIp }) },
  };
  const lines = opts.logLines;
  const log = lines ? pino({ level: 'info' }, { write: (s: string) => void lines.push(s) }) : undefined;
  const ctx = createTestContext({
    config,
    clock: new FakeClock(START),
    ...(log ? { log } : {}),
  });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { ctx, app };
}

let userSeq = 0;
async function newUser(): Promise<string> {
  const id = `00000000-0000-4000-8000-${String(++userSeq).padStart(12, '0')}`;
  const now = new Date(START);
  await testDb()
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone: `+234803${String(userSeq).padStart(7, '0')}`,
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function signIn(ctx: TestContext): Promise<{ userId: string; familyId: string; session: Session }> {
  const userId = await newUser();
  const { familyId, session } = await issueSession(ctx.db, keys, { userId, device, now: ctx.clock.now() });
  return { userId, familyId, session };
}

const refresh = (app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const errorOf = (res: { json: () => unknown }) => (res.json() as { error: Record<string, unknown> }).error;

describe('POST /v1/auth/refresh', () => {
  it('rotates: 200 with a new pair that differs from the old one and can itself be refreshed', async () => {
    const { ctx, app } = await setup();
    const { userId, familyId, session: first } = await signIn(ctx);
    ctx.clock.advanceSeconds(60);

    const res = await refresh(app, { refreshToken: first.refreshToken });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const { session } = res.json() as { session: Session };
    expect(Object.keys(res.json())).toEqual(['session']);
    expect(session).toEqual({
      accessToken: expect.any(String),
      accessTokenExpiresAt: '2026-11-18T12:16:00Z',
      refreshToken: expect.stringMatching(/^rt_/),
      refreshTokenExpiresAt: '2027-02-16T12:01:00Z',
    });
    expect(session.refreshToken).not.toBe(first.refreshToken);
    expect(session.accessToken).not.toBe(first.accessToken);
    const check = verifyAccessToken(keys.access, session.accessToken, ctx.clock.now());
    expect(check).toMatchObject({ kind: 'valid', claims: { sub: userId, fam: familyId } });

    ctx.clock.advanceSeconds(60);
    const again = await refresh(app, { refreshToken: session.refreshToken });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { session: Session }).session.refreshToken).not.toBe(session.refreshToken);
  });

  it('a grace-window replay (at 30 s) returns the byte-identical JSON', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);

    const first = await refresh(app, { refreshToken: session.refreshToken });
    expect(first.statusCode).toBe(200);
    ctx.clock.advanceSeconds(30);
    const replay = await refresh(app, { refreshToken: session.refreshToken });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
  });

  it('a replay at 31 s is 401 session_revoked, and the child then also fails with session_revoked', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);

    const first = await refresh(app, { refreshToken: session.refreshToken });
    const child = (first.json() as { session: Session }).session;
    ctx.clock.advanceSeconds(31);

    const reuse = await refresh(app, { refreshToken: session.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toEqual({ error: { code: 'session_revoked', message: expect.any(String) } });

    const childRes = await refresh(app, { refreshToken: child.refreshToken });
    expect(childRes.statusCode).toBe(401);
    expect(errorOf(childRes).code).toBe('session_revoked');
  });

  it('a token of a revoked family (sign-out) is 401 session_revoked', async () => {
    const { ctx, app } = await setup();
    const { familyId, session } = await signIn(ctx);
    await revokeFamily(ctx.db, familyId, ctx.clock.now());

    const res = await refresh(app, { refreshToken: session.refreshToken });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('session_revoked');
  });

  it('a token past its 90 days (by 1 s) is 401 invalid_refresh_token', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);
    ctx.clock.advance(90 * DAY + 1000);

    const res = await refresh(app, { refreshToken: session.refreshToken });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'invalid_refresh_token', message: expect.any(String) } });
  });

  it.each([
    ['an unknown well-formed token', newRefreshToken()],
    ['a malformed token', 'not-a-refresh-token'],
    ['an empty string', ''],
  ])('%s is 401 invalid_refresh_token', async (_name, refreshToken) => {
    const { app } = await setup();
    const res = await refresh(app, { refreshToken });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_refresh_token');
  });

  it('needs no Authorization header, and ignores one that is sent', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);
    const res = await refresh(app, { refreshToken: session.refreshToken }, { authorization: 'Bearer junk' });
    expect(res.statusCode).toBe(200);
  });

  it('a missing refreshToken is 400 validation_failed with the field listed', async () => {
    const { app } = await setup();
    const res = await refresh(app, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: expect.any(String),
        fields: [{ field: 'refreshToken', code: 'required' }],
      },
    });
  });

  it('an unknown body field is 400 validation_failed', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);
    const res = await refresh(app, { refreshToken: session.refreshToken, extra: 1 });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).fields).toEqual([{ field: 'extra', code: 'invalid_value' }]);
  });

  it('two concurrent refreshes of one token both get the same pair', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);

    const [a, b] = await Promise.all([
      refresh(app, { refreshToken: session.refreshToken }),
      refresh(app, { refreshToken: session.refreshToken }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
  });
});

describe('POST /v1/auth/refresh: rate limit (30 per hour per family)', () => {
  it('the 31st refresh of one family within the hour is 429 with retryAfterSeconds; others are unaffected', async () => {
    const { ctx, app } = await setup();
    const { session } = await signIn(ctx);
    const other = await signIn(ctx);

    let token = session.refreshToken;
    for (let i = 1; i <= 30; i++) {
      ctx.clock.advanceSeconds(60);
      const res = await refresh(app, { refreshToken: token });
      expect(res.statusCode, `refresh #${i}`).toBe(200);
      token = (res.json() as { session: Session }).session.refreshToken;
    }

    // The window opened with refresh #1 at +1 min; #31 comes at +31 min, so 30 minutes are left.
    ctx.clock.advanceSeconds(60);
    const limited = await refresh(app, { refreshToken: token });
    expect(limited.statusCode).toBe(429);
    const error = errorOf(limited);
    expect(error).toEqual({ code: 'rate_limited', message: expect.any(String), retryAfterSeconds: 30 * 60 });
    expect(limited.headers['retry-after']).toBe(String(30 * 60));

    const otherRes = await refresh(app, { refreshToken: other.session.refreshToken });
    expect(otherRes.statusCode).toBe(200);

    // The limited request did not rotate the token (a rotated one would now be reuse): once the
    // window has passed, the same token rotates normally.
    ctx.clock.advance(HOUR);
    const after = await refresh(app, { refreshToken: token });
    expect(after.statusCode).toBe(200);
  });

  it('garbage tokens have no family, and are held back by the per-IP limiter', async () => {
    const { app } = await setup({ perIp: 3 });
    const headers = { 'x-real-ip': '203.0.113.7' };
    for (let i = 0; i < 3; i++) {
      const res = await refresh(app, { refreshToken: newRefreshToken() }, headers);
      expect(res.statusCode).toBe(401);
    }
    const res = await refresh(app, { refreshToken: newRefreshToken() }, headers);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    expect(errorOf(res).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /v1/auth/refresh: logging', () => {
  it('logs the family id and the result, never a token', async () => {
    const lines: string[] = [];
    const { ctx, app } = await setup({ logLines: lines });
    const { familyId, session } = await signIn(ctx);

    const ok = await refresh(app, { refreshToken: session.refreshToken });
    const child = (ok.json() as { session: Session }).session;
    await refresh(app, { refreshToken: session.refreshToken });
    ctx.clock.advanceSeconds(31);
    await refresh(app, { refreshToken: session.refreshToken });
    await refresh(app, { refreshToken: 'garbage-token' });

    const all = lines.join('\n');
    for (const secret of [session.refreshToken, session.accessToken, child.refreshToken, child.accessToken]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toContain('garbage-token');

    const results = lines
      .map((l) => JSON.parse(l) as { familyId?: string; result?: string })
      .filter((l) => l.result !== undefined)
      .map((l) => [l.result, l.familyId]);
    expect(results).toEqual([
      ['rotated', familyId],
      ['grace', familyId],
      ['reuse_detected', familyId],
      ['invalid', undefined],
    ]);
  });
});
