/**
 * End-to-end walk of the acceptance checklist in docs/auth-contract.md §7: one `it` per line, named after
 * the line, through HTTP (app.inject) against the real public app, real Postgres and real Argon2id, with a
 * FakeClock for every time rule. No mocks: the auth plugin, the SOS routes and the device routes are the
 * production ones. Core is never reached, so it is the test helpers' "unused" Core.
 *
 * Every request and response of the whole file is scanned for sensitive values, and every log line of the
 * whole file is captured, so the logging item (the last `it`, which runs after every other walk) can
 * assert that none of those values reached the log.
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import { createLogger } from '../../src/logger.js';
import {
  closeTestDb,
  createTestContext,
  markHealthy,
  resetDb,
  type TestContext,
  testConfig,
} from '../helpers/context.js';
import { postSos, sosBody } from '../sos/helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
type Json = Record<string, any>;

const START = '2026-11-18T12:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const INSTALL_ID = '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b';

// ---------------------------------------------------------------------------------------------
// Log capture: the relay's own logger (createLogger, so its redaction) at trace level, every line kept.

const logLines: string[] = [];
const log = createLogger(
  'trace',
  new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  }),
);

// ---------------------------------------------------------------------------------------------
// Sensitive values seen on the wire in either direction, kept to look for in the log.

const SENSITIVE_KEYS = new Set(['password', 'refreshToken', 'accessToken', 'fullName', 'phone', 'email']);
const sensitive = new Map<string, string>();

/** Values under 8 characters are skipped: an invalid body's `'0803'` or `'   '` would match any log line by chance. */
function remember(label: string, value: unknown): void {
  if (typeof value === 'string' && value.trim().length >= 8) sensitive.set(value, label);
}

function collect(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (SENSITIVE_KEYS.has(key)) remember(key, value);
    else collect(value);
  }
}

// ---------------------------------------------------------------------------------------------

let app: PublicApp;
let ctx: TestContext;
let clock: FakeClock;
let userSeq = 0;

beforeEach(async () => {
  await resetDb();
  userSeq = 0;
  clock = new FakeClock(START);
  const base = testConfig();
  ctx = createTestContext({
    clock,
    log,
    config: {
      ...base,
      auth: { enabled: true, tokenSecret: 'auth-token-secret-for-tests-0123456789ab' },
      // Above anything one walk sends, so a 429 here could only be an auth limit.
      limits: { ...base.limits, requestsPerIpPerMinute: 10_000 },
    },
  });
  await markHealthy(ctx);
  app = await buildPublicApp(ctx);
});

afterEach(async () => {
  await app.close();
});

afterAll(() => closeTestDb());

interface Reply {
  status: number;
  body: Json;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'idempotency-key') remember('Idempotency-Key', value);
    if (name.toLowerCase() === 'authorization') remember('authorization', value.replace(/^Bearer /, ''));
  }
  if (opts.body !== undefined) collect(opts.body);
  const res = await app.inject({
    method,
    url,
    headers,
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
  const text = res.body;
  const body = text === '' ? {} : (JSON.parse(text) as Json);
  collect(body);
  return { status: res.statusCode, body };
}

/** A sign-up body for the n-th user: distinct email, phone and name. */
function signupBody(n: number, overrides: Record<string, unknown> = {}): Json {
  return {
    fullName: `Ada Okafor ${n}`,
    phone: `+23480312345${String(60 + n).padStart(2, '0')}`,
    email: `ada${n}@example.com`,
    password: PASSWORD,
    device: { platform: 'android', appVersion: '0.3.0', installId: INSTALL_ID },
    ...overrides,
  };
}

const signup = (body: Json, key: string = randomUUID()) =>
  call('POST', '/v1/auth/signup', { headers: { 'idempotency-key': key }, body });

/** Signs up a fresh user and returns the 201 body. */
async function newUser(overrides: Record<string, unknown> = {}): Promise<Json> {
  userSeq += 1;
  const res = await signup(signupBody(userSeq, overrides));
  expect(res.status).toBe(201);
  return res.body;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const me = (accessToken: string) => call('GET', '/v1/me', { headers: bearer(accessToken) });
const refresh = (refreshToken: string) => call('POST', '/v1/auth/refresh', { body: { refreshToken } });
const signout = (accessToken: string, refreshToken: string) =>
  call('POST', '/v1/auth/signout', { headers: bearer(accessToken), body: { refreshToken } });
const signin = (email: string, password: string) =>
  call('POST', '/v1/auth/signin', {
    body: {
      email,
      password,
      device: { platform: 'android', appVersion: '0.3.0', installId: INSTALL_ID },
    },
  });

async function registerDevice(): Promise<string> {
  const nonce = await call('GET', '/v1/devices/nonce');
  expect(nonce.status).toBe(200);
  const reg = await call('POST', '/v1/devices/register', {
    body: { platform: 'android', nonce: nonce.body.nonce },
  });
  expect(reg.status).toBe(201);
  remember('deviceToken', reg.body.deviceToken);
  return reg.body.deviceToken as string;
}

// ---------------------------------------------------------------------------------------------

describe('docs/auth-contract.md §7: acceptance checklist', () => {
  it('Sign-up with a valid body returns 201 with `user` and `session`, and the access token works on `GET /v1/me`.', async () => {
    const body = signupBody(1);
    const res = await signup(body);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      fullName: 'Ada Okafor 1',
      phone: body.phone,
      email: 'ada1@example.com',
      phoneVerified: false,
      createdAt: '2026-11-18T12:00:00Z',
    });
    expect(res.body.session).toEqual({
      accessToken: expect.any(String),
      accessTokenExpiresAt: '2026-11-18T12:15:00Z',
      refreshToken: expect.stringMatching(/^rt_/),
      refreshTokenExpiresAt: '2027-02-16T12:00:00Z',
    });

    const mine = await me(res.body.session.accessToken);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ user: res.body.user });
  });

  it('Sign-up with several invalid fields returns 400 and lists **all** of them in `fields`.', async () => {
    const res = await signup(
      signupBody(1, {
        fullName: '   ',
        phone: '0803',
        email: 'not-an-email',
        password: 'short',
        device: { platform: 'windows', appVersion: 'v'.repeat(33), installId: 'nope' },
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields).toEqual([
      { field: 'fullName', code: 'too_short' },
      { field: 'phone', code: 'invalid_phone' },
      { field: 'email', code: 'invalid_email' },
      { field: 'password', code: 'too_short' },
      { field: 'device.platform', code: 'invalid_value' },
      { field: 'device.appVersion', code: 'too_long' },
      { field: 'device.installId', code: 'invalid_value' },
    ]);
    const users = await ctx.db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(0);
  });

  it('A duplicate email returns 409 `email_taken`, including when it differs only in case (`ADA@example.com`).', async () => {
    await newUser({ email: 'ada@example.com' });

    const same = await signup(signupBody(2, { email: 'ada@example.com' }));
    const upper = await signup(signupBody(3, { email: 'ADA@example.com' }));

    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('email_taken');
    expect(upper.status).toBe(409);
    expect(upper.body.error.code).toBe('email_taken');
    const users = await ctx.db.selectFrom('users').select('email').execute();
    expect(users.map((u) => u.email)).toEqual(['ada@example.com']);
  });

  it('A duplicate phone number returns 409 `phone_taken`.', async () => {
    const first = await newUser();

    const res = await signup(signupBody(2, { phone: first.user.phone }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('phone_taken');
  });

  it('A body with an unknown field returns 400 `validation_failed`.', async () => {
    const res = await signup(signupBody(1, { isAdmin: true }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields).toContainEqual({ field: 'isAdmin', code: 'invalid_value' });
    const users = await ctx.db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(0);
  });

  it('Replaying a sign-up with the same `Idempotency-Key` and body returns the original 201 and creates no second user.', async () => {
    const key = randomUUID();
    const body = signupBody(1);

    const first = await signup(body, key);
    clock.advanceMinutes(5);
    const replay = await signup(body, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.user).toEqual(first.body.user);
    // A session of its own for the same user, and it works.
    expect((await me(replay.body.session.accessToken)).body.user.id).toBe(first.body.user.id);
    const users = await ctx.db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(1);

    const other = await signup(signupBody(1, { fullName: 'Someone Else' }), key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('idempotency_key_reused');
  });

  it('Refresh rotates the token, and the old token works again only within 30 s, returning the same pair.', async () => {
    const { session } = await newUser();

    const rotated = await refresh(session.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.session.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.body.session.accessToken).not.toBe(session.accessToken);
    expect((await me(rotated.body.session.accessToken)).status).toBe(200);

    clock.advanceSeconds(29);
    const again = await refresh(session.refreshToken);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(rotated.body);
  });

  it('Reusing an old refresh token after 30 s returns 401 `session_revoked`, and its descendants stop working.', async () => {
    const { session: first } = await newUser();
    const second = (await refresh(first.refreshToken)).body.session;
    clock.advanceSeconds(20);
    const third = (await refresh(second.refreshToken)).body.session;
    expect((await me(third.accessToken)).status).toBe(200);

    clock.advanceSeconds(31);
    const reuse = await refresh(first.refreshToken);

    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('session_revoked');
    for (const descendant of [second, third]) {
      const viaRefresh = await refresh(descendant.refreshToken);
      expect(viaRefresh.status).toBe(401);
      expect(viaRefresh.body.error.code).toBe('session_revoked');
      const viaAccess = await me(descendant.accessToken);
      expect(viaAccess.status).toBe(401);
      expect(viaAccess.body.error.code).toBe('session_revoked');
    }
  });

  it('Sign-out returns 204, works with an expired access token, and makes the refresh token fail with 401.', async () => {
    const { session } = await newUser();
    clock.advanceMinutes(16);
    expect((await me(session.accessToken)).body.error.code).toBe('token_expired');

    const res = await signout(session.accessToken, session.refreshToken);

    expect(res.status).toBe(204);
    const after = await refresh(session.refreshToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('session_revoked');
    // Idempotent: a second sign-out with the same tokens is still 204.
    expect((await signout(session.accessToken, session.refreshToken)).status).toBe(204);
  });

  it('An expired access token on `GET /v1/me` returns 401 `token_expired`, not `invalid_token`.', async () => {
    const { session } = await newUser();
    clock.advanceMinutes(15);
    clock.advanceSeconds(1);

    const res = await me(session.accessToken);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('token_expired');
  });

  it("Sign-out with a refresh token of another user returns 204 and that user's session keeps working.", async () => {
    const ada = await newUser();
    const bola = await newUser();

    const res = await signout(ada.session.accessToken, bola.session.refreshToken);

    expect(res.status).toBe(204);
    expect((await me(bola.session.accessToken)).status).toBe(200);
    const rotated = await refresh(bola.session.refreshToken);
    expect(rotated.status).toBe(200);
    expect((await me(rotated.body.session.accessToken)).status).toBe(200);
    // And nothing of Ada's was revoked either.
    expect((await me(ada.session.accessToken)).status).toBe(200);
  });

  it('a user whose session ended can sign in again', async () => {
    const created = await newUser();
    const ended = await signout(created.session.accessToken, created.session.refreshToken);
    expect(ended.status).toBe(204);
    expect((await refresh(created.session.refreshToken)).body.error.code).toBe('session_revoked');

    const again = await signin(created.user.email, PASSWORD);

    expect(again.status).toBe(200);
    expect(again.body.user).toEqual(created.user);
    expect(again.body.session.refreshToken).not.toBe(created.session.refreshToken);
    expect((await me(again.body.session.accessToken)).status).toBe(200);
    expect((await me(created.session.accessToken)).body.error.code).toBe('session_revoked');
  });

  it('sign-in answers the same for an unknown email and a wrong password', async () => {
    const created = await newUser();
    const unknown = await signin('nobody@example.com', PASSWORD);
    const wrong = await signin(created.user.email, 'not the password');

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body.error.code).toBe('invalid_credentials');
  });

  it('A `GET /v1/me` with a relay device token answers 401 `invalid_token`, and a `POST /v1/sos` with an access token answers 401 `unauthorized`: the two kinds of token are never accepted for each other.', async () => {
    const deviceToken = await registerDevice();
    const { session } = await newUser();

    const meWithDevice = await me(deviceToken);
    expect(meWithDevice.status).toBe(401);
    expect(meWithDevice.body.error.code).toBe('invalid_token');

    const sosWithAccess = await postSos(app, { token: session.accessToken, body: sosBody(ctx) });
    expect(sosWithAccess.status).toBe(401);
    expect(sosWithAccess.body.error.code).toBe('unauthorized');
    remember('phone', sosBody(ctx).phone);
    remember('name', sosBody(ctx).name);

    // Each token still works where it belongs.
    expect((await me(session.accessToken)).status).toBe(200);
    const sosWithDevice = await postSos(app, { token: deviceToken, body: sosBody(ctx) });
    expect([201, 202]).toContain(sosWithDevice.status);
  });

  // Runs after every other walk in this file, so the capture spans all of them (see the file comment).
  it('No password, token or full request body appears in the logs. The logger redacts at least `req.headers.authorization`, `password`, `refreshToken`, `accessToken`, `Idempotency-Key`, and the `fullName`, `phone` and `email` fields. A user is named in logs by `user.id` only.', async () => {
    // The walk of this test: sign-up (with the key), me, refresh, sign-out, and refusals of each kind.
    const body = signupBody(1);
    const key = randomUUID();
    const created = await signup(body, key);
    expect(created.status).toBe(201);
    await signup(body, key);
    await signup(signupBody(2, { email: body.email }));
    await signup(signupBody(3, { phone: body.phone }));
    await signup(signupBody(4, { email: 'bad', password: 'short' }));
    const { session, user } = created.body;
    await me(session.accessToken);
    const rotated = (await refresh(session.refreshToken)).body.session;
    clock.advanceSeconds(31);
    await refresh(session.refreshToken);
    await me(rotated.accessToken);
    clock.advanceMinutes(20);
    await me(rotated.accessToken);
    await signout(rotated.accessToken, rotated.refreshToken);

    const everything = logLines.join('');
    expect(logLines.length).toBeGreaterThan(0);
    const leaked = [...sensitive].filter(([value]) => everything.includes(value)).map(([, label]) => label);
    expect(leaked).toEqual([]);
    // The user is named by id, which is what the contract allows.
    expect(everything).toContain(user.id);
  });

  // The same checklist line, proven on the logger's configuration itself: the fields it names, logged on
  // purpose, at the top level and one level down, as a log line carries them.
  it('The log redaction covers `req.headers.authorization`, `password`, `refreshToken`, `accessToken`, `Idempotency-Key`, `fullName`, `phone` and `email`.', () => {
    const fields = ['password', 'refreshToken', 'accessToken', 'fullName', 'phone', 'email'];
    const probe = {
      req: { headers: { authorization: 'Bearer PROBE-AUTH', 'idempotency-key': 'PROBE-KEY' } },
      ...Object.fromEntries(fields.map((f) => [f, `PROBE-${f}`])),
      body: Object.fromEntries(fields.map((f) => [f, `PROBE-NESTED-${f}`])),
    };
    const before = logLines.length;
    log.info(probe, 'redaction probe');
    const line = logLines.slice(before).join('');
    expect(line).toContain('redaction probe');
    expect(line).not.toContain('PROBE-');
  });
});
