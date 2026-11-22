import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, SECOND } from '../../src/clock.js';
import { runPurgePass } from '../../src/jobs/purge.js';
import { closeTestDb, createTestContext, resetDb, type TestContext } from '../helpers/context.js';
import { insertSubmissionOn, insertUser } from '../jobs/fixtures.js';
import { capturingLogger } from '../sos/helpers.js';
import { m4a } from './fixtures.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

async function addRecording(
  ctx: TestContext,
  submissionId: string,
  opts: { status?: 'pending' | 'attached' | 'dropped'; seq?: number; bytes?: Buffer | null } = {},
): Promise<string> {
  const id = `rec_PURGE${opts.seq ?? 1}${submissionId.slice(-8)}`;
  const status = opts.status ?? 'pending';
  const bytes = opts.bytes === undefined ? (status === 'pending' ? m4a('purge', 100) : null) : opts.bytes;
  await ctx.db
    .insertInto('recordings')
    .values({
      id,
      submission_id: submissionId,
      seq: opts.seq ?? 1,
      idempotency_key: `k-${id}`,
      body_hash: 'h',
      bytes,
      size: 100,
      duration_ms: 1000,
      status,
      core_file_id: status === 'attached' ? '5' : null,
      next_attempt_at: status === 'pending' ? ctx.clock.now() : null,
      created_at: ctx.clock.now(),
    })
    .execute();
  return id;
}

const row = (ctx: TestContext, id: string) =>
  ctx.db.selectFrom('recordings').selectAll().where('id', '=', id).executeTakeFirst();

describe('purge and recordings (plan §4.4)', () => {
  it('clears the bytes of a pending recording once its SOS leaves the 24 h window, and no sooner', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const user = await insertUser(ctx.db, now);
    const past = await insertSubmissionOn(ctx.db, user, ago(now, 24 * HOUR + SECOND), { status: 'received' });
    const inside = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 23 * HOUR), {
      status: 'received',
    });
    const old = await addRecording(ctx, past);
    const young = await addRecording(ctx, inside);

    const counts = await runPurgePass(ctx);

    expect(counts.recordingsCleared).toBe(1);
    expect(await row(ctx, old)).toMatchObject({
      bytes: null,
      status: 'dropped',
      drop_reason: 'window_ended',
      next_attempt_at: null,
    });
    const kept = await row(ctx, young);
    expect(kept?.status).toBe('pending');
    expect(kept?.bytes).not.toBeNull();
  });

  it('tells the live view: bumps the live version of the SOS whose recording it dropped', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const sub = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 25 * HOUR), {
      status: 'received',
    });
    await addRecording(ctx, sub);
    await runPurgePass(ctx);
    const after = await ctx.db
      .selectFrom('submissions')
      .select('live_version')
      .where('id', '=', sub)
      .executeTakeFirstOrThrow();
    expect(Number(after.live_version)).toBe(1);
    // A second pass has nothing left to do.
    expect((await runPurgePass(ctx)).recordingsCleared).toBe(0);
    const again = await ctx.db
      .selectFrom('submissions')
      .select('live_version')
      .where('id', '=', sub)
      .executeTakeFirstOrThrow();
    expect(Number(again.live_version)).toBe(1);
  });

  it('leaves attached and dropped recordings as they are', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const sub = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 26 * HOUR), {
      status: 'closed',
    });
    const attached = await addRecording(ctx, sub, { status: 'attached', seq: 1 });
    const dropped = await addRecording(ctx, sub, { status: 'dropped', seq: 2 });
    await ctx.db
      .updateTable('recordings')
      .set({ drop_reason: 'call_closed' })
      .where('id', '=', dropped)
      .execute();
    await runPurgePass(ctx);
    expect(await row(ctx, attached)).toMatchObject({ status: 'attached', core_file_id: '5' });
    expect(await row(ctx, dropped)).toMatchObject({ status: 'dropped', drop_reason: 'call_closed' });
  });

  it('deletes recordings with their submission after 30 days (the cascade), and keeps younger ones', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const old = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 30 * DAY + SECOND), {
      status: 'closed',
    });
    const young = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 29 * DAY), {
      status: 'closed',
    });
    const gone = await addRecording(ctx, old, { status: 'attached' });
    const kept = await addRecording(ctx, young, { status: 'attached' });

    const counts = await runPurgePass(ctx);

    expect(counts.submissions).toBe(1);
    expect(await row(ctx, gone)).toBeUndefined();
    expect(await row(ctx, kept)).toBeDefined();
  });

  it('deletes a pending recording that is past 30 days too, whatever its state', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const old = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 31 * DAY), {
      status: 'received',
    });
    const id = await addRecording(ctx, old);
    await runPurgePass(ctx);
    expect(await row(ctx, id)).toBeUndefined();
  });

  it('logs counts only, never the audio', async () => {
    const { log, lines } = capturingLogger();
    const ctx = createTestContext({ log });
    const now = ctx.clock.now();
    const sub = await insertSubmissionOn(ctx.db, await insertUser(ctx.db, now), ago(now, 25 * HOUR), {
      status: 'received',
    });
    await addRecording(ctx, sub, { bytes: m4a('PURGE-MARKER-XYZ', 100) });
    await runPurgePass(ctx);
    expect(lines.join('\n')).not.toContain('PURGE-MARKER-XYZ');
    expect(lines.join('\n')).toContain('"recordingsCleared":1');
  });
});
