import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { ALERT_CODES } from '../../src/alerts.js';
import { HOUR, MINUTE, SECOND } from '../../src/clock.js';
import type { CoreClient } from '../../src/core/types.js';
import { attemptDelivery } from '../../src/delivery/deliver.js';
import {
  CLOSED_INTERVAL_MS,
  createStatusPoller,
  DISPATCHED_INTERVAL_MS,
  POLL_CAUSES,
  RECEIVED_INTERVAL_MS,
  runStatusPollerPass,
  STATUS_WINDOW_MS,
} from '../../src/jobs/statusPoller.js';
import { getState, pauseDelivery } from '../../src/state.js';
import { eventsFor, getSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, DEMO_INTAKE_CODE, resetDb, unusedCore } from '../helpers/context.js';
import { deliverToMock, insertDevice, insertSubmissionOn, mockContext, strikesFor } from './fixtures.js';

let mock: RunningMockCore;

beforeAll(async () => {
  mock = await startMockCore();
});
afterAll(async () => {
  await mock.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  mock.control.reset();
});

const count = (endpoint: 'Calls/GetCall' | 'Calls/GetPendingCalls' | 'Calls/GetNewCallFieldPolicy' | '*') =>
  mock.control.requests({ endpoint }).length;

async function status(ctx: { db: Parameters<typeof getSubmission>[0] }, id: string) {
  return (await getSubmission(ctx.db, id)).status;
}

describe('status poller: state changes (PRD §8.5, integration.md §5.3)', () => {
  it('is a 1 s job', () => {
    const job = createStatusPoller(createTestContext());
    expect(job.name).toBe('status-poller');
    expect(job.intervalMs).toBe(1000);
  });

  it('received → dispatched → closed, with events, core_state and closed_at', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);

    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('received');

    mock.control.setCallState(callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    let row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({ status: 'dispatched', core_state: 0, closed_at: null });
    expect(row.next_poll_at).toEqual(new Date(ctx.clock.now().getTime() + DISPATCHED_INTERVAL_MS));

    mock.control.setCallState(callId, 1);
    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({ status: 'closed', core_state: 1 });
    expect(row.closed_at).toEqual(ctx.clock.now());
    expect(row.next_poll_at).toEqual(new Date(ctx.clock.now().getTime() + CLOSED_INTERVAL_MS));

    expect(await eventsFor(ctx.db, id)).toMatchObject([
      { from_status: 'queued', to_status: 'received' },
      { from_status: 'received', to_status: 'dispatched', cause: 'core_state_0' },
      { from_status: 'dispatched', to_status: 'closed', cause: 'core_state_1' },
    ]);
    expect(ctx.alerts.alerts).toEqual([]);
  });

  it('received → closed directly', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 4);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    const row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({ status: 'closed', core_state: 4 });
    expect((await eventsFor(ctx.db, id)).at(-1)).toMatchObject({
      from_status: 'received',
      to_status: 'closed',
    });
  });

  it('a re-open after close moves closed → dispatched and clears closed_at', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('closed');

    mock.control.setCallState(callId, 0);
    mock.control.clearRequests();
    ctx.clock.advance(CLOSED_INTERVAL_MS - SECOND);
    await runStatusPollerPass(ctx);
    expect(count('Calls/GetCall')).toBe(0);
    ctx.clock.advance(SECOND);
    await runStatusPollerPass(ctx);
    const row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({ status: 'dispatched', core_state: 0, closed_at: null });
    expect((await eventsFor(ctx.db, id)).at(-1)).toMatchObject({
      from_status: 'closed',
      to_status: 'dispatched',
    });
  });

  it('a dispatched call put back to pending (8) returns to received', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    mock.control.setCallState(callId, 8);
    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await getSubmission(ctx.db, id)).toMatchObject({ status: 'received', core_state: 8 });
  });

  it.each([3, 7])('hoax state %i closes the submission and records strikes', async (state) => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, state);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await getSubmission(ctx.db, id)).toMatchObject({ status: 'closed', core_state: state });
    expect((await strikesFor(ctx.db, id)).map((s) => s.subject_type).sort()).toEqual(['device', 'phone']);
  });

  it.each([1, 2, 4, 5, 6])('non-hoax closing state %i records no strike', async (state) => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, state);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('closed');
    expect(await strikesFor(ctx.db)).toEqual([]);
  });

  it('an unknown state keeps the last status and raises a warning', async () => {
    const ctx = mockContext(mock);
    const { id, callId, reference } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 42);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await getSubmission(ctx.db, id)).toMatchObject({ status: 'received', core_state: 8 });
    expect(await eventsFor(ctx.db, id)).toHaveLength(1);
    expect(ctx.alerts.alerts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: ALERT_CODES.unknownCallState,
        reference,
        receiptId: id,
      }),
    ]);
    expect(ctx.alerts.alerts[0]!.message).toContain('42');
    expect(JSON.stringify(ctx.alerts.alerts)).not.toContain('+2348012345678');
  });

  describe('deleted calls (PRD R4)', () => {
    it('not_found mode: the submission closes with its own cause', async () => {
      const ctx = mockContext(mock);
      const { id, callId } = await deliverToMock(ctx);
      mock.control.setCallState(callId, 0);
      ctx.clock.advance(RECEIVED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      mock.control.deleteCall(callId);
      ctx.clock.advance(DISPATCHED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      expect(await getSubmission(ctx.db, id)).toMatchObject({ status: 'closed', core_state: null });
      expect((await eventsFor(ctx.db, id)).at(-1)).toMatchObject({ cause: POLL_CAUSES.notFound });
    });

    it('not_found mode: a deleted pending call closes', async () => {
      const ctx = mockContext(mock);
      const { id, callId } = await deliverToMock(ctx);
      mock.control.deleteCall(callId);
      ctx.clock.advance(RECEIVED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      expect(await status(ctx, id)).toBe('closed');
    });

    it('not_found does not remove a hoax strike', async () => {
      const ctx = mockContext(mock);
      const { id, callId } = await deliverToMock(ctx);
      mock.control.setCallState(callId, 7);
      ctx.clock.advance(RECEIVED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      mock.control.deleteCall(callId);
      ctx.clock.advance(CLOSED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      expect(await strikesFor(ctx.db, id)).toHaveLength(2);
    });

    it('last_state mode: the last state is kept until the 24-hour window closes it', async () => {
      mock.control.setDeletedCallBehavior('last_state');
      const ctx = mockContext(mock);
      const dispatched = await deliverToMock(ctx);
      const pending = await deliverToMock(ctx);
      mock.control.setCallState(dispatched.callId, 0);
      ctx.clock.advance(RECEIVED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
      mock.control.deleteCall(dispatched.callId);
      mock.control.deleteCall(pending.callId);
      for (let i = 0; i < 3; i++) {
        ctx.clock.advance(DISPATCHED_INTERVAL_MS);
        await runStatusPollerPass(ctx);
      }
      expect(await status(ctx, dispatched.id)).toBe('dispatched');
      // Gone from GetPendingCalls but GetCall still answers State 8: Core's word is kept.
      expect(await status(ctx, pending.id)).toBe('received');

      ctx.clock.set(
        new Date((await getSubmission(ctx.db, pending.id)).accepted_at.getTime() + STATUS_WINDOW_MS),
      );
      await runStatusPollerPass(ctx);
      expect(await status(ctx, dispatched.id)).toBe('closed');
      expect(await status(ctx, pending.id)).toBe('closed');
    });
  });
});

describe('status poller: cost and intervals', () => {
  it('many received submissions cost one GetPendingCalls and no GetCall while nothing changes', async () => {
    const ctx = mockContext(mock);
    for (let i = 0; i < 6; i++) await deliverToMock(ctx);
    mock.control.clearRequests();

    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    await runStatusPollerPass(ctx);
    expect(count('Calls/GetPendingCalls')).toBe(1);
    expect(count('Calls/GetCall')).toBe(0);

    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(count('Calls/GetPendingCalls')).toBe(2);
    expect(count('*')).toBe(2);
  });

  it('only a call that left the pending list gets a GetCall', async () => {
    const ctx = mockContext(mock);
    const subs = [];
    for (let i = 0; i < 4; i++) subs.push(await deliverToMock(ctx));
    mock.control.setCallState(subs[2]!.callId, 0);
    mock.control.clearRequests();
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    const getCalls = mock.control.requests({ endpoint: 'Calls/GetCall' });
    expect(getCalls.map((r) => r.query.callId)).toEqual([subs[2]!.callId]);
    expect(await status(ctx, subs[2]!.id)).toBe('dispatched');
  });

  it('received polls every 15 s, dispatched every 60 s, closed every 5 minutes', async () => {
    const ctx = mockContext(mock);
    const received = await deliverToMock(ctx);
    const dispatched = await deliverToMock(ctx);
    const closed = await deliverToMock(ctx);
    mock.control.setCallState(dispatched.callId, 0);
    mock.control.setCallState(closed.callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, received.id)).toBe('received');
    expect(await status(ctx, dispatched.id)).toBe('dispatched');
    expect(await status(ctx, closed.id)).toBe('closed');
    mock.control.clearRequests();

    const pendingAt: number[] = [];
    const getCallAt: Record<string, number[]> = {};
    for (let s = 1; s <= 600; s++) {
      ctx.clock.advance(SECOND);
      const before = mock.control.requests().length;
      await runStatusPollerPass(ctx);
      for (const r of mock.control.requests().slice(before)) {
        if (r.endpoint === 'Calls/GetPendingCalls') pendingAt.push(s);
        if (r.endpoint === 'Calls/GetCall') {
          const id = r.query.callId!;
          getCallAt[id] = [...(getCallAt[id] ?? []), s];
        }
      }
    }
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(pendingAt[0]).toBe(15);
    expect(new Set(gaps(pendingAt))).toEqual(new Set([15]));
    expect(getCallAt[dispatched.callId]![0]).toBe(60);
    expect(new Set(gaps(getCallAt[dispatched.callId]!))).toEqual(new Set([60]));
    expect(getCallAt[closed.callId]).toEqual([300, 600]);
    expect(getCallAt[received.callId]).toBeUndefined();
  });

  it('never polls faster than every 15 s, even with staggered deliveries and state changes', async () => {
    const ctx = mockContext(mock);
    const subs = [];
    for (let i = 0; i < 5; i++) {
      subs.push(await deliverToMock(ctx));
      ctx.clock.advanceSeconds(4);
    }
    mock.control.clearRequests();
    const pendingAt: number[] = [];
    const getCallAt: Record<string, number[]> = {};
    for (let s = 1; s <= 240; s++) {
      if (s === 40) mock.control.setCallState(subs[1]!.callId, 0);
      if (s === 70) mock.control.setCallState(subs[1]!.callId, 8);
      if (s === 100) mock.control.setCallState(subs[3]!.callId, 42);
      ctx.clock.advance(SECOND);
      const before = mock.control.requests().length;
      await runStatusPollerPass(ctx);
      for (const r of mock.control.requests().slice(before)) {
        if (r.endpoint === 'Calls/GetPendingCalls') pendingAt.push(s);
        if (r.endpoint === 'Calls/GetCall') {
          const id = r.query.callId!;
          getCallAt[id] = [...(getCallAt[id] ?? []), s];
        }
      }
    }
    const minGap = (xs: number[]) => Math.min(...xs.slice(1).map((x, i) => x - xs[i]!));
    expect(pendingAt.length).toBeGreaterThan(5);
    expect(minGap(pendingAt)).toBeGreaterThanOrEqual(15);
    for (const times of Object.values(getCallAt)) {
      if (times.length > 1) expect(minGap(times)).toBeGreaterThanOrEqual(15);
    }
    expect(Object.keys(getCallAt).length).toBeGreaterThan(0);
  });
});

describe('status poller: the 24-hour window', () => {
  it('force-closes received and dispatched submissions and stops polling everything', async () => {
    const ctx = mockContext(mock);
    const received = await deliverToMock(ctx);
    const dispatched = await deliverToMock(ctx);
    const closed = await deliverToMock(ctx);
    mock.control.setCallState(dispatched.callId, 0);
    mock.control.setCallState(closed.callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);

    ctx.clock.advance(STATUS_WINDOW_MS - RECEIVED_INTERVAL_MS - SECOND);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, received.id)).toBe('received');
    expect(await status(ctx, dispatched.id)).toBe('dispatched');

    ctx.clock.advance(SECOND);
    mock.control.clearRequests();
    await runStatusPollerPass(ctx);
    expect(count('*')).toBe(0);
    for (const s of [received, dispatched, closed]) {
      const row = await getSubmission(ctx.db, s.id);
      expect(row.status).toBe('closed');
      expect(row.next_poll_at).toBeNull();
    }
    expect((await eventsFor(ctx.db, received.id)).at(-1)).toMatchObject({
      from_status: 'received',
      to_status: 'closed',
      cause: POLL_CAUSES.windowEnded,
    });
    expect((await eventsFor(ctx.db, dispatched.id)).at(-1)).toMatchObject({
      from_status: 'dispatched',
      to_status: 'closed',
      cause: POLL_CAUSES.windowEnded,
    });
    // The already-closed one gets no extra event.
    expect((await eventsFor(ctx.db, closed.id)).at(-1)!.cause).toBe('core_state_1');
    expect((await getSubmission(ctx.db, received.id)).closed_at).toEqual(ctx.clock.now());
  });

  it('a re-open in Core after the window cannot resurrect the submission', async () => {
    const ctx = mockContext(mock);
    const s = await deliverToMock(ctx);
    mock.control.setCallState(s.callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    ctx.clock.advance(STATUS_WINDOW_MS);
    await runStatusPollerPass(ctx);
    mock.control.setCallState(s.callId, 0);
    mock.control.clearRequests();
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(CLOSED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
    }
    expect(count('*')).toBe(0);
    expect(await status(ctx, s.id)).toBe('closed');
  });

  it('the forced close also runs while delivery is paused', async () => {
    const ctx = mockContext(mock);
    const s = await deliverToMock(ctx);
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    ctx.clock.advance(STATUS_WINDOW_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, s.id)).toBe('closed');
  });
});

describe('status poller: pause and Core failures (PRD §8.4, integration.md §5.1)', () => {
  it('makes no Core requests at all while paused', async () => {
    const ctx = mockContext(mock);
    const a = await deliverToMock(ctx);
    const b = await deliverToMock(ctx);
    mock.control.setCallState(b.callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    mock.control.setCallState(a.callId, 1);
    mock.control.clearRequests();
    for (let i = 0; i < 12; i++) {
      ctx.clock.advance(MINUTE);
      await runStatusPollerPass(ctx);
    }
    expect(count('*')).toBe(0);
    expect(await status(ctx, a.id)).toBe('received');
  });

  it('a 401 on GetPendingCalls pauses delivery with one critical alert', async () => {
    const ctx = mockContext(mock);
    await deliverToMock(ctx);
    mock.control.injectFault('Calls/GetPendingCalls', { status: 401 });
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    const state = await getState(ctx.db);
    expect(state.paused).toBe(true);
    expect(state.paused_reason).toContain('GetPendingCalls');
    expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.deliveryPaused }]);

    mock.control.clearRequests();
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(count('*')).toBe(0);
    expect(ctx.alerts.alerts).toHaveLength(1);
  });

  it('a 401 on GetCall alone does not pause when GetNewCallFieldPolicy works', async () => {
    const ctx = mockContext(mock);
    const a = await deliverToMock(ctx);
    const b = await deliverToMock(ctx);
    mock.control.setCallState(a.callId, 0);
    mock.control.setCallState(b.callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    mock.control.setCallState(a.callId, 1);
    mock.control.setCallState(b.callId, 1);
    mock.control.clearRequests();
    mock.control.injectFault('Calls/GetCall', { status: 401 });

    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect((await getState(ctx.db)).paused).toBe(false);
    expect(count('Calls/GetNewCallFieldPolicy')).toBe(1);
    expect(ctx.alerts.alerts).toEqual([]);
    // The refused call is skipped; the pass carries on with the next one.
    const statuses = [await status(ctx, a.id), await status(ctx, b.id)].sort();
    expect(statuses).toEqual(['closed', 'dispatched']);

    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, a.id)).toBe('closed');
    expect(await status(ctx, b.id)).toBe('closed');
  });

  it('a 401 on GetCall pauses when GetNewCallFieldPolicy is refused too', async () => {
    const ctx = mockContext(mock);
    const a = await deliverToMock(ctx);
    const b = await deliverToMock(ctx);
    mock.control.setCallState(a.callId, 0);
    mock.control.setCallState(b.callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    mock.control.setApiKey(`rgk_Revoked1_${'r'.repeat(43)}`);
    mock.control.clearRequests();

    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    const state = await getState(ctx.db);
    expect(state.paused).toBe(true);
    expect(state.paused_reason).toContain('GetCall');
    // One GetCall, one confirmation, then nothing more.
    expect(mock.control.requests().map((r) => r.endpoint)).toEqual([
      'Calls/GetCall',
      'Calls/GetNewCallFieldPolicy',
    ]);
    expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.deliveryPaused }]);
    expect(await status(ctx, a.id)).toBe('dispatched');
  });

  it('retryable faults leave every status untouched until the next interval', async () => {
    const ctx = mockContext(mock);
    const r = await deliverToMock(ctx);
    const d = await deliverToMock(ctx);
    mock.control.setCallState(d.callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    mock.control.setCallState(r.callId, 0);
    mock.control.setCallState(d.callId, 1);

    mock.control.injectFault('Calls/GetPendingCalls', { status: 503 });
    mock.control.injectFault('Calls/GetCall', { status: 500 });
    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(mock.control.pendingFaults()).toBe(0);
    expect(await status(ctx, r.id)).toBe('received');
    expect(await status(ctx, d.id)).toBe('dispatched');
    expect((await getState(ctx.db)).paused).toBe(false);
    expect(ctx.alerts.alerts).toEqual([]);

    // A pass in between does not retry early.
    mock.control.clearRequests();
    ctx.clock.advance(5 * SECOND);
    await runStatusPollerPass(ctx);
    expect(count('*')).toBe(0);

    ctx.clock.advance(RECEIVED_INTERVAL_MS - 5 * SECOND);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, r.id)).toBe('dispatched');
    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, d.id)).toBe('closed');
  });

  it('a timeout from Core is retryable too', async () => {
    const ctx = mockContext(mock);
    const r = await deliverToMock(ctx);
    mock.control.setCallState(r.callId, 0);
    mock.control.injectFault('Calls/GetPendingCalls', { drop: true });
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, r.id)).toBe('received');
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, r.id)).toBe('dispatched');
  });
});

describe('status poller: re-open while the device has a newer open SOS', () => {
  it('keeps the old submission closed, records why, and applies the re-open once the newer one closes', async () => {
    const ctx = mockContext(mock);
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    const old = await deliverToMock(ctx, { deviceId });
    mock.control.setCallState(old.callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, old.id)).toBe('closed');

    const newer = await deliverToMock(ctx, { deviceId });
    mock.control.setCallState(old.callId, 0);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);

    expect(await getSubmission(ctx.db, old.id)).toMatchObject({ status: 'closed', core_state: 0 });
    expect(await status(ctx, newer.id)).toBe('received');
    expect((await eventsFor(ctx.db, old.id)).at(-1)).toMatchObject({
      from_status: 'closed',
      to_status: 'closed',
      cause: POLL_CAUSES.reopenSuppressed,
    });

    // Still re-opened at the next poll: no second event.
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(
      (await eventsFor(ctx.db, old.id)).filter((e) => e.cause === POLL_CAUSES.reopenSuppressed),
    ).toHaveLength(1);

    // The newer SOS closes; the old call is still active in Core, so the old submission shows it.
    mock.control.setCallState(newer.callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, newer.id)).toBe('closed');
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, old.id)).toBe('dispatched');
  });
});

describe('status poller: demo submissions (PRD §6.3, AC11)', () => {
  async function insertDemo(ctx: ReturnType<typeof createTestContext>): Promise<string> {
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, deviceId, ctx.clock.now(), {
      is_demo: true,
      intake_code: DEMO_INTAKE_CODE,
    });
    expect(await attemptDelivery(ctx, id)).toBe('received');
    return id;
  }

  it('walks received → dispatched → closed at the configured times, never touching Core', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertDemo(ctx);
    const times: Record<string, number> = {};
    for (let s = 1; s <= 120; s++) {
      ctx.clock.advance(SECOND);
      await runStatusPollerPass(ctx);
      const st = await status(ctx, id);
      times[st] ??= s;
    }
    expect(times).toEqual({ received: 1, dispatched: 30, closed: 90 });
    const row = await getSubmission(ctx.db, id);
    expect(row.next_poll_at).toBeNull();
    expect(row.closed_at).not.toBeNull();
    expect(await eventsFor(ctx.db, id)).toMatchObject([
      { from_status: 'queued', to_status: 'received', cause: 'demo' },
      { from_status: 'received', to_status: 'dispatched', cause: POLL_CAUSES.demoDispatched },
      { from_status: 'dispatched', to_status: 'closed', cause: POLL_CAUSES.demoClosed },
    ]);
    expect(ctx.alerts.alerts).toEqual([]);
    expect(await strikesFor(ctx.db)).toEqual([]);
  });

  it('keeps moving while delivery is paused', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertDemo(ctx);
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    ctx.clock.advanceSeconds(30);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('dispatched');
    ctx.clock.advanceSeconds(60);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('closed');
  });

  it('a late pass still records every step', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertDemo(ctx);
    ctx.clock.advance(2 * HOUR);
    await runStatusPollerPass(ctx);
    expect((await eventsFor(ctx.db, id)).map((e) => e.to_status)).toEqual([
      'received',
      'dispatched',
      'closed',
    ]);
  });

  it('follows DEMO_DISPATCH_AFTER_S and DEMO_CLOSE_AFTER_S', async () => {
    const base = createTestContext({ core: unusedCore() });
    const ctx = createTestContext({
      core: unusedCore(),
      config: { ...base.config, demoDispatchAfterS: 5, demoCloseAfterS: 20 },
    });
    const id = await insertDemo(ctx);
    ctx.clock.advanceSeconds(15);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('dispatched');
    ctx.clock.advanceSeconds(4);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('dispatched');
    ctx.clock.advanceSeconds(1);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, id)).toBe('closed');
  });

  it('a demo and a real submission side by side: only the real one reaches Core', async () => {
    const ctx = mockContext(mock);
    const demo = await insertDemo(ctx);
    const real = await deliverToMock(ctx);
    mock.control.clearRequests();
    ctx.clock.advanceSeconds(90);
    await runStatusPollerPass(ctx);
    expect(await status(ctx, demo)).toBe('closed');
    expect(await status(ctx, real.id)).toBe('received');
    expect(mock.control.requests().map((r) => r.endpoint)).toEqual(['Calls/GetPendingCalls']);
  });
});

describe('status poller: robustness', () => {
  it('a Core client that throws is treated as a transient failure', async () => {
    const ctx = mockContext(mock);
    const r = await deliverToMock(ctx);
    const throwing: CoreClient = {
      ...ctx.core,
      getPendingCalls: async () => {
        throw new Error('boom');
      },
    };
    ctx.core = throwing;
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await expect(runStatusPollerPass(ctx)).resolves.toBeUndefined();
    expect(await status(ctx, r.id)).toBe('received');
  });
});
