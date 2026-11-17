import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { statusTokenFor } from '../../src/crypto.js';
import type { SubmissionStatus } from '../../src/db/types.js';
import { newReceiptId } from '../../src/ids.js';
import { METRICS, type Metrics } from '../../src/metrics.js';
import { insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, resetDb, testConfig, unusedCore } from '../helpers/context.js';

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
  const tokenFor = (id: string) => statusTokenFor(ctx.config.statusTokenSecret, id);
  const poll = (id: string, token: string | null = tokenFor(id)) =>
    app.inject({
      method: 'GET',
      url: `/v1/sos/${id}/status`,
      headers: token === null ? {} : { 'x-status-token': token },
    });
  const submit = async (status: SubmissionStatus = 'queued') => {
    const id = newReceiptId(ctx.clock.now().getTime());
    await insertSubmission(ctx.db, ctx.clock.now(), { id, status });
    return id;
  };
  return { ctx, app, metrics, tokenFor, poll, submit };
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
        status: s,
        reference: expect.stringMatching(/^SOS-/),
        updatedAt: ctx.clock.now().toISOString(),
      });
    },
  );

  it('returns only status, reference and updatedAt', async () => {
    const { poll, submit } = await setup();
    const res = await poll(await submit('dispatched'));
    expect(Object.keys(res.json()).sort()).toEqual(['reference', 'status', 'updatedAt']);
    expect(res.body).not.toMatch(/Ade|2348012345678|Not breathing|core_call/);
  });

  it('never calls Core (unusedCore throws on any call)', async () => {
    const { poll, submit } = await setup();
    const id = await submit('dispatched');
    expect((await poll(id)).statusCode).toBe(200);
    expect((await poll('sos_bogus', 'x')).statusCode).toBe(404);
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

  it('wrong token, missing token, malformed id and unknown receipt give identical 404 bodies', async () => {
    const { poll, submit, tokenFor } = await setup();
    const id = await submit();
    const unknown = newReceiptId(Date.now());
    const results = await Promise.all([
      poll(id, 'wrong-token'),
      poll(id, null),
      poll('not-a-receipt', tokenFor('not-a-receipt')),
      poll(unknown, tokenFor(unknown)),
      poll(unknown, 'wrong-token'),
    ]);
    for (const r of results) expect(r.statusCode).toBe(404);
    const bodies = new Set(results.map((r) => r.body));
    expect(bodies.size).toBe(1);
    expect(results[0]!.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('a token for another receipt is refused', async () => {
    const { poll, submit, tokenFor } = await setup();
    const a = await submit();
    const b = await submit();
    expect((await poll(a, tokenFor(b))).statusCode).toBe(404);
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
      const a = await submit();
      const b = await submit();
      expect((await poll(a)).statusCode).toBe(200);
      expect((await poll(b)).statusCode).toBe(200);
    });

    it('wrong-token requests do not consume the limit', async () => {
      const { poll, submit } = await setup(5);
      const id = await submit();
      for (let i = 0; i < 5; i++) expect((await poll(id, 'wrong')).statusCode).toBe(404);
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
    expect(doc.paths['/v1/sos/{receiptId}/status'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'x-status-token', in: 'header' })]),
    );
    expect(doc.paths['/v1/intake/{intakeCode}'].get.responses['200']).toBeDefined();
  });
});
