/**
 * POST /v1/auth/signin through HTTP (app.inject), against real Postgres, with a FakeClock.
 * The other auth routes are the real ones: sign-in is checked through GET /v1/me, sign-out and refresh.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type KyselyPlugin, sql } from 'kysely';
import { type Logger, pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys, signinPhoneHash } from '../../src/auth/keys.js';
import * as password from '../../src/auth/password.js';
import { verifyAccessToken } from '../../src/auth/tokens.js';
import { SIGNIN_PASSWORD_MAX_CHARS } from '../../src/auth/validate.js';
import { HOUR, MINUTE } from '../../src/clock.js';
import { METRICS } from '../../src/metrics.js';
import { closeTestDb, createTestContext, resetDb, testConfig, testDb } from '../helpers/context.js';
import { RecordingMetrics } from '../sos/helpers.js';

const AUTH_SECRET = 'auth-token-secret-for-tests-0123456789ab';
const keys = deriveAuthKeys(AUTH_SECRET);
const PASSWORD = 'correct horse battery staple';
const INSTALL_ID = '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b';
const OTHER_INSTALL = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function setup(log?: Logger) {
  const metrics = new RecordingMetrics();
  const base = testConfig();
  const ctx = createTestContext({
    metrics,
    ...(log ? { log } : {}),
    config: {
      ...base,
      auth: { tokenSecret: AUTH_SECRET },
      limits: { ...base.limits, requestsPerIpPerMinute: 10_000 },
    },
  });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { app, ctx, metrics };
}

const device = { platform: 'android' as const, appVersion: '0.3.0', installId: INSTALL_ID };

function signupBody(n: number, over: Record<string, unknown> = {}) {
  return {
    fullName: 'Ada Okafor',
    phone: phoneOf(n),
    password: PASSWORD,
    device,
    ...over,
  };
}

/** The n-th user's phone: a valid Nigerian mobile number, distinct per n. */
function phoneOf(n: number): string {
  return `+234803123${String(n).padStart(4, '0')}`;
}
const PHONE_1 = phoneOf(1);
const PHONE_2 = phoneOf(2);
/** A well-formed number no account has. */
const UNKNOWN_PHONE = '+2348099999999';

function signinBody(phone: string, password: string, over: Record<string, unknown> = {}) {
  return { phone, password, device, ...over };
}

function signup(app: FastifyInstance, body: unknown, ip = '203.0.113.1') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-real-ip': ip },
    payload: JSON.stringify(body),
  });
}

function signin(app: FastifyInstance, body: unknown, opts: { ip?: string; raw?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signin',
    headers: { 'content-type': 'application/json', 'x-real-ip': opts.ip ?? '203.0.113.20' },
    payload: opts.raw ?? JSON.stringify(body),
  });
}

function me(app: FastifyInstance, accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: { authorization: `Bearer ${accessToken}`, 'x-real-ip': '203.0.113.30' },
  });
}

function refresh(app: FastifyInstance, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.31' },
    payload: JSON.stringify({ refreshToken }),
  });
}

function signout(app: FastifyInstance, accessToken: string, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'x-real-ip': '203.0.113.32',
    },
    payload: JSON.stringify({ refreshToken }),
  });
}

const countRows = async (table: 'users' | 'signin_attempts' | 'token_families') =>
  Number(
    (await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(testDb())).rows[0]?.n,
  );

describe('200 OK', () => {
  it('returns the sign-up user shape and a working access token', async () => {
    const { app, ctx, metrics } = await setup();
    const created = await signup(app, signupBody(1));
    expect(created.statusCode).toBe(201);
    const signedUp = created.json();

    const res = await signin(app, signinBody(` ${PHONE_1} `, PASSWORD));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const body = res.json();
    expect(body.user).toEqual(signedUp.user);
    expect(body.user.phone).toBe(PHONE_1);
    expect(body.user).not.toHaveProperty('email');
    expect(Object.keys(body.session).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect(body.session.refreshToken).toMatch(/^rt_/);
    expect(body.session.refreshToken).not.toBe(signedUp.session.refreshToken);
    const mine = await me(app, body.session.accessToken);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ user: signedUp.user });

    const check = verifyAccessToken(keys.access, body.session.accessToken, ctx.clock.now());
    expect(check.kind).toBe('valid');
    if (check.kind !== 'valid') return;
    const family = await testDb()
      .selectFrom('token_families')
      .select(['install_id', 'platform'])
      .where('id', '=', check.claims.fam)
      .executeTakeFirstOrThrow();
    expect(family).toEqual({ install_id: INSTALL_ID, platform: 'android' });
    expect(metrics.count(METRICS.authSignins, { result: 'success' })).toBe(1);
  });

  it('starts a new family: signing out one session does not end the other', async () => {
    const { app } = await setup();
    const created = (await signup(app, signupBody(1))).json();
    const second = await signin(
      app,
      signinBody(PHONE_1, PASSWORD, {
        device: { platform: 'ios', appVersion: '1.2.3', installId: OTHER_INSTALL },
      }),
    );
    expect(second.statusCode).toBe(200);
    const signedIn = second.json();

    const families = await testDb().selectFrom('token_families').select(['platform', 'install_id']).execute();
    expect(families).toEqual(
      expect.arrayContaining([
        { platform: 'android', install_id: INSTALL_ID },
        { platform: 'ios', install_id: OTHER_INSTALL },
      ]),
    );

    expect((await signout(app, created.session.accessToken, created.session.refreshToken)).statusCode).toBe(
      204,
    );
    expect((await me(app, created.session.accessToken)).json().error.code).toBe('session_revoked');
    expect((await me(app, signedIn.session.accessToken)).statusCode).toBe(200);
    expect((await me(app, signedIn.session.accessToken)).json().user.id).toBe(created.user.id);
  });

  it('stores only a keyed hash of the phone number', async () => {
    const { app } = await setup();
    await signup(app, signupBody(1));
    expect((await signin(app, signinBody(PHONE_1, PASSWORD))).statusCode).toBe(200);
    const rows = await testDb().selectFrom('signin_attempts').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone_hash).toBe(signinPhoneHash(keys.signinPhone, PHONE_1));
    expect(JSON.stringify(rows[0])).not.toContain(PHONE_1.slice(1));
  });
});

describe('401 invalid_credentials', () => {
  it('wrong password and unknown phone have byte-identical bodies', async () => {
    const { app, metrics } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    const wrong = await signin(app, signinBody(PHONE_1, 'not the password'));
    const unknown = await signin(app, signinBody(UNKNOWN_PHONE, PASSWORD));

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.json()).toEqual({
      error: { code: 'invalid_credentials', message: expect.any(String) },
    });
    expect(wrong.json().error).not.toHaveProperty('fields');
    expect(await countRows('token_families')).toBe(1);
    expect(metrics.count(METRICS.authSignins, { result: 'invalid_credentials' })).toBe(2);
  });

  it('a value that cannot match an account is not a 400', async () => {
    const { app } = await setup();
    const phone = await signin(app, signinBody('not-a-phone', 'short'));
    const empty = await signin(app, signinBody(PHONE_1, ''));
    expect(phone.statusCode).toBe(401);
    expect(phone.json().error.code).toBe('invalid_credentials');
    expect(empty.statusCode).toBe(401);
    expect(empty.body).toBe(phone.body);
  });

  it('a password longer than 1024 characters is invalid_credentials and is not verified', async () => {
    const { app } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    const spy = vi.spyOn(password, 'verifyPassword');
    const tooLong = 'x'.repeat(SIGNIN_PASSWORD_MAX_CHARS + 1);
    const known = await signin(app, signinBody(PHONE_1, tooLong));
    const unknown = await signin(app, signinBody(UNKNOWN_PHONE, tooLong));
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.body).toBe(unknown.body);
    expect(known.json().error.code).toBe('invalid_credentials');
    expect(spy).not.toHaveBeenCalled();

    const atCap = await signin(app, signinBody(PHONE_1, 'y'.repeat(SIGNIN_PASSWORD_MAX_CHARS)));
    expect(atCap.statusCode).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a deleted user is invalid_credentials, the same body as an unknown phone', async () => {
    const { app } = await setup();
    const created = (await signup(app, signupBody(1))).json();
    await testDb().deleteFrom('users').where('id', '=', created.user.id).execute();

    const deleted = await signin(app, signinBody(PHONE_1, PASSWORD));
    const unknown = await signin(app, signinBody(UNKNOWN_PHONE, PASSWORD));
    expect(deleted.statusCode).toBe(401);
    expect(deleted.body).toBe(unknown.body);
  });
});

describe('validation', () => {
  it.each([
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['a number', '1'],
    ['null', 'null'],
    ['broken JSON', '{'],
  ])('%s → 400 malformed_request', async (_name, raw) => {
    const { app, metrics } = await setup();
    const res = await signin(app, undefined, { raw });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
    expect(metrics.count(METRICS.authSignins)).toBe(0);
    expect(await countRows('signin_attempts')).toBe(0);
  });

  it('a wrong JSON type is malformed_request, ahead of any missing field', async () => {
    const { app } = await setup();
    const res = await signin(app, { phone: 1, device: 'phone' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
    expect(res.json().error).not.toHaveProperty('fields');
  });

  it('lists every missing field as required', async () => {
    const { app } = await setup();
    const res = await signin(app, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'validation_failed',
      fields: [
        { field: 'phone', code: 'required' },
        { field: 'password', code: 'required' },
        { field: 'device', code: 'required' },
      ],
    });
  });

  it('an unknown field is invalid_value, after the known fields', async () => {
    const { app } = await setup();
    const res = await signin(app, { extra: true, device: { ...device, os: 'android' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual([
      { field: 'phone', code: 'required' },
      { field: 'password', code: 'required' },
      { field: 'extra', code: 'invalid_value' },
      { field: 'device.os', code: 'invalid_value' },
    ]);
  });

  it('email is no longer a sign-in field: it is unknown, and the phone is required', async () => {
    const { app } = await setup();
    const res = await signin(app, { email: 'ada@example.com', password: PASSWORD, device });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'validation_failed',
      fields: [
        { field: 'phone', code: 'required' },
        { field: 'email', code: 'invalid_value' },
      ],
    });
    expect(await countRows('signin_attempts')).toBe(0);
  });

  it.each([
    ['platform', { platform: 'windows' }, 'device.platform', 'invalid_value'],
    ['appVersion length', { appVersion: 'v'.repeat(33) }, 'device.appVersion', 'too_long'],
    ['appVersion control character', { appVersion: '0.3\n0' }, 'device.appVersion', 'invalid_value'],
    ['installId', { installId: 'not-a-uuid' }, 'device.installId', 'invalid_value'],
  ])('device %s follows the sign-up rule', async (_name, deviceOver, field, code) => {
    const { app } = await setup();
    const res = await signin(app, signinBody(PHONE_1, PASSWORD, { device: { ...device, ...deviceOver } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.fields).toContainEqual({ field, code });
    expect(await countRows('signin_attempts')).toBe(0);
  });

  it('a refused body does not count toward the IP limit', async () => {
    const { app } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    for (let i = 0; i < 20; i++) {
      const res = await signin(app, { password: PASSWORD });
      expect(res.statusCode).toBe(400);
    }
    expect((await signin(app, signinBody(PHONE_1, PASSWORD))).statusCode).toBe(200);
  });
});

describe('rate limits', () => {
  it('the 11th attempt for one phone in an hour is 429 from any IP, and the next hour allows it', async () => {
    const { app, ctx, metrics } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    for (let n = 1; n <= 10; n++) {
      const res = await signin(app, signinBody(PHONE_1, PASSWORD), { ip: `198.51.100.${n}` });
      expect(res.statusCode).toBe(200);
    }
    const limited = await signin(app, signinBody(PHONE_1, PASSWORD), { ip: '198.51.100.99' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: 'rate_limited', message: expect.any(String), retryAfterSeconds: 60 * 60 },
    });
    expect(limited.headers['retry-after']).toBe(String(60 * 60));
    expect(await countRows('signin_attempts')).toBe(10);
    expect(metrics.count(METRICS.authSignins, { result: 'success' })).toBe(10);
    expect(metrics.count(METRICS.authSignins, { result: 'rate_limited' })).toBe(1);

    ctx.clock.advance(HOUR - 1);
    const still = await signin(app, signinBody(PHONE_1, PASSWORD), { ip: '198.51.100.98' });
    expect(still.statusCode).toBe(429);
    expect(still.json().error.retryAfterSeconds).toBe(1);

    ctx.clock.advance(1);
    const again = await signin(app, signinBody(PHONE_1, PASSWORD), { ip: '198.51.100.97' });
    expect(again.statusCode).toBe(200);
    expect(await countRows('signin_attempts')).toBe(11);
  });

  it('another phone is not affected', async () => {
    const { app } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    expect((await signup(app, signupBody(2), '203.0.113.2')).statusCode).toBe(201);
    for (let n = 1; n <= 10; n++) {
      expect((await signin(app, signinBody(PHONE_1, 'nope'), { ip: `203.0.113.${n}` })).statusCode).toBe(401);
    }
    expect((await signin(app, signinBody(PHONE_2, PASSWORD), { ip: '203.0.113.50' })).statusCode).toBe(200);
  });

  it('the 21st attempt from one IP in an hour is 429, and the window reopens after an hour', async () => {
    const { app, ctx } = await setup();
    for (let n = 1; n <= 20; n++) {
      const res = await signin(app, signinBody(phoneOf(100 + n), 'nope'));
      expect(res.statusCode).toBe(401);
    }
    ctx.clock.advance(10 * MINUTE);
    const limited = await signin(app, signinBody(phoneOf(121), 'nope'));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 50 * 60 });
    expect(limited.headers['retry-after']).toBe(String(50 * 60));
    expect(await countRows('signin_attempts')).toBe(20);

    expect((await signin(app, signinBody(phoneOf(122), 'nope'), { ip: '198.51.100.8' })).statusCode).toBe(
      401,
    );
    ctx.clock.advance(HOUR);
    expect((await signin(app, signinBody(phoneOf(123), 'nope'))).statusCode).toBe(401);
  });
});

describe('concurrency', () => {
  it('15 parallel attempts on one phone evaluate exactly 10', async () => {
    const { app, metrics } = await setup();
    expect((await signup(app, signupBody(1))).statusCode).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        signin(app, signinBody(PHONE_1, PASSWORD), { ip: `198.51.100.${i + 1}` }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    for (const refused of results.filter((r) => r.statusCode === 429)) {
      expect(refused.json().error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(await countRows('signin_attempts')).toBe(10);
    expect(await countRows('token_families')).toBe(11);
    expect(metrics.count(METRICS.authSignins, { result: 'success' })).toBe(10);
    expect(metrics.count(METRICS.authSignins, { result: 'rate_limited' })).toBe(5);
  });
});

describe('a revoked session', () => {
  it('sign-in after reuse detection starts a session that works', async () => {
    const { app, ctx } = await setup();
    const created = (await signup(app, signupBody(1))).json();
    const rotated = await refresh(app, created.session.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const child = rotated.json().session;

    ctx.clock.advance(31_000);
    const reuse = await refresh(app, created.session.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('session_revoked');
    expect((await me(app, child.accessToken)).json().error.code).toBe('session_revoked');

    const back = await signin(app, signinBody(PHONE_1, PASSWORD));
    expect(back.statusCode).toBe(200);
    expect(back.json().user).toEqual(created.user);
    expect((await me(app, back.json().session.accessToken)).statusCode).toBe(200);
    expect((await me(app, child.accessToken)).json().error.code).toBe('session_revoked');
  });
});

describe('logs', () => {
  it('a successful sign-in names the user id and neither the phone nor the password', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) });
    const { app } = await setup(log);
    const phone = '+2348039876543';
    const password = 'distinctive-signin-password-9f3c';
    const created = await signup(app, signupBody(1, { phone, password }));
    expect(created.statusCode).toBe(201);
    lines.length = 0;
    const res = await signin(app, signinBody(phone, password));
    expect(res.statusCode).toBe(200);
    const out = lines.join('\n');
    expect(out).toContain(res.json().user.id);
    expect(out).not.toContain(phone.slice(1));
    expect(out).not.toContain(password);
  });

  it('a failed sign-in leaves the user id, the phone and the password out of the log', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) });
    const { app } = await setup(log);
    const phone = '+2348039876543';
    const password = 'distinctive-signin-password-9f3c';
    const created = await signup(app, signupBody(1, { phone, password }));
    expect(created.statusCode).toBe(201);
    lines.length = 0;
    const wrong = 'wrong-password-distinctive-9f3c';
    const res = await signin(app, signinBody(phone, wrong));
    expect(res.statusCode).toBe(401);
    const out = lines.join('\n');
    expect(out).not.toContain(created.json().user.id);
    expect(out).not.toContain(phone.slice(1));
    expect(out).not.toContain(password);
    expect(out).not.toContain(wrong);
  });
});

describe('review fixes', () => {
  it('an unknown phone still runs exactly one password verification', async () => {
    const { app } = await setup();
    const spy = vi.spyOn(password, 'verifyPassword');
    const res = await signin(app, signinBody(UNKNOWN_PHONE, PASSWORD));
    expect(res.statusCode).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a phone with a NUL character is 401 invalid_credentials, not 500, and is still verified', async () => {
    const { app } = await setup();
    const spy = vi.spyOn(password, 'verifyPassword');
    const res = await signin(app, signinBody(`${PHONE_1}\u0000`, PASSWORD));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a request refused by the per-phone limit does not use up the per-IP budget', async () => {
    const { app } = await setup();
    const ip = '198.51.100.77';
    for (let i = 0; i < 10; i++) await signin(app, signinBody(PHONE_2, 'wrong'), { ip });
    for (let i = 0; i < 10; i++) {
      expect((await signin(app, signinBody(PHONE_2, 'wrong'), { ip })).statusCode).toBe(429);
    }
    // 10 counted from this IP so far: 10 more are allowed before the per-IP limit of 20.
    for (let i = 0; i < 10; i++) {
      expect((await signin(app, signinBody(phoneOf(200 + i), 'wrong'), { ip })).statusCode).toBe(401);
    }
    expect((await signin(app, signinBody(phoneOf(299), 'wrong'), { ip })).statusCode).toBe(429);
  });
  it('a user deleted between the lookup and the session insert is 401, and leaves no session behind', async () => {
    const { app: plain } = await setup();
    expect((await signup(plain, signupBody(1))).statusCode).toBe(201);
    await testDb().deleteFrom('token_families').execute();

    let deleted = false;
    const userLookups = new WeakSet<object>();
    const deleteAfterLookup: KyselyPlugin = {
      transformQuery: (args) => {
        const n = args.node;
        if (n.kind === 'SelectQueryNode' && JSON.stringify(n.from).includes('"users"'))
          userLookups.add(args.queryId);
        return n;
      },
      transformResult: async (args) => {
        if (!deleted && userLookups.has(args.queryId) && args.result.rows.length === 1) {
          deleted = true;
          await testDb().deleteFrom('users').execute();
        }
        return args.result;
      },
    };
    const base = testConfig();
    const ctx = createTestContext({
      db: testDb().withPlugin(deleteAfterLookup),
      config: { ...base, auth: { tokenSecret: AUTH_SECRET } },
    });
    const app = await buildPublicApp(ctx);
    open.push(app);

    const res = await signin(app, signinBody(PHONE_1, PASSWORD));
    expect(deleted).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    expect(await countRows('token_families')).toBe(0);
  });
});
