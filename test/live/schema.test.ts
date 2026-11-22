/**
 * Seam 1 of docs/live-sos-seams.md: migration 006 holds all of plan §6, including the tables and
 * columns that only later streams use. Column names are part of the seam, so they are pinned here.
 */
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/db/index.js';
import { insertSubmission } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

async function columns(table: string): Promise<Record<string, { type: string; nullable: boolean }>> {
  const r = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`.execute(testDb());
  return Object.fromEntries(
    r.rows.map((c) => [c.column_name, { type: c.data_type, nullable: c.is_nullable === 'YES' }]),
  );
}

const now = new Date('2026-11-22T09:00:00.000Z');

describe('migration 006: live SOS schema', () => {
  it('submissions: user_id and the live_* columns in, the device and form columns out', async () => {
    const c = await columns('submissions');
    expect(c.user_id).toEqual({ type: 'text', nullable: false });
    expect(c.live_version).toEqual({ type: 'bigint', nullable: false });
    expect(c.live_watch_until).toEqual({ type: 'timestamp with time zone', nullable: true });
    expect(c.live_lat).toEqual({ type: 'double precision', nullable: true });
    expect(c.live_lon).toEqual({ type: 'double precision', nullable: true });
    expect(c.live_at).toEqual({ type: 'timestamp with time zone', nullable: true });
    for (const gone of ['device_id', 'nature_id', 'name', 'details']) expect(c).not.toHaveProperty(gone);
    expect(c.nature_label).toEqual({ type: 'text', nullable: false });
  });

  it('relay_state: units_next_poll_at', async () => {
    expect((await columns('relay_state')).units_next_poll_at).toEqual({
      type: 'timestamp with time zone',
      nullable: true,
    });
  });

  it('recordings: the seam columns, statuses and unique keys', async () => {
    const c = await columns('recordings');
    expect(Object.keys(c).sort()).toEqual(
      [
        'id',
        'submission_id',
        'seq',
        'idempotency_key',
        'body_hash',
        'bytes',
        'size',
        'duration_ms',
        'status',
        'core_file_id',
        'attempts',
        'next_attempt_at',
        'drop_reason',
        'created_at',
        'attached_at',
      ].sort(),
    );
    expect(c.bytes).toEqual({ type: 'bytea', nullable: true });

    const submissionId = await insertSubmission(testDb(), now);
    const row = (id: string, seq: number, key: string, status = 'pending') => ({
      id,
      submission_id: submissionId,
      seq,
      idempotency_key: key,
      body_hash: 'h',
      bytes: Buffer.from([1, 2, 3]),
      size: 3,
      duration_ms: 1000,
      status: status as 'pending',
      created_at: now,
    });
    await testDb()
      .insertInto('recordings')
      .values(row('rec_1', 1, 'k1'))
      .execute();
    const sameSeq = await testDb()
      .insertInto('recordings')
      .values(row('rec_2', 1, 'k2'))
      .execute()
      .catch((e) => e);
    expect(isUniqueViolation(sameSeq)).toBe(true);
    const sameKey = await testDb()
      .insertInto('recordings')
      .values(row('rec_3', 2, 'k1'))
      .execute()
      .catch((e) => e);
    expect(isUniqueViolation(sameKey)).toBe(true);
    const badStatus = (await testDb()
      .insertInto('recordings')
      .values(row('rec_4', 3, 'k4', 'uploaded'))
      .execute()
      .catch((e) => e)) as { code?: string };
    expect(badStatus.code).toBe('23514');
    const stored = await testDb().selectFrom('recordings').selectAll().executeTakeFirstOrThrow();
    expect(stored.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(stored.attempts).toBe(0);
  });

  it('submission_units: keyed by submission and unit key; both tables go with their submission', async () => {
    const c = await columns('submission_units');
    expect(Object.keys(c).sort()).toEqual(
      ['submission_id', 'unit_key', 'unit_type', 'status_text', 'lat', 'lon', 'status_at'].sort(),
    );
    const submissionId = await insertSubmission(testDb(), now);
    await testDb()
      .insertInto('submission_units')
      .values({ submission_id: submissionId, unit_key: 'u_1', unit_type: 'Ambulance', lat: 4.9, lon: 6.2 })
      .execute();
    await testDb()
      .insertInto('recordings')
      .values({
        id: 'rec_c',
        submission_id: submissionId,
        seq: 1,
        idempotency_key: 'k',
        body_hash: 'h',
        size: 0,
        duration_ms: 1,
        status: 'dropped',
        created_at: now,
      })
      .execute();
    await testDb().deleteFrom('submissions').where('id', '=', submissionId).execute();
    expect(await testDb().selectFrom('submission_units').selectAll().execute()).toEqual([]);
    expect(await testDb().selectFrom('recordings').selectAll().execute()).toEqual([]);
  });

  it('strikes and blocks take the subject types user and phone only', async () => {
    const strike = (await testDb()
      .insertInto('strikes')
      .values({
        subject_type: 'device' as never,
        subject: 'd',
        submission_id: 's',
        created_at: now,
        expires_at: now,
      })
      .execute()
      .catch((e) => e)) as { code?: string };
    expect(strike.code).toBe('23514');
    await testDb()
      .insertInto('strikes')
      .values({ subject_type: 'user', subject: 'u', submission_id: 's', created_at: now, expires_at: now })
      .execute();
  });
});
