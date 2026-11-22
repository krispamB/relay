/**
 * Seam 5 of docs/live-sos-seams.md: readSnapshot and readSnapshotById build the plan §5.3 snapshot
 * from the database. Against real Postgres.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NewSubmission } from '../../src/db/types.js';
import { readSnapshot, readSnapshotById } from '../../src/live/read.js';
import { getSubmission, insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const accepted = new Date('2026-11-22T09:00:00.000Z');
const now = new Date('2026-11-22T09:10:00.000Z');

async function submission(overrides: Partial<NewSubmission> = {}) {
  const id = await insertSubmission(testDb(), accepted, overrides);
  const { user_id } = await getSubmission(testDb(), id);
  return { id, userId: user_id };
}

async function recording(submissionId: string, seq: number, status: 'pending' | 'attached' | 'dropped') {
  await testDb()
    .insertInto('recordings')
    .values({
      id: `rec_${submissionId}_${seq}`,
      submission_id: submissionId,
      seq,
      idempotency_key: `k-${seq}`,
      body_hash: 'h',
      bytes: null,
      size: 10,
      duration_ms: 1000,
      status,
      created_at: accepted,
    })
    .execute();
}

async function unit(submissionId: string, key: string, lat: number | null, lon: number | null) {
  await testDb()
    .insertInto('submission_units')
    .values({
      submission_id: submissionId,
      unit_key: key,
      unit_type: 'Ambulance',
      status_text: 'En Route',
      lat,
      lon,
      status_at: new Date('2026-11-22T09:09:00.000Z'),
    })
    .execute();
}

describe('readSnapshot', () => {
  it('a fresh SOS: version 0, recording none, no units, updatedAt the acceptance time', async () => {
    const { id, userId } = await submission();
    const snap = await readSnapshot(testDb(), id, userId, now);
    expect(snap).toEqual({
      type: 'state',
      version: 0,
      receiptId: id,
      reference: expect.stringMatching(/^SOS-/),
      status: 'queued',
      updatedAt: accepted.toISOString(),
      recording: { status: 'none' },
      units: [],
    });
  });

  it('is null for another user, and for an unknown id', async () => {
    const { id } = await submission();
    const other = await submission();
    expect(await readSnapshot(testDb(), id, other.userId, now)).toBeNull();
    expect(await readSnapshot(testDb(), 'sos_missing', other.userId, now)).toBeNull();
  });

  it('version is live_version as a number', async () => {
    const { id, userId } = await submission();
    await testDb().updateTable('submissions').set({ live_version: '41' }).where('id', '=', id).execute();
    expect((await readSnapshot(testDb(), id, userId, now))?.version).toBe(41);
  });

  it('updatedAt is the time of the latest status change', async () => {
    const { id, userId } = await submission({ status: 'received' });
    const changed = new Date('2026-11-22T09:05:00.000Z');
    await testDb()
      .insertInto('submission_events')
      .values([
        { submission_id: id, from_status: null, to_status: 'queued', cause: 'accepted', at: accepted },
        {
          submission_id: id,
          from_status: 'queued',
          to_status: 'received',
          cause: 'core_created',
          at: changed,
        },
      ])
      .execute();
    expect((await readSnapshot(testDb(), id, userId, now))?.updatedAt).toBe(changed.toISOString());
  });

  it('recording status is that of the highest seq', async () => {
    const { id, userId } = await submission();
    await recording(id, 2, 'pending');
    await recording(id, 1, 'attached');
    expect((await readSnapshot(testDb(), id, userId, now))?.recording).toEqual({ status: 'pending' });
  });

  it('units show only while dispatched, with distance from the incident location', async () => {
    const { id, userId } = await submission({ status: 'dispatched', lat: 6.5244, lon: 3.3792 });
    await unit(id, 'u_far', 6.6, 3.3792);
    await unit(id, 'u_near', 6.53, 3.3792);
    await unit(id, 'u_nofix', null, null);
    const snap = await readSnapshot(testDb(), id, userId, now);
    expect(snap?.units.map((u) => u.key)).toEqual(['u_near', 'u_far', 'u_nofix']);
    expect(snap?.units[0]).toEqual({
      key: 'u_near',
      type: 'Ambulance',
      status: 'En Route',
      lat: 6.53,
      lon: 3.3792,
      distanceM: 623,
      updatedAt: '2026-11-22T09:09:00.000Z',
    });
    expect(snap?.units[2]).toEqual({
      key: 'u_nofix',
      type: 'Ambulance',
      status: 'En Route',
      updatedAt: '2026-11-22T09:09:00.000Z',
    });

    await testDb().updateTable('submissions').set({ status: 'closed' }).where('id', '=', id).execute();
    expect((await readSnapshot(testDb(), id, userId, now))?.units).toEqual([]);
  });

  it("distance uses the caller's live location while it is under 2 minutes old", async () => {
    const { id, userId } = await submission({ status: 'dispatched', lat: 6.5244, lon: 3.3792 });
    await unit(id, 'u_a', 6.53, 3.3792);
    await testDb()
      .updateTable('submissions')
      .set({ live_lat: 6.53, live_lon: 3.3792, live_at: new Date(now.getTime() - 60_000) })
      .where('id', '=', id)
      .execute();
    expect((await readSnapshot(testDb(), id, userId, now))?.units[0]?.distanceM).toBe(0);
  });
});

describe('readSnapshotById', () => {
  it('the same snapshot plus the owner id, without an owner check', async () => {
    const { id, userId } = await submission();
    const owned = await readSnapshot(testDb(), id, userId, now);
    expect(await readSnapshotById(testDb(), id, now)).toEqual({ ...owned, userId });
    expect(await readSnapshotById(testDb(), 'sos_missing', now)).toBeNull();
  });
});
