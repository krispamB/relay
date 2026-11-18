/**
 * POST /v1/auth/signup through HTTP (app.inject), against real Postgres, with a FakeClock.
 *
 * The other three auth route modules belong to other slices and may be mid-edit, so they are mocked
 * with empty plugins: this file tests the sign-up route and the real plugin, error handler and app.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { type Logger, pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { verifyPassword } from '../../src/auth/password.js';
import { rfc3339 } from '../../src/auth/sessions.js';
import { refreshTokenHash, verifyAccessToken } from '../../src/auth/tokens.js';
import { DAY, HOUR, MINUTE } from '../../src/clock.js';
import { phoneHash } from '../../src/crypto.js';
import {
  closeTestDb,
  createTestContext,
  resetDb,
  type TestContext,
  testConfig,
  testDb,
} from '../helpers/context.js';

vi.mock('../../src/auth/routes/refresh.js', () => ({ refreshRoutes: async () => {} }));
vi.mock('../../src/auth/routes/signout.js', () => ({ signoutRoutes: async () => {} }));
vi.mock('../../src/auth/routes/me.js', () => ({ meRoutes: async () => {} }));

const AUTH_SECRET = 'auth-token-secret-for-tests-0123456789ab';
const keys = deriveAuthKeys(AUTH_SECRET);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function setup(opts: { log?: Logger } = {}) {
  const base = testConfig();
  const config = { ...base, auth: { enabled: true, tokenSecret: AUTH_SECRET } };
  const ctx: TestContext = createTestContext({ config, ...(opts.log ? { log: opts.log } : {}) });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { ctx, app };
}

/** The n-th distinct, valid user. */
const bodyFor = (n: number, over: Record<string, unknown> = {}) => ({
  fullName: 'Ada Okafor',
  phone: `+234803123${String(n).padStart(4, '0')}`,
  email: `user${n}@example.com`,
  password: 'correct horse battery staple',
  device: { platform: 'android', appVersion: '0.3.0', installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b' },
  ...over,
});

interface SignupOpts {
  key?: string | null;
  ip?: string;
  raw?: string;
}

function signup(app: FastifyInstance, body: unknown, opts: SignupOpts = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-real-ip': opts.ip ?? '203.0.113.1',
  };
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers,
    payload: opts.raw ?? JSON.stringify(body),
  });
}

const countRows = async (
  table: 'users' | 'signup_idempotency' | 'signup_phone_attempts' | 'token_families',
) =>
  Number(
    (await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(testDb())).rows[0]?.n,
  );

describe('201 Created', () => {
  it('answers the contract shape and signs the user in', async () => {
    const { app, ctx } = await setup();
    const res = await signup(app, bodyFor(1, { fullName: '  Ada Okafor  ', email: ' ADA@Example.com ' }));
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['session', 'user']);
    expect(body.user).toEqual({
      id: expect.stringMatching(UUID_RE),
      fullName: 'Ada Okafor',
      phone: '+2348031230001',
      email: 'ada@example.com',
      phoneVerified: false,
      createdAt: rfc3339(ctx.clock.now()),
    });
    expect(Object.keys(body.session).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect(body.session.accessTokenExpiresAt).toBe(
      rfc3339(new Date(ctx.clock.now().getTime() + 15 * MINUTE)),
    );
    expect(body.session.refreshTokenExpiresAt).toBe(rfc3339(new Date(ctx.clock.now().getTime() + 90 * DAY)));
    expect(body.session.refreshToken).toMatch(/^rt_/);
  });

  it('the access token is valid, for this user and a live family', async () => {
    const { app, ctx } = await setup();
    const { user, session } = (await signup(app, bodyFor(1))).json();
    const check = verifyAccessToken(keys.access, session.accessToken, ctx.clock.now());
    expect(check.kind).toBe('valid');
    if (check.kind !== 'valid') return;
    expect(check.claims.sub).toBe(user.id);
    const family = await testDb()
      .selectFrom('token_families')
      .selectAll()
      .where('id', '=', check.claims.fam)
      .executeTakeFirstOrThrow();
    expect(family).toMatchObject({
      user_id: user.id,
      install_id: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
      platform: 'android',
      app_version: '0.3.0',
      revoked_at: null,
    });
    const token = await testDb()
      .selectFrom('refresh_tokens')
      .select('family_id')
      .where('token_hash', '=', refreshTokenHash(session.refreshToken))
      .executeTakeFirstOrThrow();
    expect(token.family_id).toBe(family.id);
  });

  it('stores the password only as an Argon2id hash', async () => {
    const { app } = await setup();
    const password = 'correct horse battery staple';
    expect((await signup(app, bodyFor(1, { password }))).statusCode).toBe(201);
    const row = await testDb().selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(password);
    expect(await verifyPassword(row.password_hash, password)).toBe(true);
    expect(row).toMatchObject({ full_name: 'Ada Okafor', email: 'user1@example.com' });
  });

  it('documents the route in OpenAPI under the auth tag', async () => {
    const { app } = await setup();
    await app.ready();
    const doc = app.swagger() as {
      paths: Record<
        string,
        Record<string, { tags?: string[]; summary?: string; parameters?: { name: string; in: string }[] }>
      >;
    };
    const op = doc.paths['/v1/auth/signup']?.post;
    expect(op?.tags).toEqual(['auth']);
    expect(op?.summary).toBeTruthy();
    expect(op?.parameters?.some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key')).toBe(
      true,
    );
  });
});

describe('Idempotency-Key header', () => {
  it('missing → 400 validation_failed on the Idempotency-Key field', async () => {
    const { app } = await setup();
    const res = await signup(app, bodyFor(1), { key: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({
      code: 'validation_failed',
      message: expect.any(String),
      fields: [{ field: 'Idempotency-Key', code: 'required' }],
    });
    expect(await countRows('users')).toBe(0);
  });

  it.each([
    ['not a UUID', 'hello'],
    ['empty', ''],
    ['a UUID v1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['a UUID with a bad variant', '3f2b8c1e-5a7d-4e9b-cc2d-1a2b3c4d5e6f'],
    ['a UUID with trailing text', '3f2b8c1e-5a7d-4e9b-8c2d-1a2b3c4d5e6f-x'],
  ])('%s → 400 invalid_value', async (_name, key) => {
    const { app } = await setup();
    const res = await signup(app, bodyFor(1), { key });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual([{ field: 'Idempotency-Key', code: 'invalid_value' }]);
    expect(await countRows('users')).toBe(0);
  });

  it('is checked before the body: a bad header with a bad body reports only the header', async () => {
    const { app } = await setup();
    const res = await signup(app, { nope: true }, { key: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual([{ field: 'Idempotency-Key', code: 'required' }]);
  });

  it('an upper-case UUID v4 is accepted, and is the same key as its lower-case spelling', async () => {
    const { app } = await setup();
    const key = randomUUID();
    const first = await signup(app, bodyFor(1), { key: key.toUpperCase() });
    expect(first.statusCode).toBe(201);
    const second = await signup(app, bodyFor(1), { key });
    expect(second.statusCode).toBe(201);
    expect(second.json().user.id).toBe(first.json().user.id);
    expect(await countRows('users')).toBe(1);
  });
});

describe('validation', () => {
  it('lists every invalid field, not only the first', async () => {
    const { app } = await setup();
    const res = await signup(app, {
      fullName: '   ',
      phone: '0803',
      email: 'nope',
      password: 'short',
      device: { platform: 'beos', appVersion: 'v'.repeat(33), installId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({
      code: 'validation_failed',
      message: expect.any(String),
      fields: [
        { field: 'fullName', code: 'too_short' },
        { field: 'phone', code: 'invalid_phone' },
        { field: 'email', code: 'invalid_email' },
        { field: 'password', code: 'too_short' },
        { field: 'device.platform', code: 'invalid_value' },
        { field: 'device.appVersion', code: 'too_long' },
        { field: 'device.installId', code: 'invalid_value' },
      ],
    });
    expect(await countRows('users')).toBe(0);
  });

  it('an unknown field → 400 validation_failed', async () => {
    const { app } = await setup();
    const res = await signup(app, { ...bodyFor(1), role: 'admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.fields).toEqual([{ field: 'role', code: 'invalid_value' }]);
    expect(await countRows('users')).toBe(0);
  });

  it('a body that is not JSON → 400 malformed_request', async () => {
    const { app } = await setup();
    const res = await signup(app, undefined, { raw: '{' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
  });

  it('invalid requests are not counted toward any limit', async () => {
    const { app } = await setup();
    for (let i = 0; i < 6; i++)
      expect((await signup(app, bodyFor(1, { password: 'short' }))).statusCode).toBe(400);
    expect(await countRows('signup_phone_attempts')).toBe(0);
    expect((await signup(app, bodyFor(1))).statusCode).toBe(201);
  });
});

describe('uniqueness', () => {
  it('a duplicate email → 409 email_taken, whatever its case or spacing', async () => {
    const { app } = await setup();
    expect((await signup(app, bodyFor(1, { email: 'ada@example.com' }))).statusCode).toBe(201);
    const res = await signup(app, bodyFor(2, { email: ' ADA@Example.com ' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'email_taken', message: expect.any(String) } });
    expect(await countRows('users')).toBe(1);
  });

  it('a duplicate phone → 409 phone_taken', async () => {
    const { app } = await setup();
    expect((await signup(app, bodyFor(1))).statusCode).toBe(201);
    const res = await signup(app, bodyFor(1, { email: 'other@example.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('phone_taken');
    expect(await countRows('users')).toBe(1);
  });

  it('both taken (by the same or by different accounts) → email_taken', async () => {
    const { app } = await setup();
    expect((await signup(app, bodyFor(1))).statusCode).toBe(201);
    expect((await signup(app, bodyFor(2))).statusCode).toBe(201);
    const same = await signup(app, bodyFor(1, { fullName: 'Someone Else' }));
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('email_taken');
    const crossed = await signup(app, bodyFor(1, { email: bodyFor(2).email }));
    expect(crossed.statusCode).toBe(409);
    expect(crossed.json().error.code).toBe('email_taken');
  });

  it('a refused sign-up leaves no session, family or idempotency row behind', async () => {
    const { app } = await setup();
    await signup(app, bodyFor(1));
    await signup(app, bodyFor(1));
    expect(await countRows('users')).toBe(1);
    expect(await countRows('token_families')).toBe(1);
    expect(await countRows('signup_idempotency')).toBe(1);
  });
});

describe('idempotency', () => {
  it('the same key and body → 201 with the same user, a new session, and one user row', async () => {
    const { app, ctx } = await setup();
    const key = randomUUID();
    const first = await signup(app, bodyFor(1), { key });
    const second = await signup(app, bodyFor(1), { key });
    expect(second.statusCode).toBe(201);
    expect(second.json().user).toEqual(first.json().user);
    expect(second.json().session.refreshToken).not.toBe(first.json().session.refreshToken);
    const check = verifyAccessToken(keys.access, second.json().session.accessToken, ctx.clock.now());
    expect(check.kind).toBe('valid');
    if (check.kind === 'valid') expect(check.claims.sub).toBe(first.json().user.id);
    expect(await countRows('users')).toBe(1);
    expect(await countRows('signup_idempotency')).toBe(1);
    // Each answer is a session of its own.
    expect(await countRows('token_families')).toBe(2);
  });

  it('a body that normalises to the same input is the same body', async () => {
    const { app } = await setup();
    const key = randomUUID();
    const first = await signup(app, bodyFor(1, { email: 'ada@example.com' }), { key });
    const second = await signup(app, bodyFor(1, { email: '  ADA@example.com ', fullName: ' Ada Okafor' }), {
      key,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().user.id).toBe(first.json().user.id);
  });

  it.each([
    ['the password', { password: 'another password entirely' }],
    ['the name', { fullName: 'Someone Else' }],
    [
      'the device',
      { device: { platform: 'ios', appVersion: '0.3.0', installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b' } },
    ],
  ])('the same key with a different %s → 422 idempotency_key_reused', async (_name, change) => {
    const { app } = await setup();
    const key = randomUUID();
    expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(201);
    const res = await signup(app, bodyFor(1, change), { key });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: { code: 'idempotency_key_reused', message: expect.any(String) } });
    expect(await countRows('users')).toBe(1);
  });

  it('the same key with a body for another person → 422, and that person is not created', async () => {
    const { app } = await setup();
    const key = randomUUID();
    await signup(app, bodyFor(1), { key });
    expect((await signup(app, bodyFor(2), { key })).statusCode).toBe(422);
    expect(await countRows('users')).toBe(1);
  });

  it('a replay is checked after validation: an invalid body is 400, not a replay', async () => {
    const { app } = await setup();
    const key = randomUUID();
    await signup(app, bodyFor(1), { key });
    const res = await signup(app, bodyFor(1, { password: 'short' }), { key });
    expect(res.statusCode).toBe(400);
  });

  it('a replay just inside 24 h still answers; the key is free from 24 h on', async () => {
    const { app, ctx } = await setup();
    const key = randomUUID();
    const first = await signup(app, bodyFor(1), { key });
    ctx.clock.advance(DAY - 1000);
    const replay = await signup(app, bodyFor(1), { key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().user.id).toBe(first.json().user.id);

    ctx.clock.advance(1000);
    // 24 h after the first answer: the old row is ignored, so a different body is a new sign-up.
    const fresh = await signup(app, bodyFor(2), { key });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().user.id).not.toBe(first.json().user.id);
    expect(await countRows('users')).toBe(2);
    // The stale row was upserted over, not duplicated.
    const rows = await testDb().selectFrom('signup_idempotency').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(fresh.json().user.id);
    expect(rows[0]?.created_at.getTime()).toBe(ctx.clock.now().getTime());
  });

  it('after 24 h the same key and body is a new attempt, so a taken email is a 409', async () => {
    const { app, ctx } = await setup();
    const key = randomUUID();
    await signup(app, bodyFor(1), { key });
    ctx.clock.advance(DAY + 1000);
    const res = await signup(app, bodyFor(1), { key });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  it('a key that was refused (409) is not stored, so it can be reused for a corrected body', async () => {
    const { app } = await setup();
    await signup(app, bodyFor(1));
    const key = randomUUID();
    expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(409);
    expect((await signup(app, bodyFor(2), { key })).statusCode).toBe(201);
  });
});

describe('rate limits', () => {
  it('the 6th sign-up request per IP per hour → 429 with retryAfterSeconds', async () => {
    const { app, ctx } = await setup();
    for (let n = 1; n <= 5; n++) expect((await signup(app, bodyFor(n))).statusCode).toBe(201);
    ctx.clock.advance(10 * MINUTE);
    const res = await signup(app, bodyFor(6));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: { code: 'rate_limited', message: expect.any(String), retryAfterSeconds: 50 * 60 },
    });
    expect(res.headers['retry-after']).toBe(String(50 * 60));
    expect(await countRows('users')).toBe(5);
    // Not recorded against the phone.
    expect(await countRows('signup_phone_attempts')).toBe(5);
  });

  it('counts every non-replay attempt that passed validation, 409s included', async () => {
    const { app } = await setup();
    expect((await signup(app, bodyFor(1))).statusCode).toBe(201);
    for (let n = 2; n <= 5; n++)
      expect((await signup(app, bodyFor(n, { email: 'user1@example.com' }))).statusCode).toBe(409);
    expect((await signup(app, bodyFor(6))).statusCode).toBe(429);
  });

  it('another IP is not affected, and the window reopens after an hour', async () => {
    const { app, ctx } = await setup();
    for (let n = 1; n <= 5; n++) await signup(app, bodyFor(n));
    expect((await signup(app, bodyFor(6))).statusCode).toBe(429);
    expect((await signup(app, bodyFor(6), { ip: '198.51.100.7' })).statusCode).toBe(201);
    ctx.clock.advance(HOUR);
    expect((await signup(app, bodyFor(7))).statusCode).toBe(201);
  });

  it('idempotent replays do not count toward the IP limit', async () => {
    const { app } = await setup();
    const key = randomUUID();
    expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(201);
    for (let i = 0; i < 4; i++) expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(201);
    // 5 requests so far, but only one counted: four more new sign-ups fit.
    for (let n = 2; n <= 5; n++) expect((await signup(app, bodyFor(n))).statusCode).toBe(201);
    expect((await signup(app, bodyFor(6))).statusCode).toBe(429);
  });

  it('a 422 (same key, different body) is not counted either', async () => {
    const { app } = await setup();
    const key = randomUUID();
    await signup(app, bodyFor(1), { key });
    for (let i = 0; i < 4; i++)
      expect((await signup(app, bodyFor(1, { fullName: `Other ${i}` }), { key })).statusCode).toBe(422);
    for (let n = 2; n <= 5; n++) expect((await signup(app, bodyFor(n))).statusCode).toBe(201);
  });

  it('the 4th attempt per phone per day → 429, with the time until the oldest attempt leaves the window', async () => {
    const { app, ctx } = await setup();
    const phone = bodyFor(1).phone;
    expect((await signup(app, bodyFor(1))).statusCode).toBe(201);
    ctx.clock.advance(HOUR);
    expect((await signup(app, bodyFor(2, { phone }))).statusCode).toBe(409); // phone_taken counts
    ctx.clock.advance(HOUR);
    expect((await signup(app, bodyFor(3, { phone }))).statusCode).toBe(409);
    ctx.clock.advance(HOUR);
    const res = await signup(app, bodyFor(4, { phone }));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: { code: 'rate_limited', message: expect.any(String), retryAfterSeconds: 21 * 60 * 60 },
    });
    expect(res.headers['retry-after']).toBe(String(21 * 60 * 60));
    // The refused request is not recorded, so the limit does not stretch while the client keeps trying.
    expect(await countRows('signup_phone_attempts')).toBe(3);

    // A different phone is not affected.
    expect((await signup(app, bodyFor(5))).statusCode).toBe(201);

    // 21 h on, the first attempt is 24 h old and leaves the window.
    ctx.clock.advance(21 * HOUR);
    expect((await signup(app, bodyFor(4, { phone }))).statusCode).toBe(409);
  });

  it('stores only a keyed hash of the phone', async () => {
    const { app, ctx } = await setup();
    await signup(app, bodyFor(1));
    const rows = await testDb().selectFrom('signup_phone_attempts').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone_hash).toBe(phoneHash(ctx.config.phoneHashSecret, bodyFor(1).phone));
    expect(rows[0]?.phone_hash).not.toContain('2348031230001');
    expect(rows[0]?.created_at.getTime()).toBe(ctx.clock.now().getTime());
  });

  it('replays do not count toward the phone limit', async () => {
    const { app } = await setup();
    const key = randomUUID();
    expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(201);
    for (let i = 0; i < 3; i++) expect((await signup(app, bodyFor(1), { key })).statusCode).toBe(201);
    expect(await countRows('signup_phone_attempts')).toBe(1);
    const phone = bodyFor(1).phone;
    expect((await signup(app, bodyFor(2, { phone }))).statusCode).toBe(409);
    expect((await signup(app, bodyFor(3, { phone }))).statusCode).toBe(409);
    expect((await signup(app, bodyFor(4, { phone }))).statusCode).toBe(429);
  });
});

describe('concurrency', () => {
  it('identical concurrent requests (same key, same body) → one user, every answer the same user', async () => {
    const { app } = await setup();
    const key = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => signup(app, bodyFor(1), { key })));
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.json().user.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.json().session.refreshToken)).size).toBe(3);
    expect(await countRows('users')).toBe(1);
    expect(await countRows('signup_idempotency')).toBe(1);
  });

  it('concurrent same-key requests with different bodies: one 201, the rest 422', async () => {
    const { app } = await setup();
    const key = randomUUID();
    const results = await Promise.all([1, 2, 3].map((n) => signup(app, bodyFor(n), { key })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422, 422]);
    expect(await countRows('users')).toBe(1);
  });

  it('concurrent sign-ups for one email under different keys: one 201, the rest email_taken', async () => {
    const { app } = await setup();
    const results = await Promise.all([1, 2, 3].map(() => signup(app, bodyFor(1))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json().error.code).toBe('email_taken');
    expect(await countRows('users')).toBe(1);
  });

  it('concurrent sign-ups for one email with different phones: one 201, the rest email_taken', async () => {
    const { app } = await setup();
    const email = bodyFor(1).email;
    const results = await Promise.all([1, 2, 3].map((n) => signup(app, bodyFor(n, { email }))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json().error.code).toBe('email_taken');
    expect(await countRows('users')).toBe(1);
  });

  it('concurrent sign-ups for one phone with different emails: one 201, the rest phone_taken', async () => {
    const { app } = await setup();
    const phone = bodyFor(1).phone;
    const results = await Promise.all([1, 2, 3].map((n) => signup(app, bodyFor(n, { phone }))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json().error.code).toBe('phone_taken');
    expect(await countRows('users')).toBe(1);
  });

  it('concurrent attempts on one phone never exceed the daily limit', async () => {
    const { app } = await setup();
    const phone = bodyFor(1).phone;
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => signup(app, bodyFor(n, { phone }))));
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(2);
    expect(await countRows('signup_phone_attempts')).toBe(3);
  });
});

describe('logs', () => {
  it('name the user by id only: no body field, header value or password reaches the log', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) });
    const { app } = await setup({ log });
    const key = randomUUID();
    const body = bodyFor(1, { fullName: 'Distinctive Name', password: 'a very distinctive password' });
    const res = await signup(app, body, { key });
    const again = await signup(app, body, { key });
    await signup(app, bodyFor(1, { fullName: 'Other Name' }), { key }); // 422
    await signup(app, bodyFor(1, { email: 'second@example.com' })); // 409
    const out = lines.join('\n');
    expect(out).toContain(res.json().user.id);
    expect(again.statusCode).toBe(201);
    for (const secret of [
      'Distinctive Name',
      'a very distinctive password',
      body.email,
      'second@example.com',
      body.phone,
      key,
      res.json().session.accessToken,
      res.json().session.refreshToken,
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});
