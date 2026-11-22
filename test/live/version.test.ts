/**
 * Seam 2 of docs/live-sos-seams.md: bumpLiveVersion raises submissions.live_version and NOTIFYs
 * LIVE_CHANNEL with the submission id, delivered on commit only. Against real Postgres, with a
 * listening connection of its own, as the fan-out (plan §5.4) will hold one.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { bumpLiveVersion, LIVE_CHANNEL } from '../../src/live/version.js';
import { getSubmission, insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

let listener: pg.Client;
let received: { channel: string; payload: string | undefined }[];

beforeEach(async () => {
  await resetDb();
  received = [];
  listener = new pg.Client({ connectionString: inject('databaseUrl') });
  await listener.connect();
  listener.on('notification', (n) => received.push({ channel: n.channel, payload: n.payload }));
  await listener.query(`LISTEN ${LIVE_CHANNEL}`);
});
afterEach(async () => {
  await listener.end();
});
afterAll(() => closeTestDb());

/** Notifications arrive asynchronously; a round trip on the listener flushes any that are pending. */
async function settle(): Promise<void> {
  await listener.query('SELECT 1');
  await new Promise((r) => setTimeout(r, 50));
}

const now = new Date('2026-11-22T09:00:00.000Z');

describe('bumpLiveVersion', () => {
  it('uses the channel sos_live', () => {
    expect(LIVE_CHANNEL).toBe('sos_live');
  });

  it('a LISTEN connection receives the submission id after commit, not before', async () => {
    const id = await insertSubmission(testDb(), now);
    let beforeCommit: typeof received = [];
    await testDb()
      .transaction()
      .execute(async (trx) => {
        await bumpLiveVersion(trx, id);
        await settle();
        beforeCommit = [...received];
      });
    expect(beforeCommit).toEqual([]);
    await settle();
    expect(received).toEqual([{ channel: 'sos_live', payload: id }]);
    expect((await getSubmission(testDb(), id)).live_version).toBe('1');
  });

  it('a rolled-back transaction sends nothing and leaves the version alone', async () => {
    const id = await insertSubmission(testDb(), now);
    await expect(
      testDb()
        .transaction()
        .execute(async (trx) => {
          await bumpLiveVersion(trx, id);
          throw new Error('roll back');
        }),
    ).rejects.toThrow('roll back');
    await settle();
    expect(received).toEqual([]);
    expect((await getSubmission(testDb(), id)).live_version).toBe('0');
  });

  it('only goes up: each bump adds one, and outside a transaction it notifies at once', async () => {
    const id = await insertSubmission(testDb(), now);
    await bumpLiveVersion(testDb(), id);
    await bumpLiveVersion(testDb(), id);
    await settle();
    expect(received.map((n) => n.payload)).toEqual([id, id]);
    expect((await getSubmission(testDb(), id)).live_version).toBe('2');
  });

  it('touches only the named submission', async () => {
    const a = await insertSubmission(testDb(), now);
    const b = await insertSubmission(testDb(), now);
    await bumpLiveVersion(testDb(), a);
    await settle();
    expect((await getSubmission(testDb(), b)).live_version).toBe('0');
    expect(received.map((n) => n.payload)).toEqual([a]);
  });
});
