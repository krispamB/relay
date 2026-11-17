import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_CODES } from '../../src/alerts.js';
import { MINUTE, SECOND } from '../../src/clock.js';
import { DEFAULT_LIMITS } from '../../src/config.js';
import { createDeliveryWorker, runDeliveryPass } from '../../src/jobs/deliveryWorker.js';
import { type Labels, METRICS, type MetricName, type Metrics } from '../../src/metrics.js';
import { getState, pauseDelivery } from '../../src/state.js';
import { closeTestDb, createTestContext, resetDb, testConfig, unusedCore } from '../helpers/context.js';
import { eventsFor, getSubmission, insertSubmission, ok, retryable, scriptedCore } from './fixtures.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

class GaugeMetrics implements Metrics {
  readonly gauges = new Map<string, number>();
  inc() {}
  observe() {}
  set(name: MetricName, value: number, _labels?: Labels) {
    this.gauges.set(name, value);
  }
}

describe('delivery worker', () => {
  it('is a 1 s job', () => {
    const job = createDeliveryWorker(createTestContext());
    expect(job.intervalMs).toBe(1000);
    expect(job.name).toBe('delivery');
  });

  it('follows the backoff schedule: 5, 15, 30, 60, 60 s', async () => {
    const core = scriptedCore(retryable());
    const ctx = createTestContext({ core });
    const start = ctx.clock.now();
    const id = await insertSubmission(ctx.db, start);

    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(1);

    const attemptTimes = [0];
    for (let s = 1; s <= 200; s++) {
      ctx.clock.advance(SECOND);
      const before = core.calls.length;
      await runDeliveryPass(ctx);
      if (core.calls.length > before) attemptTimes.push(s);
    }
    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]!);
    expect(gaps).toEqual([5, 15, 30, 60, 60]);
    expect(core.calls.every((c) => c.submissionId === id)).toBe(true);
  });

  it('honours Retry-After from a 429', async () => {
    const core = scriptedCore(retryable(20), ok());
    const ctx = createTestContext({ core });
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await runDeliveryPass(ctx);
    ctx.clock.advanceSeconds(19);
    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(1);
    ctx.clock.advanceSeconds(1);
    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(2);
    expect((await getSubmission(ctx.db, id)).status).toBe('received');
  });

  it('delivers oldest first, one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const core = scriptedCore(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    });
    const ctx = createTestContext({ core });
    const now = ctx.clock.now();
    const newer = await insertSubmission(ctx.db, new Date(now.getTime() - 10 * SECOND));
    const oldest = await insertSubmission(ctx.db, new Date(now.getTime() - 60 * SECOND));
    const middle = await insertSubmission(ctx.db, new Date(now.getTime() - 30 * SECOND));
    await runDeliveryPass(ctx);
    expect(core.calls.map((c) => c.submissionId)).toEqual([oldest, middle, newer]);
    expect(maxInFlight).toBe(1);
  });

  it('only attempts due submissions', async () => {
    const core = scriptedCore(ok());
    const ctx = createTestContext({ core });
    const now = ctx.clock.now();
    await insertSubmission(ctx.db, now, { next_attempt_at: new Date(now.getTime() + 8 * SECOND) });
    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(0);
    ctx.clock.advanceSeconds(8);
    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(1);
  });

  it('stops the pass at once when an attempt pauses delivery', async () => {
    const core = scriptedCore({ kind: 'auth', httpStatus: 401 }, ok());
    const ctx = createTestContext({ core });
    const now = ctx.clock.now();
    await insertSubmission(ctx.db, new Date(now.getTime() - 3000));
    await insertSubmission(ctx.db, new Date(now.getTime() - 2000));
    await insertSubmission(ctx.db, new Date(now.getTime() - 1000));
    await runDeliveryPass(ctx);
    expect(core.calls).toHaveLength(1);
    expect((await getState(ctx.db)).paused).toBe(true);
  });

  it('makes no Core calls while paused and raises the critical reminder every pass', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'Core returned 401 on SaveCall');
    await insertSubmission(ctx.db, ctx.clock.now());
    for (let i = 0; i < 3; i++) {
      await runDeliveryPass(ctx);
      ctx.clock.advanceMinutes(1);
    }
    const paused = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.deliveryPaused);
    expect(paused).toHaveLength(3);
    expect(paused[0]!.severity).toBe('critical');
  });

  it('fails a queued submission at 30 minutes, with event and high alert', async () => {
    const ctx = createTestContext({ core: scriptedCore(retryable()) });
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    ctx.clock.advance(30 * MINUTE - SECOND);
    await runDeliveryPass(ctx);
    expect((await getSubmission(ctx.db, id)).status).toBe('queued');
    ctx.clock.advance(SECOND);
    await runDeliveryPass(ctx);
    const row = await getSubmission(ctx.db, id);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toMatch(/30 minutes/);
    expect(await eventsFor(ctx.db, id)).toMatchObject([
      { from_status: 'queued', to_status: 'failed', cause: 'expired' },
    ]);
    const failed = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.submissionFailed);
    expect(failed).toEqual([
      expect.objectContaining({ severity: 'high', always: true, reference: row.reference, receiptId: id }),
    ]);
  });

  it('still fails at 30 minutes while paused, without any Core call', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await pauseDelivery(ctx.db, ctx.clock.now(), 'Core returned 401 on SaveCall');
    ctx.clock.advance(30 * MINUTE);
    await runDeliveryPass(ctx);
    expect((await getSubmission(ctx.db, id)).status).toBe('failed');
    expect(ctx.alerts.codes()).toContain(ALERT_CODES.submissionFailed);
  });

  it('delivers demo submissions while paused, never touching Core', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    const demo = await insertSubmission(ctx.db, ctx.clock.now(), { is_demo: true, intake_code: 'DEMO-DEPT' });
    const real = await insertSubmission(ctx.db, ctx.clock.now());
    await runDeliveryPass(ctx);
    expect((await getSubmission(ctx.db, demo)).status).toBe('received');
    expect((await getSubmission(ctx.db, real)).status).toBe('queued');
  });

  it('updates the queue gauges and warns on backlog', async () => {
    const metrics = new GaugeMetrics();
    const ctx = createTestContext({
      core: scriptedCore(retryable()),
      metrics,
      config: testConfig({ limits: { ...DEFAULT_LIMITS, queueDepthWarn: 1, oldestQueuedWarnS: 300 } }),
    });
    const now = ctx.clock.now();
    await insertSubmission(ctx.db, new Date(now.getTime() - 100 * SECOND));
    await runDeliveryPass(ctx);
    expect(metrics.gauges.get(METRICS.queueDepth)).toBe(1);
    expect(metrics.gauges.get(METRICS.oldestQueuedAge)).toBe(100);
    expect(metrics.gauges.get(METRICS.paused)).toBe(0);
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.queueBacklog);

    await insertSubmission(ctx.db, now);
    await runDeliveryPass(ctx);
    expect(metrics.gauges.get(METRICS.queueDepth)).toBe(2);
    expect(ctx.alerts.alerts.find((a) => a.code === ALERT_CODES.queueBacklog)?.severity).toBe('warning');
  });

  it('warns when the oldest queued submission is over its age threshold', async () => {
    const ctx = createTestContext({ core: scriptedCore(retryable()) });
    await insertSubmission(ctx.db, ctx.clock.now());
    ctx.clock.advanceSeconds(301);
    await runDeliveryPass(ctx);
    expect(ctx.alerts.codes()).toContain(ALERT_CODES.queueBacklog);
  });
});
