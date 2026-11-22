import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { MINUTE } from '../../src/clock.js';
import type { SubmissionStatus } from '../../src/db/types.js';
import { newReceiptId } from '../../src/ids.js';
import { METRICS, type Metrics } from '../../src/metrics.js';
import { insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, resetDb, testConfig, unusedCore } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

class CountingMetrics implements Metrics {
  incs: { name: string; labels?: Record<string, string> }[] = [];
  inc(name: string, labels?: Record<string, string>): void {
    this.incs.push({ name, labels });
  }
  observe(): void {}
  set(): void {}
}

async function setup(limit?: number) {
  const metrics = new CountingMetrics();
  const base = testConfig();
  const ctx = createTestContext({
    core: unusedCore(),
    metrics,
    config:
      limit === undefined ? base : { ...base, limits: { ...base.limits, statusPollMinIntervalS: limit } },
  });
  const app = await buildPublicApp(ctx);
  const owner = await seedUser(ctx);
  const stranger = await seedUser(ctx);
  /** Polls as the owner unless another token (or none) is given. */
  const poll = (id: string, token: string | null = owner.token()) =>
    app.inject({
      method: 'GET',
      url: `/v1/sos/${id}/status`,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  /** A submission of the owner's. */
  const submit = async (status: SubmissionStatus = 'queued') => {
    const id = newReceiptId(ctx.clock.now().getTime());
    await insertSubmission(ctx.db, ctx.clock.now(), { id, status, user_id: owner.user.id });
    return id;
  };
  return { ctx, app, metrics, owner, stranger, poll, submit };
}

describe('GET /v1/sos/:receiptId/status', () => {
  it.each(['queued', 'received', 'dispatched', 'closed', 'failed'] as const)(
    '200 for status %s',
    async (s) => {
      const { ctx, poll, submit } = await setup();
      const id = await submit(s);
      const res = await poll(id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        type: 'state',
        version: 0,
        receiptId: id,
        status: s,
        reference: expect.stringMatching(/^SOS-/),
        updatedAt: ctx.clock.now().toISOString(),
        recording: { status: 'none' },
        units: [],
      });
    },
  );

  it('returns the live snapshot (plan §5.3) and nothing else', async () => {
    const { poll, submit } = await setup();
    const res = await poll(await submit('dispatched'));
    expect(Object.keys(res.json()).sort()).toEqual([
      'receiptId',
      'recording',
      'reference',
      'status',
      'type',
      'units',
      'updatedAt',
      'version',
    ]);
    expect(res.body).not.toMatch(/Ade|2348012345678|Not breathing|core_call|userId/);
  });

  it('shows the live version, the latest recording and the units on the call', async () => {
    const { ctx, poll, submit } = await setup(0);
    const id = await submit('dispatched');
    await ctx.db.updateTable('submissions').set({ live_version: '7' }).where('id', '=', id).execute();
    await ctx.db
      .insertInto('recordings')
      .values({
        id: 'rec_01',
        submission_id: id,
        seq: 1,
        idempotency_key: 'k',
        body_hash: 'h',
        size: 10,
        duration_ms: 1000,
        status: 'attached',
        created_at: ctx.clock.now(),
      })
      .execute();
    await ctx.db
      .insertInto('submission_units')
      .values({
        submission_id: id,
        unit_key: 'u_0123456789abcdef0123456789abcdef',
        unit_type: 'Ambulance',
        status_text: 'En Route',
        lat: 6.53,
        lon: 3.3792,
        status_at: ctx.clock.now(),
      })
      .execute();
    const body = (await poll(id)).json();
    expect(body).toMatchObject({ version: 7, recording: { status: 'attached' } });
    expect(body.units).toEqual([
      {
        key: 'u_0123456789abcdef0123456789abcdef',
        type: 'Ambulance',
        status: 'En Route',
        lat: 6.53,
        lon: 3.3792,
        distanceM: 623,
        updatedAt: ctx.clock.now().toISOString(),
      },
    ]);
  });

  it('never calls Core (unusedCore throws on any call)', async () => {
    const { poll, submit } = await setup();
    const id = await submit('dispatched');
    expect((await poll(id)).statusCode).toBe(200);
    expect((await poll('sos_bogus')).statusCode).toBe(404);
  });

  it('updatedAt follows the latest event, falling back to accepted_at', async () => {
    const { ctx, poll, submit } = await setup(0);
    const id = await submit('received');
    const accepted = ctx.clock.now();
    expect((await poll(id)).json().updatedAt).toBe(accepted.toISOString());

    const t1 = new Date(accepted.getTime() + 60_000);
    const t2 = new Date(accepted.getTime() + 120_000);
    await ctx.db
      .insertInto('submission_events')
      .values([
        { submission_id: id, from_status: null, to_status: 'queued', cause: 'accepted', at: t1 },
        { submission_id: id, from_status: 'queued', to_status: 'received', cause: 'delivered', at: t2 },
      ])
      .execute();
    expect((await poll(id)).json().updatedAt).toBe(t2.toISOString());
  });

  it("someone else's receipt, a malformed id and an unknown receipt give identical 404 bodies", async () => {
    const { poll, submit, stranger } = await setup();
    const id = await submit();
    const unknown = newReceiptId(Date.now());
    const results = await Promise.all([
      poll(id, stranger.token()),
      poll('not-a-receipt'),
      poll(unknown),
      poll(unknown, stranger.token()),
    ]);
    for (const r of results) expect(r.statusCode).toBe(404);
    const bodies = new Set(results.map((r) => r.body));
    expect(bodies.size).toBe(1);
    expect(results[0]!.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('401 with the auth codes for a missing, malformed, expired or revoked access token', async () => {
    const { ctx, poll, submit, owner } = await setup(0);
    const id = await submit();
    const missing = await poll(id, null);
    const garbage = await poll(id, 'not-a-token');
    const old = owner.token();
    ctx.clock.advance(15 * MINUTE);
    const expired = await poll(id, old);
    await ctx.db
      .updateTable('token_families')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', owner.familyId)
      .execute();
    const revoked = await poll(id);
    for (const [res, code] of [
      [missing, 'invalid_token'],
      [garbage, 'invalid_token'],
      [expired, 'token_expired'],
      [revoked, 'session_revoked'],
    ] as const) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
    }
  });

  describe('poll limit', () => {
    it('429 with retryAfterSeconds and Retry-After on a second poll, recovering after the interval', async () => {
      const { ctx, poll, submit, metrics } = await setup(5);
      const id = await submit();
      expect((await poll(id)).statusCode).toBe(200);
      ctx.clock.advanceSeconds(2);
      const res = await poll(id);
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 3 });
      expect(res.headers['retry-after']).toBe('3');
      expect(metrics.incs).toContainEqual({ name: METRICS.rateLimited, labels: { rule: 'status_poll' } });
      ctx.clock.advanceSeconds(3);
      expect((await poll(id)).statusCode).toBe(200);
    });

    it('is per receipt', async () => {
      const { poll, submit } = await setup(5);
      // One user has one open SOS at a time: the first is closed.
      const a = await submit('closed');
      const b = await submit();
      expect((await poll(a)).statusCode).toBe(200);
      expect((await poll(b)).statusCode).toBe(200);
    });

    it("requests from someone else do not consume the owner's limit", async () => {
      const { poll, submit, stranger } = await setup(5);
      const id = await submit();
      for (let i = 0; i < 5; i++) expect((await poll(id, stranger.token())).statusCode).toBe(404);
      expect((await poll(id)).statusCode).toBe(200);
    });

    it('a limit of 0 disables it', async () => {
      const { poll, submit } = await setup(0);
      const id = await submit();
      for (let i = 0; i < 4; i++) expect((await poll(id)).statusCode).toBe(200);
    });
  });

  it('documents both routes in the OpenAPI document', async () => {
    const { app } = await setup();
    const doc = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    const op = doc.paths['/v1/sos/{receiptId}/status'].get;
    expect(op.security).toEqual([{ accessToken: [] }]);
    expect(JSON.stringify(op.parameters)).not.toContain('x-status-token');
    expect(doc.paths['/v1/intake/{intakeCode}'].get.responses['200']).toBeDefined();
  });
});
