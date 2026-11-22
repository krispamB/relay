import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_CODES } from '../../src/alerts.js';
import { HOUR, MINUTE } from '../../src/clock.js';
import { METRICS } from '../../src/metrics.js';
import { ok, scriptedCore } from '../delivery/fixtures.js';
import { closeTestDb, DEMO_INTAKE_CODE, resetDb } from '../helpers/context.js';
import { caller, closeAll, type Harness, harness, type postSos, submissionCount } from './helpers.js';

let h: Harness | undefined;
beforeEach(() => resetDb());
afterEach(async () => {
  await h?.app.close();
  h = undefined;
});
afterAll(() => closeTestDb());

/** Default limits, except the ones a test is not about are turned off (0). */
const only = (limits: Record<string, number>) => ({
  sosPerUserPer24h: 0,
  sosPerPhonePer24h: 0,
  sosPerIpPerHour: 0,
  intakeBreakerCount: 0,
  ...limits,
});

function expect429(res: Awaited<ReturnType<typeof postSos>>) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe('rate_limited');
  expect(res.headers['retry-after']).toBe(String(res.body.error.retryAfterSeconds));
  return res.body.error.retryAfterSeconds as number;
}

describe('SOS per user (PRD §9.1)', () => {
  it('refuses the 4th in 24 h with a Retry-After counted from the oldest one', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({ sosPerUserPer24h: 3 }) });
    const d = await caller(h);
    for (let i = 0; i < 3; i++) {
      expect((await d.send()).status).toBe(201);
      await closeAll(h, d.user.id);
      h.ctx.clock.advance(HOUR);
    }
    // Oldest was accepted 3 h ago: it leaves the window in 21 h.
    expect(expect429(await d.send())).toBe(21 * 3600);
    expect(h.metrics.count(METRICS.rateLimited, { rule: 'sos_per_user' })).toBe(1);
    // Another user is not affected.
    expect((await (await caller(h)).send()).status).toBe(201);

    h.ctx.clock.advance(21 * HOUR);
    expect((await d.send()).status).toBe(201);
  });

  it('refused requests and replays do not count', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({ sosPerUserPer24h: 2 }) });
    const d = await caller(h);
    const key = randomUUID();
    expect((await d.send({}, { key })).status).toBe(201);
    expect((await d.send({}, { key })).status).toBe(201); // replay
    expect((await d.send()).status).toBe(409); // refused: open
    expect((await d.send({ nature: 'fire' })).status).toBe(400); // refused: invalid
    await closeAll(h, d.user.id);
    expect((await d.send()).status).toBe(201); // the second accepted one
    await closeAll(h, d.user.id);
    expect429(await d.send());
    expect(await submissionCount(h)).toBe(2);
  });

  it('a limit of 0 is off', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({}) });
    const d = await caller(h);
    for (let i = 0; i < 5; i++) {
      expect((await d.send()).status).toBe(201);
      await closeAll(h, d.user.id);
    }
  });
});

describe('SOS per phone number (PRD §9.1)', () => {
  it("refuses the 4th for the account's number in 24 h, counted by the keyed phone hash", async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({ sosPerPhonePer24h: 3 }) });
    const d = await caller(h);
    for (let i = 0; i < 3; i++) {
      expect((await d.send()).status).toBe(201);
      await closeAll(h, d.user.id);
      h.ctx.clock.advance(10 * MINUTE);
    }
    expect(expect429(await d.send())).toBe(24 * 3600 - 30 * 60);
    expect(h.metrics.count(METRICS.rateLimited, { rule: 'sos_per_phone' })).toBe(1);
    // Another number is fine.
    expect((await (await caller(h)).send()).status).toBe(201);
  });
});

describe('SOS per IP address (PRD §9.1)', () => {
  it('refuses the 11th from one address in an hour', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({ sosPerIpPerHour: 10 }) });
    for (let i = 0; i < 10; i++) {
      expect((await (await caller(h)).send({}, { ip: '198.51.100.9' })).status).toBe(201);
      h.ctx.clock.advance(MINUTE);
    }
    expect(expect429(await (await caller(h)).send({}, { ip: '198.51.100.9' }))).toBe(50 * 60);
    expect(h.metrics.count(METRICS.rateLimited, { rule: 'sos_per_ip' })).toBe(1);
    expect((await (await caller(h)).send({}, { ip: '198.51.100.10' })).status).toBe(201);
  });
});

describe('whole-intake breaker (PRD §9.1, §11.2)', () => {
  it('answers 503 with Retry-After and raises the critical alert', async () => {
    h = await harness({
      core: scriptedCore(ok()),
      limits: only({ intakeBreakerCount: 4, intakeBreakerWindowS: 600 }),
    });
    for (let i = 0; i < 4; i++) {
      expect((await (await caller(h)).send({}, { ip: `198.51.100.${i}` })).status).toBe(201);
      h.ctx.clock.advance(MINUTE);
    }
    const last = await caller(h);
    const res = await last.send({}, { ip: '198.51.100.99' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('intake_busy');
    expect(res.body.error.retryAfterSeconds).toBe(6 * 60);
    expect(res.headers['retry-after']).toBe('360');
    expect(h.ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.intakeBreaker }]);
    expect(h.metrics.count(METRICS.rateLimited, { rule: 'intake_breaker' })).toBe(1);
    expect(JSON.stringify(h.ctx.alerts.alerts)).not.toContain(last.user.phone);
  });

  it('runs at the default 30 per 10 minutes', async () => {
    h = await harness({
      core: scriptedCore(ok()),
      limits: only({ intakeBreakerCount: 30, intakeBreakerWindowS: 600 }),
    });
    for (let i = 0; i < 30; i++) {
      expect((await (await caller(h)).send()).status).toBe(201);
    }
    expect((await (await caller(h)).send()).status).toBe(503);
    h.ctx.clock.advance(10 * MINUTE);
    expect((await (await caller(h)).send()).status).toBe(201);
  });
});

describe('demo submissions are counted apart (PRD §6.3)', () => {
  it('real submissions do not use up the demo limits, nor demo ones the real limits', async () => {
    h = await harness({
      core: scriptedCore(ok()),
      limits: only({
        sosPerUserPer24h: 1,
        sosPerPhonePer24h: 1,
        sosPerIpPerHour: 1,
        intakeBreakerCount: 1,
      }),
    });
    const d = await caller(h);
    expect((await d.send()).status).toBe(201);
    await closeAll(h, d.user.id);
    const demo = { intakeCode: DEMO_INTAKE_CODE };
    expect((await d.send(demo)).status).toBe(201);
    await closeAll(h, d.user.id);
    // Each is now at its own limit.
    expect((await d.send()).status).toBe(429);
    expect((await d.send(demo)).status).toBe(429);
  });

  it('the demo breaker trips on demo submissions only, with no alert or metric', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: only({ intakeBreakerCount: 2 }) });
    const demo = { intakeCode: DEMO_INTAKE_CODE };
    for (let i = 0; i < 2; i++) expect((await (await caller(h)).send(demo)).status).toBe(201);
    expect((await (await caller(h)).send(demo)).status).toBe(503);
    expect(h.ctx.alerts.alerts).toEqual([]);
    expect(h.metrics.count(METRICS.rateLimited)).toBe(0);
    // The real intake still has its whole budget.
    expect((await (await caller(h)).send()).status).toBe(201);
  });
});
