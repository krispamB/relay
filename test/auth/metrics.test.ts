/**
 * Auth counters (docs/auth-implementation-plan.md slice 7). Labels are the outcome only.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { REFRESH_PER_FAMILY_PER_HOUR } from '../../src/auth/routes/refresh.js';
import { issueSession, revokeFamily, type Session } from '../../src/auth/sessions.js';
import { FakeClock } from '../../src/clock.js';
import { createPromMetrics } from '../../src/metrics/prom.js';
import { METRICS } from '../../src/metrics.js';
import { closeTestDb, createTestContext, resetDb, type TestContext, testConfig } from '../helpers/context.js';
import { RecordingMetrics } from '../sos/helpers.js';

const START = '2026-11-18T12:00:00.000Z';
const SECRET = 'auth-token-secret-for-tests-0123456789ab';
const keys = deriveAuthKeys(SECRET);
const device = {
  platform: 'android' as const,
  appVersion: '0.3.0',
  installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
};

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function setup() {
  const metrics = new RecordingMetrics();
  const clock = new FakeClock(START);
  const base = testConfig();
  const ctx = createTestContext({
    clock,
    metrics,
    config: {
      ...base,
      auth: { enabled: true, tokenSecret: SECRET },
      limits: { ...base.limits, requestsPerIpPerMinute: 10_000 },
    },
  });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { app, ctx, clock, metrics };
}

let userSeq = 0;
async function insertUser(ctx: TestContext) {
  userSeq += 1;
  const id = `00000000-0000-4000-8000-${String(userSeq).padStart(12, '0')}`;
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone: `+234803${String(userSeq).padStart(7, '0')}`,
      email: `metrics${userSeq}@example.com`,
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function signIn(ctx: TestContext) {
  const userId = await insertUser(ctx);
  return issueSession(ctx.db, keys, { userId, device, now: ctx.clock.now() });
}

const signupBody = (n: number) => ({
  fullName: 'Ada Okafor',
  phone: `+234803123${String(n).padStart(4, '0')}`,
  email: `signup${n}@example.com`,
  password: 'correct horse battery staple',
  device,
});

function postSignup(app: FastifyInstance, body: unknown, key: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-real-ip': '203.0.113.8' },
    payload: JSON.stringify(body),
  });
}

function postRefresh(app: FastifyInstance, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
    payload: JSON.stringify({ refreshToken }),
  });
}

function postSignout(app: FastifyInstance, accessToken: string, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'x-real-ip': '203.0.113.10',
    },
    payload: JSON.stringify({ refreshToken }),
  });
}

const unknownToken = `rt_${'a'.repeat(43)}`;

describe('auth metrics', () => {
  it('counts a sign-up as created and the same key again as replay', async () => {
    const { app, metrics } = await setup();
    const key = randomUUID();
    const created = await postSignup(app, signupBody(1), key);
    const replay = await postSignup(app, signupBody(1), key);
    const invalid = await postSignup(app, { ...signupBody(2), password: 'short' }, randomUUID());

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(invalid.statusCode).toBe(400);
    expect(metrics.count(METRICS.authSignups, { result: 'created' })).toBe(1);
    expect(metrics.count(METRICS.authSignups, { result: 'replay' })).toBe(1);
    expect(metrics.count(METRICS.authSignups)).toBe(2);
  });

  it('counts a rotation and the grace-window replay of the same parent', async () => {
    const { app, ctx, metrics } = await setup();
    const { session } = await signIn(ctx);
    const rotated = await postRefresh(app, session.refreshToken);
    const grace = await postRefresh(app, session.refreshToken);

    expect(rotated.statusCode).toBe(200);
    expect(grace.statusCode).toBe(200);
    expect((grace.json() as { session: Session }).session.refreshToken).toBe(
      (rotated.json() as { session: Session }).session.refreshToken,
    );
    expect(metrics.count(METRICS.authRefreshes, { result: 'rotated' })).toBe(1);
    expect(metrics.count(METRICS.authRefreshes, { result: 'grace' })).toBe(1);
  });

  it('counts reuse after the grace window, a revoked family, and an unknown token', async () => {
    const { app, ctx, clock, metrics } = await setup();
    const reused = await signIn(ctx);
    const rotated = await postRefresh(app, reused.session.refreshToken);
    expect(rotated.statusCode).toBe(200);
    clock.advanceSeconds(31);
    const reuse = await postRefresh(app, reused.session.refreshToken);
    expect(reuse.statusCode).toBe(401);

    const revoked = await signIn(ctx);
    await revokeFamily(ctx.db, revoked.familyId, ctx.clock.now());
    const revokedRes = await postRefresh(app, revoked.session.refreshToken);
    expect(revokedRes.statusCode).toBe(401);

    const invalid = await postRefresh(app, unknownToken);
    expect(invalid.statusCode).toBe(401);

    expect(metrics.count(METRICS.authRefreshes, { result: 'rotated' })).toBe(1);
    expect(metrics.count(METRICS.authRefreshes, { result: 'reuse_detected' })).toBe(1);
    expect(metrics.count(METRICS.authRefreshes, { result: 'revoked' })).toBe(1);
    expect(metrics.count(METRICS.authRefreshes, { result: 'invalid' })).toBe(1);
  });

  it('counts the request that crosses the per-family limit as rate_limited', async () => {
    const { app, ctx, metrics } = await setup();
    const { session } = await signIn(ctx);
    let token = session.refreshToken;
    for (let i = 0; i < REFRESH_PER_FAMILY_PER_HOUR; i++) {
      const res = await postRefresh(app, token);
      expect(res.statusCode).toBe(200);
      token = (res.json() as { session: Session }).session.refreshToken;
    }
    const limited = await postRefresh(app, token);
    expect(limited.statusCode).toBe(429);
    expect(metrics.count(METRICS.authRefreshes, { result: 'rotated' })).toBe(REFRESH_PER_FAMILY_PER_HOUR);
    expect(metrics.count(METRICS.authRefreshes, { result: 'rate_limited' })).toBe(1);
  });

  it('counts a sign-out that revokes the family, and a second call that changes nothing', async () => {
    const { app, ctx, metrics } = await setup();
    const { session } = await signIn(ctx);
    const revoked = await postSignout(app, session.accessToken, session.refreshToken);
    const again = await postSignout(app, session.accessToken, session.refreshToken);
    const unknown = await postSignout(app, session.accessToken, unknownToken);

    expect(revoked.statusCode).toBe(204);
    expect(again.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(metrics.count(METRICS.authSignouts, { result: 'revoked' })).toBe(1);
    expect(metrics.count(METRICS.authSignouts, { result: 'noop' })).toBe(2);
  });

  it('registers the auth counters with a result label and nothing else', async () => {
    const m = createPromMetrics();
    m.inc(METRICS.authSignups, { result: 'created' });
    m.inc(METRICS.authSignups, { result: 'replay' });
    m.inc(METRICS.authRefreshes, { result: 'rotated' });
    m.inc(METRICS.authSignouts, { result: 'noop' });
    m.inc(METRICS.authSignins, { result: 'success' });
    const out = await m.render();
    expect(out).toContain('# TYPE auth_signups_total counter');
    expect(out).toContain('auth_signups_total{result="created"} 1');
    expect(out).toContain('auth_signups_total{result="replay"} 1');
    expect(out).toContain('# TYPE auth_refreshes_total counter');
    expect(out).toContain('auth_refreshes_total{result="rotated"} 1');
    expect(out).toContain('# TYPE auth_signouts_total counter');
    expect(out).toContain('auth_signouts_total{result="noop"} 1');
    expect(out).toContain('# TYPE auth_signins_total counter');
    expect(out).toContain('auth_signins_total{result="success"} 1');
  });
});
