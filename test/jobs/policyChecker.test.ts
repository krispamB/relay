import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { ALERT_CODES } from '../../src/alerts.js';
import { DAY, HOUR, MINUTE, SECOND } from '../../src/clock.js';
import { createCoreClient } from '../../src/core/client.js';
import type { CoreClient } from '../../src/core/types.js';
import {
  checkKeyExpiry,
  createPolicyChecker,
  keyExpiryStage,
  retryDelayMs,
  runPolicyCheck,
} from '../../src/jobs/policyChecker.js';
import { getState, pauseDelivery, resumeDelivery, unavailableReason } from '../../src/state.js';
import { closeTestDb, resetDb, testConfig, unusedCore } from '../helpers/context.js';
import { mockContext } from './fixtures.js';

let mock: RunningMockCore;

beforeAll(async () => {
  // As mock-core/main.ts seeds it: createMockCore itself starts with no call types or priorities.
  mock = await startMockCore({ callTypes: ['Public SOS'], priorities: [{ Id: 3, Name: 'High' }] });
});
afterAll(async () => {
  await mock.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  mock.control.reset();
});

function ctxWith(resgrid: Partial<ReturnType<typeof testConfig>['resgrid']> = {}) {
  const base = testConfig();
  return mockContext(mock, testConfig({ resgrid: { ...base.resgrid, ...resgrid } }));
}

const coreRequests = () => mock.control.requests().length;

describe('policy check (PRD §13.2, §13.3; integration.md §6, §7)', () => {
  it('healthy: records ok, available, nothing required, no alert', async () => {
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('ok');
    const s = await getState(ctx.db);
    expect(s).toMatchObject({
      check_status: 'ok',
      check_detail: null,
      required_location: false,
      required_address: false,
      required_name: false,
    });
    expect(s.check_ok_at).toEqual(ctx.clock.now());
    expect(unavailableReason(s, ctx.clock.now())).toBeUndefined();
    expect(ctx.alerts.alerts).toEqual([]);
    expect(mock.control.requests().map((r) => r.endpoint)).toEqual([
      'CallTypes/GetAllCallTypes',
      'CallPriorities/GetAllCallPriorites',
      'Calls/GetNewCallFieldPolicy',
    ]);
  });

  it('a call type name that differs only in case is a mismatch', async () => {
    const ctx = ctxWith({ callTypeName: 'public sos' });
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
    const s = await getState(ctx.db);
    expect(s.check_status).toBe('unhealthy');
    expect(s.check_detail).toContain('public sos');
    expect(unavailableReason(s, ctx.clock.now())).toBe('unhealthy');
    expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.referenceMismatch }]);
  });

  it('"No Type" never satisfies the call type check', async () => {
    const ctx = ctxWith({ callTypeName: 'No Type' });
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
  });

  it('a deleted priority is a mismatch', async () => {
    mock.control.setPriorities([{ Id: 3, Name: 'High', IsDeleted: true }]);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
    expect((await getState(ctx.db)).check_detail).toContain('deleted');
    expect(ctx.alerts.codes()).toEqual([ALERT_CODES.referenceMismatch]);
  });

  it('a missing priority is a mismatch', async () => {
    mock.control.setPriorities([{ Id: 4, Name: 'Low' }]);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
    expect((await getState(ctx.db)).check_detail).toContain('priority 3 not found');
    expect(ctx.alerts.codes()).toEqual([ALERT_CODES.referenceMismatch]);
  });

  it('no priorities at all (not_found) is a mismatch', async () => {
    mock.control.setPriorities([]);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
  });

  it.each(['what3words', 'incidentId', 'destinationPoi'])(
    'a required %s cannot be met: unhealthy with a critical alert',
    async (key) => {
      mock.control.setFieldPolicy([{ Key: key, Required: true }]);
      const ctx = ctxWith();
      expect(await runPolicyCheck(ctx)).toBe('unhealthy');
      const s = await getState(ctx.db);
      expect(s.check_detail).toContain(key);
      expect(unavailableReason(s, ctx.clock.now())).toBe('unhealthy');
      expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.policyUnmeetable }]);
      expect(ctx.alerts.alerts[0]!.message).toContain(key);
    },
  );

  it('a key that is visible but not required does not matter', async () => {
    mock.control.setFieldPolicy([{ Key: 'incidentId', Visible: true, Required: false }]);
    expect(await runPolicyCheck(ctxWith())).toBe('ok');
  });

  it.each([
    ['geolocation', { required_location: true, required_address: false, required_name: false }],
    ['address', { required_location: false, required_address: true, required_name: false }],
    ['contactName', { required_location: false, required_address: false, required_name: true }],
  ] as const)('a required %s sets its flag and stays healthy', async (key, flags) => {
    mock.control.setFieldPolicy([{ Key: key, Required: true }]);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('ok');
    expect(await getState(ctx.db)).toMatchObject({ check_status: 'ok', ...flags });
  });

  it('keys that are always met or not enforced keep it healthy', async () => {
    mock.control.setFieldPolicy(
      ['note', 'externalId', 'referenceId', 'contactInfo', 'dispatchOn', 'protocols', 'linkedCall'].map(
        (Key) => ({
          Key,
          Required: true,
        }),
      ),
    );
    expect(await runPolicyCheck(ctxWith())).toBe('ok');
  });

  it('a flag clears again when the policy no longer requires it', async () => {
    mock.control.setFieldPolicy([{ Key: 'geolocation', Required: true }]);
    const ctx = ctxWith();
    await runPolicyCheck(ctx);
    mock.control.setFieldPolicy([]);
    await runPolicyCheck(ctx);
    expect((await getState(ctx.db)).required_location).toBe(false);
  });

  it('a 401 pauses delivery with one critical alert, after a single request', async () => {
    mock.control.setApiKey(`rgk_Other123_${'o'.repeat(43)}`);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('auth');
    const s = await getState(ctx.db);
    expect(s.paused).toBe(true);
    expect(s.paused_reason).toContain('401');
    expect(s.check_at).toBeNull();
    expect(coreRequests()).toBe(1);
    expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.deliveryPaused }]);

    // Paused: nothing is checked, no request is sent.
    expect(await runPolicyCheck(ctx)).toBe('paused');
    expect(coreRequests()).toBe(1);
    expect(ctx.alerts.alerts).toHaveLength(1);
  });

  it('a 403 (missing scope) pauses too', async () => {
    mock.control.setScopes(['calls.create', 'calls.read']);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('auth');
    expect((await getState(ctx.db)).paused_reason).toContain('403');
  });

  it('Core unreachable records nothing, so availability lapses 24 hours after the last good check', async () => {
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('ok');
    const okAt = ctx.clock.now();

    mock.control.injectFault('*', { status: 503 }, 1000);
    ctx.clock.advance(HOUR);
    expect(await runPolicyCheck(ctx)).toBe('unreachable');
    let s = await getState(ctx.db);
    expect(s.check_at).toEqual(okAt);
    expect(s.paused).toBe(false);
    expect(ctx.alerts.alerts).toEqual([]);

    ctx.clock.set(new Date(okAt.getTime() + DAY));
    expect(await runPolicyCheck(ctx)).toBe('unreachable');
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBeUndefined();
    ctx.clock.advance(SECOND);
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBe('unverified');

    mock.control.clearFaults();
    expect(await runPolicyCheck(ctx)).toBe('ok');
    s = await getState(ctx.db);
    expect(unavailableReason(s, ctx.clock.now())).toBeUndefined();
  });

  it('recovers from unhealthy on the next good check', async () => {
    mock.control.setFieldPolicy([{ Key: 'what3words', Required: true }]);
    const ctx = ctxWith();
    expect(await runPolicyCheck(ctx)).toBe('unhealthy');
    mock.control.setFieldPolicy([]);
    ctx.clock.advance(HOUR);
    expect(await runPolicyCheck(ctx)).toBe('ok');
    const s = await getState(ctx.db);
    expect(s).toMatchObject({ check_status: 'ok', check_detail: null });
    expect(unavailableReason(s, ctx.clock.now())).toBeUndefined();
  });

  it('a network failure (connection refused) is "unreachable"', async () => {
    const ctx = mockContext(mock);
    const dead = { ...ctx };
    dead.core = createCoreClient(
      { apiBase: 'http://127.0.0.1:1', apiKey: 'rgk_x' },
      { log: ctx.log, metrics: ctx.metrics },
    );
    expect(await runPolicyCheck(dead)).toBe('unreachable');
    expect((await getState(ctx.db)).check_status).toBe('unknown');
  });
});

describe('policy checker job', () => {
  it('checks at start, then hourly after a completed check', async () => {
    const ctx = ctxWith();
    const job = createPolicyChecker(ctx);
    expect(job.name).toBe('policy-checker');
    await job.run();
    expect(mock.control.requests({ endpoint: 'CallTypes/GetAllCallTypes' })).toHaveLength(1);
    for (let i = 0; i < 119; i++) {
      ctx.clock.advance(30 * SECOND);
      await job.run();
    }
    expect(mock.control.requests({ endpoint: 'CallTypes/GetAllCallTypes' })).toHaveLength(1);
    ctx.clock.advance(30 * SECOND);
    await job.run();
    expect(mock.control.requests({ endpoint: 'CallTypes/GetAllCallTypes' })).toHaveLength(2);
  });

  it('retries an unreachable Core with backoff: 1, 2, 4, 8, then every 15 minutes', async () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => retryDelayMs(n) / MINUTE)).toEqual([1, 2, 4, 8, 15, 15, 15]);

    mock.control.injectFault('CallTypes/GetAllCallTypes', { status: 503 }, 1000);
    const ctx = ctxWith();
    const job = createPolicyChecker(ctx);
    const attemptsAt: number[] = [];
    for (let s = 0; s <= 60 * 60; s += 30) {
      if (s > 0) ctx.clock.advance(30 * SECOND);
      const before = mock.control.requests().length;
      await job.run();
      if (mock.control.requests().length > before) attemptsAt.push(s / 60);
    }
    expect(attemptsAt).toEqual([0, 1, 3, 7, 15, 30, 45, 60]);
    expect((await getState(ctx.db)).check_status).toBe('unknown');
  });

  it('does nothing while paused, and checks as soon as delivery is resumed', async () => {
    const ctx = ctxWith();
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    const job = createPolicyChecker(ctx);
    for (let i = 0; i < 5; i++) {
      await job.run();
      ctx.clock.advance(30 * SECOND);
    }
    expect(coreRequests()).toBe(0);
    await resumeDelivery(ctx.db);
    await job.run();
    expect(coreRequests()).toBe(3);
    expect((await getState(ctx.db)).check_status).toBe('ok');
  });

  it('never throws, even when the Core client or the database does', async () => {
    const ctx = ctxWith();
    const throwing: CoreClient = {
      ...unusedCore(),
      getCallTypes: async () => {
        throw new Error('boom');
      },
    };
    ctx.core = throwing;
    const job = createPolicyChecker(ctx);
    await expect(job.run()).resolves.toBeUndefined();

    const broken = { ...ctx, db: { ...ctx.db } as typeof ctx.db };
    (broken.db as unknown as { selectFrom: () => never }).selectFrom = () => {
      throw new Error('db down');
    };
    (broken.db as unknown as { insertInto: () => never }).insertInto = () => {
      throw new Error('db down');
    };
    await expect(createPolicyChecker(broken).run()).resolves.toBeUndefined();
  });
});

describe('key expiry warnings (PRD §11.2)', () => {
  // The test clock starts at 2026-11-17T12:00:00Z.
  it('classifies the stages', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(keyExpiryStage('2026-12-18', now)).toBeUndefined();
    expect(keyExpiryStage('2026-12-17', now)).toBe('within_30_days');
    expect(keyExpiryStage('2026-11-24', now)).toBe('within_7_days');
    expect(keyExpiryStage('2026-11-17', now)).toBe('expired');
  });

  it('no warning while the key has more than 30 days left', async () => {
    const ctx = ctxWith({ apiKeyExpiresOn: '2027-06-01' });
    expect(await checkKeyExpiry(ctx)).toBeUndefined();
    expect(ctx.alerts.alerts).toEqual([]);
  });

  it('warns within 30 days, at most once a day even though the job runs every hour', async () => {
    const ctx = ctxWith({ apiKeyExpiresOn: '2026-12-17' });
    const job = createPolicyChecker(ctx);
    for (let h = 0; h < 24; h++) {
      await job.run();
      ctx.clock.advance(HOUR);
    }
    const warnings = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.keyExpiring);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: 'warning' });
    expect(warnings[0]!.message).toContain('2026-12-17');
    await job.run();
    expect(ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.keyExpiring)).toHaveLength(2);
  });

  it('warns again at once when the 7-day mark is reached, and when the key has expired', async () => {
    const ctx = ctxWith({ apiKeyExpiresOn: '2026-12-17' });
    expect(await checkKeyExpiry(ctx)).toBe('within_30_days');
    ctx.clock.set('2026-12-10T00:00:00Z');
    expect(await checkKeyExpiry(ctx)).toBe('within_7_days');
    ctx.clock.advance(HOUR);
    expect(await checkKeyExpiry(ctx)).toBe('within_7_days');
    ctx.clock.set('2026-12-17T00:00:00Z');
    expect(await checkKeyExpiry(ctx)).toBe('expired');
    ctx.clock.advance(12 * HOUR);
    await checkKeyExpiry(ctx);
    const warnings = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.keyExpiring);
    expect(warnings).toHaveLength(3);
    expect(warnings[1]!.message).toContain('in 7 days');
    expect(warnings[2]!.message).toContain('expired');
  });

  it('still warns while delivery is paused', async () => {
    const ctx = ctxWith({ apiKeyExpiresOn: '2026-11-01' });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'Core returned 401');
    await createPolicyChecker(ctx).run();
    expect(ctx.alerts.codes()).toEqual([ALERT_CODES.keyExpiring]);
    expect(coreRequests()).toBe(0);
  });
});
