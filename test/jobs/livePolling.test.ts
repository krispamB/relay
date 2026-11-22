/**
 * Slice 8 of docs/live-sos-plan.md: watched scheduling for GetCall (D13, §5.1) and the unit poll
 * step. Real Postgres, the real Core client against mock-core.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { ALERT_CODES } from '../../src/alerts.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { SECOND } from '../../src/clock.js';
import { attemptDelivery } from '../../src/delivery/deliver.js';
import {
  CLOSED_INTERVAL_MS,
  DISPATCHED_INTERVAL_MS,
  RECEIVED_INTERVAL_MS,
  runStatusPollerPass,
} from '../../src/jobs/statusPoller.js';
import { readSnapshot } from '../../src/live/read.js';
import { unitKey } from '../../src/live/units.js';
import { WATCH_MS, watchSubmission } from '../../src/live/watch.js';
import { getState, pauseDelivery } from '../../src/state.js';
import { getSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, DEMO_INTAKE_CODE, resetDb, testConfig } from '../helpers/context.js';
import { deliverToMock, insertSubmissionOn, insertUser, mockContext } from './fixtures.js';

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

type Ctx = ReturnType<typeof mockContext>;
type Endpoint = 'Calls/GetCall' | 'UnitStatus/GetAllUnitStatuses' | 'Calls/GetPendingCalls';

const count = (endpoint: Endpoint) => mock.control.requests({ endpoint }).length;

/** Delivers an SOS to the mock and moves it to `dispatched` with one poll. */
async function dispatchedSos(ctx: Ctx) {
  const sos = await deliverToMock(ctx);
  mock.control.setCallState(sos.callId, 0);
  ctx.clock.advance(RECEIVED_INTERVAL_MS);
  await runStatusPollerPass(ctx);
  expect((await getSubmission(ctx.db, sos.id)).status).toBe('dispatched');
  return sos;
}

/** Runs one pass a second for `seconds`, recording at which second each request went out. */
async function run(
  ctxs: Ctx[],
  seconds: number,
  each?: (s: number) => Promise<void>,
): Promise<{ getCall: Record<string, number[]>; units: number[] }> {
  const getCall: Record<string, number[]> = {};
  const units: number[] = [];
  for (let s = 1; s <= seconds; s++) {
    ctxs[0]!.clock.advance(SECOND);
    await each?.(s);
    const before = mock.control.requests().length;
    await Promise.all(ctxs.map((c) => runStatusPollerPass(c)));
    for (const r of mock.control.requests().slice(before)) {
      if (r.endpoint === 'Calls/GetCall') {
        const id = r.query.callId!;
        getCall[id] = [...(getCall[id] ?? []), s];
      }
      if (r.endpoint === 'UnitStatus/GetAllUnitStatuses') units.push(s);
    }
  }
  return { getCall, units };
}

const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

function unitRow(over: Record<string, unknown>) {
  return {
    UnitId: 214,
    Name: 'Medic 7',
    Type: 'Ambulance',
    State: 'En Route',
    StateId: 5,
    DestinationType: 2,
    DestinationId: 0,
    DestinationName: 'SOS caller',
    Latitude: 6.53,
    Longitude: 3.3792,
    Timestamp: '2026-11-17T13:00:00',
    TimestampUtc: '2026-11-17T12:00:10Z',
    GroupName: 'Station 3',
    GroupId: 9,
    Note: 'crew of two',
    ...over,
  };
}

const liveUnitSecret = () => deriveAuthKeys(testConfig().auth.tokenSecret).liveUnit.toString('hex');

describe('watchSubmission (plan §5.1)', () => {
  it('watches for 60 s from now', async () => {
    const ctx = mockContext(mock);
    const { id } = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, id, ctx.clock.now());
    expect((await getSubmission(ctx.db, id)).live_watch_until).toEqual(
      new Date(ctx.clock.now().getTime() + WATCH_MS),
    );
    expect(WATCH_MS).toBe(60 * SECOND);
  });

  it('pulls the next GetCall earlier, never below the last read + 15 s, never later', async () => {
    const ctx = mockContext(mock);
    const { id } = await dispatchedSos(ctx);
    const readAt = ctx.clock.now().getTime();
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(new Date(readAt + DISPATCHED_INTERVAL_MS));

    ctx.clock.advanceSeconds(5);
    await watchSubmission(ctx.db, id, ctx.clock.now());
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(new Date(readAt + 15 * SECOND));

    ctx.clock.advanceSeconds(2);
    await watchSubmission(ctx.db, id, ctx.clock.now());
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(new Date(readAt + 15 * SECOND));
  });

  it('a subscribe long after the last read makes the call due at once', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await dispatchedSos(ctx);
    ctx.clock.advanceSeconds(40);
    await watchSubmission(ctx.db, id, ctx.clock.now());
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(ctx.clock.now());
    mock.control.clearRequests();
    await runStatusPollerPass(ctx);
    expect(mock.control.requests({ endpoint: 'Calls/GetCall' }).map((r) => r.query.callId)).toEqual([callId]);
  });

  it('leaves a queued SOS unscheduled and a demo SOS on its timetable', async () => {
    const ctx = mockContext(mock);
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const queued = await insertSubmissionOn(ctx.db, userId, ctx.clock.now());
    const demoUser = await insertUser(ctx.db, ctx.clock.now());
    const demo = await insertSubmissionOn(ctx.db, demoUser, ctx.clock.now(), {
      is_demo: true,
      intake_code: DEMO_INTAKE_CODE,
    });
    expect(await attemptDelivery(ctx, demo)).toBe('received');
    const demoNext = (await getSubmission(ctx.db, demo)).next_poll_at;
    ctx.clock.advanceSeconds(20);
    await watchSubmission(ctx.db, queued, ctx.clock.now());
    await watchSubmission(ctx.db, demo, ctx.clock.now());
    expect((await getSubmission(ctx.db, queued)).next_poll_at).toBeNull();
    expect((await getSubmission(ctx.db, demo)).next_poll_at).toEqual(demoNext);
    expect((await getSubmission(ctx.db, queued)).live_watch_until).not.toBeNull();
  });
});

describe('watched GetCall scheduling (D13)', () => {
  it('a watched dispatched SOS is read every 15 s; when the watch lapses, every 60 s again', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await dispatchedSos(ctx);
    mock.control.clearRequests();
    // Subscribe at once, ping every 25 s for 100 s; the watch then lasts 60 s past the last ping.
    const { getCall } = await run([ctx], 400, async (s) => {
      if (s === 1 || (s % 25 === 0 && s <= 100)) await watchSubmission(ctx.db, id, ctx.clock.now());
    });
    const times = getCall[callId]!;
    const lapse = 100 + WATCH_MS / SECOND;
    const watched = times.filter((t) => t <= lapse);
    const after = times.filter((t) => t > lapse);
    expect(watched[0]).toBe(15);
    expect(new Set(gaps(watched))).toEqual(new Set([15]));
    expect(after.length).toBeGreaterThan(2);
    expect(after[0]! - watched.at(-1)!).toBeGreaterThanOrEqual(15);
    expect(new Set(gaps(after))).toEqual(new Set([60]));
  });

  it('a watched closed SOS is read every 15 s too', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 1);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(
      new Date(ctx.clock.now().getTime() + CLOSED_INTERVAL_MS),
    );
    mock.control.clearRequests();
    const { getCall } = await run([ctx], 60, async (s) => {
      if (s % 25 === 1) await watchSubmission(ctx.db, id, ctx.clock.now());
    });
    expect(getCall[callId]).toEqual([15, 30, 45, 60]);
  });

  it('a watched SOS that moves to dispatched keeps the 15 s beat', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    await watchSubmission(ctx.db, id, ctx.clock.now());
    mock.control.setCallState(callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect((await getSubmission(ctx.db, id)).status).toBe('dispatched');
    expect((await getSubmission(ctx.db, id)).next_poll_at).toEqual(
      new Date(ctx.clock.now().getTime() + 15 * SECOND),
    );
  });

  it('never reads one call more often than every 15 s, across two instances', async () => {
    const a = mockContext(mock);
    const b = mockContext(mock);
    b.clock = a.clock;
    const subs = [await dispatchedSos(a), await dispatchedSos(a)];
    a.clock.advanceSeconds(3);
    const closed = await deliverToMock(a);
    mock.control.setCallState(closed.callId, 1);
    subs.push(closed);
    const received = await deliverToMock(a);
    subs.push(received);
    mock.control.setUnitStatuses([unitRow({ DestinationId: Number(subs[0]!.callId) })]);
    mock.control.clearRequests();

    // Both instances hold sockets for every SOS and refresh the watch every second (a worst case:
    // subscribes and pings far more often than the app sends them).
    const { getCall, units } = await run([a, b], 200, async (s) => {
      if (s > 150) return;
      for (const sos of subs) {
        await Promise.all([
          watchSubmission(a.db, sos.id, a.clock.now()),
          watchSubmission(b.db, sos.id, a.clock.now()),
        ]);
      }
      // A dispatcher moves calls around mid-run.
      if (s === 40) mock.control.setCallState(subs[1]!.callId, 8);
      if (s === 70) mock.control.setCallState(subs[1]!.callId, 0);
      if (s === 90) mock.control.setCallState(received.callId, 0);
    });
    expect(Object.keys(getCall).length).toBeGreaterThanOrEqual(3);
    for (const times of Object.values(getCall)) {
      expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(15);
    }
    // Watched dispatched calls were read on the 15 s floor, not slower.
    expect(getCall[subs[0]!.callId]!.filter((t) => t <= 150).length).toBeGreaterThanOrEqual(9);
    expect(units.length).toBeGreaterThan(10);
    expect(Math.min(...gaps(units))).toBeGreaterThanOrEqual(10);
  });
});

describe('unit poll step (plan §5.1, D11, D12)', () => {
  it('keeps only units headed to this call, and never stores anything else from the response', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    const other = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    mock.control.setUnitStatuses([
      unitRow({ UnitId: 214, DestinationId: Number(sos.callId) }),
      // Heading to a different call.
      unitRow({ UnitId: 215, DestinationId: Number(other.callId), Latitude: 7.77, Longitude: 8.88 }),
      // A station whose id happens to equal the call id.
      unitRow({ UnitId: 216, DestinationType: 1, DestinationId: Number(sos.callId), Latitude: 9.99 }),
      // No destination at all.
      unitRow({ UnitId: 217, DestinationType: null, DestinationId: null, Latitude: 5.55 }),
    ]);
    mock.control.clearRequests();
    ctx.clock.advanceSeconds(1);
    await runStatusPollerPass(ctx);
    expect(count('UnitStatus/GetAllUnitStatuses')).toBe(1);

    const rows = await ctx.db.selectFrom('submission_units').selectAll().execute();
    expect(rows).toEqual([
      {
        submission_id: sos.id,
        unit_key: unitKey(liveUnitSecret(), '214'),
        unit_type: 'Ambulance',
        status_text: 'En Route',
        lat: 6.53,
        lon: 3.3792,
        status_at: new Date('2026-11-17T12:00:10Z'),
      },
    ]);
    expect(rows[0]!.unit_key).toMatch(/^u_[0-9a-f]{32}$/);
    // The unwatched SOS has no units even though a unit is heading to it.
    const dump = JSON.stringify(
      (await sql`SELECT * FROM submission_units`.execute(ctx.db)).rows.concat(
        (await sql`SELECT * FROM submissions`.execute(ctx.db)).rows,
      ),
    );
    for (const absent of [
      '7.77',
      '8.88',
      '9.99',
      '5.55',
      'Medic 7',
      'Station 3',
      'crew of two',
      'SOS caller',
    ]) {
      expect(dump).not.toContain(absent);
    }

    const snap = await readSnapshot(ctx.db, sos.id, sos.userId, ctx.clock.now());
    expect(snap?.units).toEqual([
      {
        key: rows[0]!.unit_key,
        type: 'Ambulance',
        status: 'En Route',
        lat: 6.53,
        lon: 3.3792,
        distanceM: 623,
        updatedAt: '2026-11-17T12:00:10.000Z',
      },
    ]);
    expect(JSON.stringify(snap)).not.toMatch(/Medic 7|Station 3|"214"/);
  });

  it('bumps live_version only when something shown changes', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    const v = async () => Number((await getSubmission(ctx.db, sos.id)).live_version);
    const step = async () => {
      ctx.clock.advanceSeconds(10);
      await watchSubmission(ctx.db, sos.id, ctx.clock.now());
      await runStatusPollerPass(ctx);
    };
    const start = await v();
    const dest = { DestinationId: Number(sos.callId) };

    mock.control.setUnitStatuses([unitRow(dest)]);
    await step();
    expect(await v()).toBe(start + 1);
    await step(); // the same list again (Core's other fields may differ: Name, Note, local Timestamp)
    mock.control.setUnitStatuses([unitRow({ ...dest, Name: 'Medic 8', Note: 'x', Timestamp: 'y' })]);
    await step();
    expect(await v()).toBe(start + 1);

    for (const change of [
      { Latitude: 6.54 },
      { State: 'On Scene' },
      { Type: 'Engine' },
      { TimestampUtc: '2026-11-17T12:05:00Z' },
    ]) {
      const before = await v();
      mock.control.setUnitStatuses([unitRow({ ...dest, ...change })]);
      await step();
      expect(await v()).toBe(before + 1);
      mock.control.setUnitStatuses([unitRow(dest)]);
      await step();
    }

    // A second unit joins, then the first leaves the call: the set of keys changed each time.
    const before = await v();
    mock.control.setUnitStatuses([unitRow(dest), unitRow({ ...dest, UnitId: 300 })]);
    await step();
    mock.control.setUnitStatuses([
      unitRow({ ...dest, UnitId: 300 }),
      unitRow({ UnitId: 214, DestinationId: 1 }),
    ]);
    await step();
    expect(await v()).toBe(before + 2);
    expect(
      (await ctx.db.selectFrom('submission_units').select('unit_key').execute()).map((r) => r.unit_key),
    ).toEqual([unitKey(liveUnitSecret(), '300')]);
  });

  it('runs every UNIT_POLL_INTERVAL_S, only while a watched SOS is dispatched', async () => {
    const ctx = mockContext(mock, { ...testConfig(), unitPollIntervalS: 20 });
    const sos = await dispatchedSos(ctx);
    mock.control.setUnitStatuses([unitRow({ DestinationId: Number(sos.callId) })]);
    mock.control.clearRequests();

    // Not watched: no unit poll at all.
    let r = await run([ctx], 30);
    expect(r.units).toEqual([]);

    r = await run([ctx], 100, async (s) => {
      if (s <= 60 && s % 25 === 1) await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    });
    // Watched from s = 1 until the watch lapses 60 s after the last ping at s = 51.
    expect(r.units[0]).toBe(1);
    expect(new Set(gaps(r.units))).toEqual(new Set([20]));
    expect(r.units.at(-1)).toBeLessThanOrEqual(111);
    expect(r.units.every((s) => s <= 111)).toBe(true);
  });

  it('a watched SOS that is not dispatched starts no unit poll', async () => {
    const ctx = mockContext(mock);
    const { id } = await deliverToMock(ctx);
    mock.control.setUnitStatuses([unitRow({})]);
    const r = await run([ctx], 30, async (s) => {
      if (s === 1) await watchSubmission(ctx.db, id, ctx.clock.now());
    });
    expect(r.units).toEqual([]);
  });

  it('leaving dispatched deletes the units and bumps', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    mock.control.setUnitStatuses([unitRow({ DestinationId: Number(sos.callId) })]);
    ctx.clock.advanceSeconds(1);
    await runStatusPollerPass(ctx);
    expect(await ctx.db.selectFrom('submission_units').selectAll().execute()).toHaveLength(1);
    const before = Number((await getSubmission(ctx.db, sos.id)).live_version);

    mock.control.setCallState(sos.callId, 1);
    ctx.clock.advanceSeconds(15);
    await runStatusPollerPass(ctx);
    const row = await getSubmission(ctx.db, sos.id);
    expect(row.status).toBe('closed');
    expect(Number(row.live_version)).toBe(before + 1);
    expect(await ctx.db.selectFrom('submission_units').selectAll().execute()).toEqual([]);
  });

  it('a 401 or 403 pauses delivery with the critical alert', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    mock.control.setScopes(['calls.create', 'calls.read', 'calls.update', 'reference.read']);
    ctx.clock.advanceSeconds(1);
    await runStatusPollerPass(ctx);
    expect((await getState(ctx.db)).paused).toBe(true);
    expect(ctx.alerts.alerts).toContainEqual(
      expect.objectContaining({ severity: 'critical', code: ALERT_CODES.deliveryPaused }),
    );
  });

  it('a retryable failure waits for the next interval and keeps the units it has', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    mock.control.setUnitStatuses([unitRow({ DestinationId: Number(sos.callId) })]);
    ctx.clock.advanceSeconds(1);
    await runStatusPollerPass(ctx);
    mock.control.injectFault('UnitStatus/GetAllUnitStatuses', { status: 503 });
    mock.control.clearRequests();
    const r = await run([ctx], 25, async (s) => {
      if (s === 1) await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    });
    expect(r.units).toEqual([10, 20]);
    expect((await getState(ctx.db)).paused).toBe(false);
    expect(await ctx.db.selectFrom('submission_units').selectAll().execute()).toHaveLength(1);
  });

  it('makes no unit poll while delivery is paused', async () => {
    const ctx = mockContext(mock);
    const sos = await dispatchedSos(ctx);
    await watchSubmission(ctx.db, sos.id, ctx.clock.now());
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    mock.control.setUnitStatuses([unitRow({ DestinationId: Number(sos.callId) })]);
    mock.control.clearRequests();
    await run([ctx], 30);
    expect(count('UnitStatus/GetAllUnitStatuses')).toBe(0);
  });

  it('a demo SOS never reaches Core, watched or not', async () => {
    const ctx = createTestContext();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now(), {
      is_demo: true,
      intake_code: DEMO_INTAKE_CODE,
    });
    expect(await attemptDelivery(ctx, id)).toBe('received');
    // unusedCore throws on any Core call.
    for (let s = 0; s < 120; s++) {
      ctx.clock.advance(SECOND);
      await watchSubmission(ctx.db, id, ctx.clock.now());
      await runStatusPollerPass(ctx);
    }
    expect((await getSubmission(ctx.db, id)).status).toBe('closed');
  });
});
