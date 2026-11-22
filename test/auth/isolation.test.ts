/**
 * One token on every app route (docs/live-sos-plan.md D2, D20): the access token from sign-up works on
 * `GET /v1/me`, `POST /v1/sos` and the status route, and auth is always mounted.
 *
 * Everything goes through app.inject against real Postgres: sign up, read the intake, send an SOS
 * with the account's token, read its status.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import { closeTestDb, createTestContext, markHealthy, resetDb } from '../helpers/context.js';
import { postSos, sosBody } from '../sos/helpers.js';

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

async function setup() {
  const ctx = createTestContext({ clock: new FakeClock('2026-11-18T12:00:00.000Z') });
  await markHealthy(ctx);
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { app, ctx };
}

async function signUp(app: PublicApp) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: JSON.stringify({
      fullName: 'Ada Okafor',
      phone: '+2348031234567',
      password: 'correct horse battery staple',
      device,
    }),
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { user: { id: string }; session: { accessToken: string } };
}

describe('auth is always on', () => {
  it.each([
    ['POST', '/v1/auth/signup'],
    ['POST', '/v1/auth/signin'],
    ['POST', '/v1/auth/refresh'],
    ['POST', '/v1/auth/signout'],
    ['GET', '/v1/me'],
  ] as const)('%s %s is mounted (never the relay 404)', async (method, url) => {
    const { app } = await setup();
    const res = await app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    });
    expect(res.statusCode).not.toBe(404);
  });
});

describe('the SOS path with the account token', () => {
  it('sign up, read the intake, send an SOS and read its status with one access token', async () => {
    const { app, ctx } = await setup();
    const { user, session } = await signUp(app);
    const bearer = { authorization: `Bearer ${session.accessToken}` };

    const intake = await app.inject({ method: 'GET', url: '/v1/intake/TEST-DEPT', headers: bearer });
    expect(intake.statusCode).toBe(200);
    expect(intake.json().available).toBe(true);

    // Core is not reachable in this test: 201 or 202, never 4xx.
    const sos = await postSos(app, { token: session.accessToken, key: randomUUID(), body: sosBody(ctx) });
    expect([201, 202]).toContain(sos.status);
    const row = await ctx.db
      .selectFrom('submissions')
      .select(['user_id', 'phone'])
      .where('id', '=', sos.body.receiptId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ user_id: user.id, phone: '+2348031234567' });

    const status = await app.inject({
      method: 'GET',
      url: `/v1/sos/${sos.body.receiptId}/status`,
      headers: bearer,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().reference).toBe(sos.body.reference);
  });

  it('keeps the relay error bodies on the SOS routes next to the auth plugin', async () => {
    const { app, ctx } = await setup();
    const { session } = await signUp(app);
    const bad = await postSos(app, { token: session.accessToken, body: { ...sosBody(ctx), extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    const unknownRoute = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.json().error.code).toBe('not_found');
  });
});
