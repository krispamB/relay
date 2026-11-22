/**
 * The two kinds of bearer token are never accepted for each other (docs/auth-contract.md §7, last item),
 * and with AUTH_ENABLED off no auth route exists (docs/auth-implementation-plan.md, "Decisions").
 *
 * Everything goes through app.inject against real Postgres. The last block runs the SOS path with
 * auth switched on, a representative slice of "the whole suite passes with auth on"; the rest is
 * `TEST_AUTH_ENABLED=true npm test` (README).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { issueSession } from '../../src/auth/sessions.js';
import { FakeClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { closeTestDb, createTestContext, markHealthy, resetDb, testConfig } from '../helpers/context.js';
import { seedDevice } from '../helpers/seed.js';
import { postSos, sosBody } from '../sos/helpers.js';

const SECRET = 'auth-token-secret-for-tests-0123456789ab';
const keys = deriveAuthKeys(SECRET);
const device = {
  platform: 'android' as const,
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
};

const open: PublicApp[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});
afterAll(() => closeTestDb());
beforeEach(() => resetDb());

function config(authEnabled: boolean): Config {
  const base = testConfig();
  return { ...base, auth: { enabled: authEnabled, tokenSecret: SECRET } };
}

async function setup(authEnabled: boolean) {
  const ctx = createTestContext({
    clock: new FakeClock('2026-11-18T12:00:00.000Z'),
    config: config(authEnabled),
  });
  await markHealthy(ctx);
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { app, ctx };
}

/** A user with a live session, inserted directly: no sign-up route needed. */
async function seedSession(ctx: ReturnType<typeof createTestContext>) {
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('users')
    .values({
      id: 'user-1',
      full_name: 'Ada Okafor',
      phone: '+2348031234567',
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const { session } = await issueSession(ctx.db, keys, { userId: 'user-1', device, now });
  return session;
}

describe('with auth enabled', () => {
  it('answers 401 invalid_token to a valid relay device token on GET /v1/me', async () => {
    const { app, ctx } = await setup(true);
    const { token } = await seedDevice(ctx);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
  });

  it('answers 401 invalid_token to a device token on POST /v1/auth/signout too', async () => {
    const { app, ctx } = await setup(true);
    const { token } = await seedDevice(ctx);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signout',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ refreshToken: 'rt_whatever' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
  });

  it("answers 401 unauthorized, the relay's code, to a valid access token on POST /v1/sos", async () => {
    const { app, ctx } = await setup(true);
    const session = await seedSession(ctx);
    // Control: the access token is good where it belongs.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    const res = await postSos(app, { token: session.accessToken, body: sosBody(ctx) });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('serves GET /v1/intake/:code the same with or without an access token', async () => {
    const { app, ctx } = await setup(true);
    const session = await seedSession(ctx);
    const url = '/v1/intake/TEST-DEPT';

    const plain = await app.inject({ method: 'GET', url });
    const withToken = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(plain.statusCode).toBe(200);
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json()).toEqual(plain.json());
    expect(plain.json().available).toBe(true);
  });

  it('keeps the SOS path working: register a device, read the intake, send an SOS', async () => {
    const { app, ctx } = await setup(true);

    const nonceRes = await app.inject({ method: 'GET', url: '/v1/devices/nonce' });
    expect(nonceRes.statusCode).toBe(200);
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ platform: 'android', nonce: nonceRes.json().nonce }),
    });
    expect(reg.statusCode).toBe(201);
    const { deviceToken } = reg.json() as { deviceToken: string };

    // The relay's own error bodies are unchanged next to the auth plugin's: a bad token is `unauthorized`.
    const refused = await postSos(app, { token: `${deviceToken}x`, body: sosBody(ctx) });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('unauthorized');

    // The SOS itself is accepted for delivery (Core is not reachable in this test: 201 or 202, never 4xx).
    const res = await postSos(app, { token: deviceToken, key: randomUUID(), body: sosBody(ctx) });
    expect([201, 202]).toContain(res.status);
    const unknownRoute = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.json().error.code).toBe('not_found');
  });
});

describe('with auth disabled', () => {
  const routes: [method: 'GET' | 'POST', url: string][] = [
    ['POST', '/v1/auth/signup'],
    ['POST', '/v1/auth/refresh'],
    ['POST', '/v1/auth/signout'],
    ['POST', '/v1/auth/signin'],
    ['GET', '/v1/me'],
  ];

  it.each(routes)('answers 404 not_found on %s %s', async (method, url) => {
    const { app } = await setup(false);

    const res = await app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });
});
