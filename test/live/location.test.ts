/**
 * storeLiveLocation (docs/live-sos-plan.md D14, §5.2): the caller's socket location is kept on the
 * submission, at most one per 5 s per submission across instances, enforced in SQL. Real Postgres.
 */
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { SECOND } from '../../src/clock.js';
import { createDb } from '../../src/db/index.js';
import { LOCATION_INTERVAL_MS, storeLiveLocation } from '../../src/live/location.js';
import { getSubmission, insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const t0 = new Date('2026-11-22T09:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

async function sos(status: 'queued' | 'dispatched' | 'closed' | 'failed' = 'queued') {
  const id = await insertSubmission(testDb(), t0, { status });
  const { user_id } = await getSubmission(testDb(), id);
  return { id, userId: user_id };
}

describe('storeLiveLocation', () => {
  it('stores the fix and its capture time, and bumps the live version', async () => {
    const { id, userId } = await sos();
    const stored = await storeLiveLocation(
      testDb(),
      id,
      userId,
      { lat: 6.1, lon: 3.2, capturedAt: at(-2000) },
      t0,
    );
    expect(stored).toBe(true);
    const row = await getSubmission(testDb(), id);
    expect(row).toMatchObject({ live_lat: 6.1, live_lon: 3.2, live_version: '1' });
    expect(row.live_at?.toISOString()).toBe(at(-2000).toISOString());
  });

  it('ignores a second fix within 5 s of the last one stored, and takes one at 5 s', async () => {
    expect(LOCATION_INTERVAL_MS).toBe(5 * SECOND);
    const { id, userId } = await sos();
    await storeLiveLocation(testDb(), id, userId, { lat: 6.1, lon: 3.2, capturedAt: t0 }, t0);
    expect(
      await storeLiveLocation(testDb(), id, userId, { lat: 6.2, lon: 3.2, capturedAt: at(4999) }, at(4999)),
    ).toBe(false);
    expect(
      await storeLiveLocation(testDb(), id, userId, { lat: 6.3, lon: 3.2, capturedAt: at(5000) }, at(5000)),
    ).toBe(true);
    const row = await getSubmission(testDb(), id);
    expect([row.live_lat, row.live_version]).toEqual([6.3, '2']);
  });

  it('holds across instances: of many concurrent fixes from two pools, exactly one is stored', async () => {
    const { id, userId } = await sos();
    const other = createDb(inject('databaseUrl'), 5);
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          storeLiveLocation(
            i % 2 ? other : testDb(),
            id,
            userId,
            { lat: 6 + i / 100, lon: 3, capturedAt: t0 },
            t0,
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await getSubmission(testDb(), id)).live_version).toBe('1');
    } finally {
      await other.destroy();
    }
  });

  it('never replaces a fix with an older one', async () => {
    const { id, userId } = await sos();
    await storeLiveLocation(testDb(), id, userId, { lat: 6.1, lon: 3.2, capturedAt: t0 }, t0);
    expect(
      await storeLiveLocation(
        testDb(),
        id,
        userId,
        { lat: 6.2, lon: 3.2, capturedAt: at(-60_000) },
        at(10_000),
      ),
    ).toBe(false);
    expect((await getSubmission(testDb(), id)).live_lat).toBe(6.1);
  });

  it('stores nothing for a closed or failed SOS, or another user’s', async () => {
    for (const status of ['closed', 'failed'] as const) {
      const { id, userId } = await sos(status);
      expect(await storeLiveLocation(testDb(), id, userId, { lat: 6, lon: 3, capturedAt: t0 }, t0)).toBe(
        false,
      );
      expect((await getSubmission(testDb(), id)).live_lat).toBeNull();
    }
    const { id } = await sos();
    const stranger = await sos();
    expect(
      await storeLiveLocation(testDb(), id, stranger.userId, { lat: 6, lon: 3, capturedAt: t0 }, t0),
    ).toBe(false);
    expect((await getSubmission(testDb(), id)).live_version).toBe('0');
  });
});
