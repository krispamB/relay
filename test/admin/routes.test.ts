import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminApp } from '../../src/admin/app.js';
import { DAY } from '../../src/clock.js';
import type { CoreClient } from '../../src/core/types.js';
import { phoneHash } from '../../src/crypto.js';
import { createPromMetrics } from '../../src/metrics/prom.js';
import { METRICS } from '../../src/metrics.js';
import { getState, pauseDelivery } from '../../src/state.js';
import { insertSubmission } from '../delivery/fixtures.js';
import {
  closeTestDb,
  createTestContext,
  markHealthy,
  resetDb,
  testConfig,
  unusedCore,
} from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const AUTH = { authorization: `Bearer ${testConfig().adminToken}` };
const PHONE = '+2348012345678';

async function setup(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const ctx = createTestContext(overrides);
  const app = await buildAdminApp(ctx);
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: AUTH, ...(payload ? { payload } : {}) });
  return { ctx, app, call };
}

function coreWith(result: Awaited<ReturnType<CoreClient['getFieldPolicy']>>): CoreClient & { n: number } {
  const c = {
    ...unusedCore(),
    n: 0,
    async getFieldPolicy() {
      c.n++;
      return result;
    },
  };
  return c;
}

describe('admin auth', () => {
  const routes: Array<['GET' | 'POST' | 'DELETE', string]> = [
    ['GET', '/admin/v1/health'],
    ['POST', '/admin/v1/delivery/pause'],
    ['POST', '/admin/v1/delivery/resume'],
    ['GET', '/admin/v1/submissions/SOS-AAAA'],
    ['GET', '/admin/v1/blocks'],
    ['POST', '/admin/v1/blocks'],
    ['DELETE', '/admin/v1/blocks/blk_1'],
    ['POST', '/admin/v1/erasure'],
    ['GET', '/metrics'],
  ];
  it.each(routes)('%s %s needs the token', async (method, url) => {
    const { app } = await setup();
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    const wrong = await app.inject({ method, url, headers: { authorization: 'Bearer wrong' } });
    expect(wrong.statusCode).toBe(401);
  });
});

describe('health', () => {
  it('reports the paused case', async () => {
    const { ctx, call } = await setup();
    await markHealthy(ctx);
    await pauseDelivery(ctx.db, ctx.clock.now(), 'Core returned 401 on SaveCall');
    const body = (await call('GET', '/admin/v1/health')).json();
    expect(body.paused).toBe(true);
    expect(body.pausedReason).toBe('Core returned 401 on SaveCall');
    expect(body.pausedAt).toBe(ctx.clock.now().toISOString());
    expect(body.available).toBe(false);
    expect(body.unavailableReason).toBe('paused');
  });

  it('reports the unhealthy case with required flags', async () => {
    const { ctx, call } = await setup();
    await ctx.db
      .updateTable('relay_state')
      .set({
        check_status: 'unhealthy',
        check_detail: 'policy needs phone',
        check_at: ctx.clock.now(),
        required_name: true,
      })
      .execute();
    const body = (await call('GET', '/admin/v1/health')).json();
    expect(body.available).toBe(false);
    expect(body.unavailableReason).toBe('unhealthy');
    expect(body.check).toMatchObject({ status: 'unhealthy', detail: 'policy needs phone' });
    expect(body.required).toEqual({ location: false, address: false, name: true });
  });

  it('reports the healthy case with queue figures and key expiry', async () => {
    const config = testConfig({ resgrid: { ...testConfig().resgrid, apiKeyExpiresOn: '2026-12-17' } });
    const { ctx, call } = await setup({ config });
    await markHealthy(ctx);
    const t = ctx.clock.now();
    await insertSubmission(ctx.db, new Date(t.getTime() - 90_000));
    await insertSubmission(ctx.db, new Date(t.getTime() - 10_000));
    await insertSubmission(ctx.db, new Date(t.getTime() - 500_000), { is_demo: true });
    await insertSubmission(ctx.db, t, { status: 'received' });
    const body = (await call('GET', '/admin/v1/health')).json();
    expect(body.available).toBe(true);
    expect(body.unavailableReason).toBeNull();
    expect(body.paused).toBe(false);
    expect(body.queue).toEqual({ depth: 2, oldestAgeSeconds: 90 });
    expect(body.openSubmissions).toEqual({ queued: 2, received: 1, dispatched: 0 });
    // 12:00 on 17 Nov to 00:00 on 17 Dec is 29 whole days and a half.
    expect(body.resgridKey).toEqual({ expiresOn: '2026-12-17', daysRemaining: 29 });
  });

  it('has a null oldest age when nothing is queued', async () => {
    const { call } = await setup();
    expect((await call('GET', '/admin/v1/health')).json().queue).toEqual({
      depth: 0,
      oldestAgeSeconds: null,
    });
  });
});

describe('pause and resume', () => {
  it('pauses by hand, with and without a reason', async () => {
    const metrics = createPromMetrics();
    const { ctx, call } = await setup({ metrics });
    const res = await call('POST', '/admin/v1/delivery/pause', { reason: 'maintenance' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paused: true, pausedReason: 'Paused by an operator: maintenance' });
    expect((await getState(ctx.db)).paused).toBe(true);
    expect(ctx.alerts.codes()).toEqual(['delivery_paused']);
    expect(await metrics.render()).toContain('sos_delivery_paused 1');
    // second call, no body at all: already paused, no second alert
    const again = await call('POST', '/admin/v1/delivery/pause');
    expect(again.statusCode).toBe(200);
    expect(ctx.alerts.codes()).toEqual(['delivery_paused']);
  });

  it('pauses with no body and refuses a bad reason', async () => {
    const { ctx, call } = await setup();
    expect((await call('POST', '/admin/v1/delivery/pause', { reason: 5 })).statusCode).toBe(400);
    const res = await call('POST', '/admin/v1/delivery/pause');
    expect(res.statusCode).toBe(200);
    expect(res.json().pausedReason).toBe('Paused by an operator');
    expect((await getState(ctx.db)).paused).toBe(true);
  });

  it('resumes when Core accepts the key', async () => {
    const core = coreWith({ kind: 'ok', data: { requiredKeys: [] } });
    const { ctx, call } = await setup({ core });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'x');
    const res = await call('POST', '/admin/v1/delivery/resume');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paused: false, pausedReason: null, pausedAt: null });
    expect((await getState(ctx.db)).paused).toBe(false);
  });

  it('stays paused with 409 when Core refuses the key', async () => {
    const core = coreWith({ kind: 'auth', httpStatus: 401 });
    const { ctx, call } = await setup({ core });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'x');
    const res = await call('POST', '/admin/v1/delivery/resume');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('core_auth_failed');
    expect((await getState(ctx.db)).paused).toBe(true);
  });

  it('stays paused with 503 when Core is unreachable', async () => {
    const core = coreWith({ kind: 'retryable', reason: 'timeout' });
    const { ctx, call } = await setup({ core });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'x');
    const res = await call('POST', '/admin/v1/delivery/resume');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('core_unreachable');
    expect((await getState(ctx.db)).paused).toBe(true);
  });

  it('resuming when not paused is a harmless 200 that does not call Core', async () => {
    const core = coreWith({ kind: 'auth', httpStatus: 401 });
    const { call } = await setup({ core });
    const res = await call('POST', '/admin/v1/delivery/resume');
    expect(res.statusCode).toBe(200);
    expect(res.json().paused).toBe(false);
    expect(core.n).toBe(0);
  });
});

describe('submissions view', () => {
  it('shows status data and no personal fields', async () => {
    const { ctx, call } = await setup();
    const id = await insertSubmission(ctx.db, ctx.clock.now(), {
      status: 'received',
      reference: 'SOS-K7M2',
      phone: '+2348099998888',
      address: '12 Marigold Crescent',
      ip: '198.51.100.77',
      lat: 6.123456,
      lon: 3.654321,
      core_call_id: '48213',
      attempts: 2,
    });
    await ctx.db
      .insertInto('submission_events')
      .values({
        submission_id: id,
        from_status: 'queued',
        to_status: 'received',
        cause: 'delivered',
        at: ctx.clock.now(),
      })
      .execute();
    const res = await call('GET', '/admin/v1/submissions/SOS-K7M2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'received',
      attempts: 2,
      coreCallId: '48213',
      isDemo: false,
      receiptId: id,
    });
    expect(body.events).toHaveLength(1);
    for (const secret of ['8099998888', 'Marigold', '198.51.100.77', '6.123456', '3.654321']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('returns only safe failure categories', async () => {
    const { ctx, call } = await setup();
    const base = ctx.clock.now();
    await insertSubmission(ctx.db, base, {
      status: 'failed',
      reference: 'SOS-AAAA',
      failure_reason: 'not delivered within 30 minutes',
    });
    await insertSubmission(ctx.db, base, {
      status: 'failed',
      reference: 'SOS-BBBB',
      failure_reason: 'Core rejected the call: HTTP 400: bad Name Zainab Okonkwo',
    });
    await insertSubmission(ctx.db, base, {
      status: 'failed',
      reference: 'SOS-CCCC',
      failure_reason: 'something with Zainab',
    });
    expect((await call('GET', '/admin/v1/submissions/SOS-AAAA')).json().failureReason).toBe(
      'not delivered within 30 minutes',
    );
    const b = await call('GET', '/admin/v1/submissions/SOS-BBBB');
    expect(b.json().failureReason).toBe('Core rejected the call: HTTP 400');
    expect(b.body).not.toContain('Zainab');
    const c = await call('GET', '/admin/v1/submissions/SOS-CCCC');
    expect(c.json().failureReason).toBe('delivery failed');
    expect(c.body).not.toContain('Zainab');
  });

  it('404s for an unknown reference', async () => {
    const { call } = await setup();
    expect((await call('GET', '/admin/v1/submissions/SOS-ZZZZ')).statusCode).toBe(404);
  });
});

describe('blocks', () => {
  it('blocks a user id, default duration from config', async () => {
    const { ctx, call } = await setup();
    const res = await call('POST', '/admin/v1/blocks', { userId: 'usr_abc', reason: 'abuse' });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ subjectType: 'user', subject: 'usr_abc', source: 'manual', reason: 'abuse' });
    expect(new Date(b.expiresAt).getTime() - ctx.clock.now().getTime()).toBe(
      ctx.config.limits.blockTtlDays * DAY,
    );
  });

  it('blocks a phone number by hash only', async () => {
    const { ctx, call } = await setup();
    const res = await call('POST', '/admin/v1/blocks', {
      phone: '+234 801 234 5678',
      reason: 'hoax',
      days: 2,
    });
    expect(res.statusCode).toBe(201);
    const hash = phoneHash(ctx.config.phoneHashSecret, PHONE);
    expect(res.json()).toMatchObject({ subjectType: 'phone', subject: hash });
    expect(new Date(res.json().expiresAt).getTime() - ctx.clock.now().getTime()).toBe(2 * DAY);
    const rows = await ctx.db.selectFrom('blocks').selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain('8012345678');
    expect(res.body).not.toContain('8012345678');
  });

  it('rejects an invalid phone, a bad body and a body with both', async () => {
    const { call } = await setup();
    expect((await call('POST', '/admin/v1/blocks', { phone: '12345', reason: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/admin/v1/blocks', { reason: 'x' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/admin/v1/blocks', { phone: PHONE, userId: 'u', reason: 'x' })).statusCode,
    ).toBe(400);
    // The device subject is gone with the device model.
    expect((await call('POST', '/admin/v1/blocks', { deviceId: 'dev_1', reason: 'x' })).statusCode).toBe(400);
  });

  it('lists live blocks only, and deletes', async () => {
    const { ctx, call } = await setup();
    const live = (await call('POST', '/admin/v1/blocks', { userId: 'usr_live', reason: 'a' })).json();
    await ctx.db
      .insertInto('blocks')
      .values({
        id: 'blk_old',
        subject_type: 'user',
        subject: 'usr_old',
        reason: 'old',
        source: 'automatic',
        created_at: new Date(ctx.clock.now().getTime() - 2 * DAY),
        expires_at: new Date(ctx.clock.now().getTime() - 1),
      })
      .execute();
    await ctx.db
      .insertInto('blocks')
      .values({
        id: 'blk_forever',
        subject_type: 'user',
        subject: 'usr_f',
        reason: 'f',
        source: 'manual',
        created_at: ctx.clock.now(),
        expires_at: null,
      })
      .execute();
    const list = (await call('GET', '/admin/v1/blocks')).json().blocks as Array<{ id: string }>;
    expect(list.map((b) => b.id).sort()).toEqual([live.id, 'blk_forever'].sort());

    expect((await call('DELETE', `/admin/v1/blocks/${live.id}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/admin/v1/blocks/${live.id}`)).statusCode).toBe(404);
    const after = (await call('GET', '/admin/v1/blocks')).json().blocks as Array<{ id: string }>;
    expect(after.map((b) => b.id)).toEqual(['blk_forever']);
  });
});

describe('erasure', () => {
  it('deletes by phone through the hash, with events by cascade', async () => {
    const { ctx, call } = await setup();
    const hash = phoneHash(ctx.config.phoneHashSecret, PHONE);
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { phone_hash: hash, status: 'closed' });
    await insertSubmission(ctx.db, ctx.clock.now(), { phone_hash: hash, status: 'closed' });
    await insertSubmission(ctx.db, ctx.clock.now(), { phone_hash: 'someone-else' });
    await ctx.db
      .insertInto('submission_events')
      .values({
        submission_id: id,
        from_status: null,
        to_status: 'queued',
        cause: 'accepted',
        at: ctx.clock.now(),
      })
      .execute();
    const res = await call('POST', '/admin/v1/erasure', { phone: PHONE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    expect(await ctx.db.selectFrom('submissions').select('id').execute()).toHaveLength(1);
    expect(await ctx.db.selectFrom('submission_events').select('id').execute()).toHaveLength(0);
  });

  it('deletes by reference', async () => {
    const { ctx, call } = await setup();
    await insertSubmission(ctx.db, ctx.clock.now(), { reference: 'SOS-QQQQ' });
    await insertSubmission(ctx.db, ctx.clock.now(), { reference: 'SOS-RRRR' });
    const res = await call('POST', '/admin/v1/erasure', { reference: 'SOS-QQQQ' });
    expect(res.json()).toEqual({ deleted: 1 });
    const left = await ctx.db.selectFrom('submissions').select('reference').execute();
    expect(left.map((r) => r.reference)).toEqual(['SOS-RRRR']);
    expect((await call('POST', '/admin/v1/erasure', { reference: 'SOS-QQQQ' })).json()).toEqual({
      deleted: 0,
    });
  });

  it('rejects an invalid phone and an empty body', async () => {
    const { call } = await setup();
    expect((await call('POST', '/admin/v1/erasure', { phone: 'abc' })).statusCode).toBe(400);
    expect((await call('POST', '/admin/v1/erasure', {})).statusCode).toBe(400);
  });
});

describe('/metrics', () => {
  it('serves Prometheus text with the Prometheus implementation', async () => {
    const metrics = createPromMetrics();
    metrics.inc(METRICS.submissions, { outcome: 'received' });
    const { call } = await setup({ metrics });
    const res = await call('GET', '/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('sos_submissions_total{outcome="received"} 1');
  });

  it('is 404 with another implementation', async () => {
    const { call } = await setup();
    expect((await call('GET', '/metrics')).statusCode).toBe(404);
  });
});
