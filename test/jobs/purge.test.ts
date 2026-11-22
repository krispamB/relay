import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, SECOND } from '../../src/clock.js';
import { createPurgeJob, PURGE_BATCH, runPurgePass } from '../../src/jobs/purge.js';
import { closeTestDb, createTestContext, resetDb } from '../helpers/context.js';
import { insertDevice, insertSubmissionOn, insertUser } from './fixtures.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);
const ahead = (now: Date, ms: number) => new Date(now.getTime() + ms);

async function ids(ctx: ReturnType<typeof createTestContext>, table: 'submissions' | 'devices' | 'blocks') {
  return (await ctx.db.selectFrom(table).select('id').orderBy('id').execute()).map((r) => r.id);
}

describe('purge job (PRD §10.5)', () => {
  it('is hourly', () => {
    const job = createPurgeJob(createTestContext());
    expect(job.intervalMs).toBe(HOUR);
    expect(job.name).toBe('purge');
  });

  it('deletes submissions 30 days after acceptance, with their events, and not a day early', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const user = await insertUser(ctx.db, now);
    const old = await insertSubmissionOn(ctx.db, user, ago(now, 30 * DAY + SECOND), { status: 'closed' });
    const young = await insertSubmissionOn(ctx.db, user, ago(now, 29 * DAY), { status: 'closed' });
    await ctx.db
      .insertInto('submission_events')
      .values(
        [old, young].map((id) => ({
          submission_id: id,
          from_status: null,
          to_status: 'queued',
          cause: 'x',
          at: now,
        })),
      )
      .execute();

    const counts = await runPurgePass(ctx);
    expect(counts.submissions).toBe(1);
    expect(await ids(ctx, 'submissions')).toEqual([young]);
    const events = await ctx.db.selectFrom('submission_events').select('submission_id').execute();
    expect(events.map((e) => e.submission_id)).toEqual([young]);
  });

  it('deletes devices whose token expired over 30 days ago', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const gone = await insertDevice(ctx.db, now, { tokenExpiresAt: ago(now, 30 * DAY + SECOND) });
    const recentExpiry = await insertDevice(ctx.db, now, { tokenExpiresAt: ago(now, 29 * DAY) });
    await ctx.db
      .insertInto('device_registrations')
      .values({ device_id: gone, ip_hash: 'iph', created_at: ago(now, 60 * DAY) })
      .execute();

    const counts = await runPurgePass(ctx);
    expect(counts.devices).toBe(1);
    expect(await ids(ctx, 'devices')).toEqual([recentExpiry]);
    expect(await ctx.db.selectFrom('device_registrations').selectAll().execute()).toEqual([]);
  });

  it('keeps users when their submissions age out', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const user = await insertUser(ctx.db, now);
    await insertSubmissionOn(ctx.db, user, ago(now, 31 * DAY), { status: 'closed' });
    await runPurgePass(ctx);
    expect(await ids(ctx, 'submissions')).toEqual([]);
    expect((await ctx.db.selectFrom('users').select('id').execute()).map((r) => r.id)).toEqual([user]);
  });

  it('deletes expired strikes, blocks and nonces, and keeps live ones', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await ctx.db
      .insertInto('strikes')
      .values([
        {
          subject_type: 'user',
          subject: 'u1',
          submission_id: 's1',
          created_at: ago(now, 30 * DAY),
          expires_at: now,
        },
        {
          subject_type: 'user',
          subject: 'u1',
          submission_id: 's2',
          created_at: ago(now, 29 * DAY),
          expires_at: ahead(now, DAY),
        },
      ])
      .execute();
    const block = (id: string, expires_at: Date | null, source: 'automatic' | 'manual' = 'automatic') => ({
      id,
      subject_type: 'user' as const,
      subject: 'u1',
      reason: 'x',
      source,
      created_at: ago(now, 30 * DAY),
      expires_at,
    });
    await ctx.db
      .insertInto('blocks')
      .values([
        block('blk_expired', ago(now, SECOND)),
        block('blk_live', ahead(now, DAY)),
        block('blk_forever', null, 'manual'),
      ])
      .execute();
    await ctx.db
      .insertInto('nonces')
      .values([
        { nonce: 'n-old', expires_at: ago(now, SECOND) },
        { nonce: 'n-live', expires_at: ahead(now, 60 * SECOND) },
      ])
      .execute();

    const counts = await runPurgePass(ctx);
    expect(counts).toMatchObject({ strikes: 1, blocks: 1, nonces: 1 });
    expect(
      (await ctx.db.selectFrom('strikes').select('submission_id').execute()).map((s) => s.submission_id),
    ).toEqual(['s2']);
    expect(await ids(ctx, 'blocks')).toEqual(['blk_forever', 'blk_live']);
    expect((await ctx.db.selectFrom('nonces').select('nonce').execute()).map((n) => n.nonce)).toEqual([
      'n-live',
    ]);

    // A day later the live strike and block are gone too.
    ctx.clock.advance(DAY);
    await runPurgePass(ctx);
    expect(await ctx.db.selectFrom('strikes').selectAll().execute()).toEqual([]);
    expect(await ids(ctx, 'blocks')).toEqual(['blk_forever']);
  });

  it('deletes alert_log rows older than a day', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await ctx.db
      .insertInto('alert_log')
      .values([
        { code: 'old', last_sent_at: ago(now, DAY + SECOND) },
        { code: 'recent', last_sent_at: ago(now, 23 * HOUR) },
      ])
      .execute();
    expect((await runPurgePass(ctx)).alertLog).toBe(1);
    expect((await ctx.db.selectFrom('alert_log').select('code').execute()).map((r) => r.code)).toEqual([
      'recent',
    ]);
  });

  it('deletes in batches until done', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const n = PURGE_BATCH * 2 + 7;
    await ctx.db
      .insertInto('nonces')
      .values(Array.from({ length: n }, (_, i) => ({ nonce: `n${i}`, expires_at: ago(now, SECOND) })))
      .execute();
    expect((await runPurgePass(ctx)).nonces).toBe(n);
    expect(await ctx.db.selectFrom('nonces').selectAll().execute()).toEqual([]);
  });

  it('logs counts only', async () => {
    const lines: unknown[] = [];
    const base = createTestContext();
    const log = { ...base.log, info: (obj: unknown) => lines.push(obj) } as unknown as typeof base.log;
    const ctx = createTestContext({ log });
    const now = ctx.clock.now();
    const user = await insertUser(ctx.db, now);
    await insertSubmissionOn(ctx.db, user, ago(now, 31 * DAY), { status: 'closed' });
    await runPurgePass(ctx);
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toMatch(/sos_|SOS-|\+234|usr_/);
  });
});
