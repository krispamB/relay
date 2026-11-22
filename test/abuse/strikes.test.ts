import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { isBlocked } from '../../src/abuse/blocks.js';
import { liveStrikeCount, recordHoaxStrikes, removeStrikes } from '../../src/abuse/strikes.js';
import { ALERT_CODES } from '../../src/alerts.js';
import { DAY, SECOND } from '../../src/clock.js';
import { DEFAULT_LIMITS } from '../../src/config.js';
import {
  CLOSED_INTERVAL_MS,
  RECEIVED_INTERVAL_MS,
  runStatusPollerPass,
} from '../../src/jobs/statusPoller.js';
import { closeTestDb, resetDb, testConfig } from '../helpers/context.js';
import { deliverToMock, insertUser, mockContext, strikesFor } from '../jobs/fixtures.js';

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

function ctxWith(limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  return mockContext(mock, testConfig({ limits: { ...DEFAULT_LIMITS, ...limits } }));
}

type Ctx = ReturnType<typeof ctxWith>;

/** Delivers an SOS and has Core close it with `state`, then lets the poller see it. */
async function closedAs(
  ctx: Ctx,
  state: number,
  opts: { userId?: string; phoneHash?: string } = {},
): Promise<{ id: string; callId: string; userId: string; reference: string }> {
  const s = await deliverToMock(ctx, {
    ...(opts.userId ? { userId: opts.userId } : {}),
    overrides: opts.phoneHash ? { phone_hash: opts.phoneHash } : {},
  });
  mock.control.setCallState(s.callId, state);
  ctx.clock.advance(RECEIVED_INTERVAL_MS);
  await runStatusPollerPass(ctx);
  return s;
}

async function blocks(ctx: Ctx) {
  return ctx.db.selectFrom('blocks').selectAll().orderBy('created_at').execute();
}

describe('hoax strikes (PRD §9.2)', () => {
  it('records one strike per subject per submission, however often the hoax state is seen', async () => {
    const ctx = ctxWith();
    const s = await closedAs(ctx, 3);
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(CLOSED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
    }
    const strikes = await strikesFor(ctx.db);
    expect(strikes.map((x) => [x.subject_type, x.subject, x.submission_id])).toEqual([
      ['user', s.userId, s.id],
      ['phone', 'phone-hash-a', s.id],
    ]);
    expect(strikes[0]!.expires_at.getTime() - strikes[0]!.created_at.getTime()).toBe(30 * DAY);
  });

  it('a call moving from one hoax state to the other keeps a single strike each', async () => {
    const ctx = ctxWith();
    const s = await closedAs(ctx, 3);
    mock.control.setCallState(s.callId, 7);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await strikesFor(ctx.db)).toHaveLength(2);
  });

  it('removes the strikes when the call is re-opened', async () => {
    const ctx = ctxWith();
    const s = await closedAs(ctx, 7);
    expect(await strikesFor(ctx.db)).toHaveLength(2);
    mock.control.setCallState(s.callId, 0);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await strikesFor(ctx.db)).toEqual([]);
  });

  it('removes the strikes when the call is re-closed with a non-hoax state', async () => {
    const ctx = ctxWith();
    const s = await closedAs(ctx, 3);
    mock.control.setCallState(s.callId, 4);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await strikesFor(ctx.db)).toEqual([]);
  });

  it('blocks the user automatically at the threshold, with a warning naming the user only', async () => {
    const ctx = ctxWith();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    await closedAs(ctx, 3, { userId, phoneHash: 'phone-hash-1' });
    expect(await blocks(ctx)).toEqual([]);
    expect(await isBlocked(ctx.db, 'user', userId, ctx.clock.now())).toBe(false);

    const second = await closedAs(ctx, 7, { userId, phoneHash: 'phone-hash-2' });
    const all = await blocks(ctx);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ subject_type: 'user', subject: userId, source: 'automatic' });
    expect(all[0]!.expires_at!.getTime() - all[0]!.created_at.getTime()).toBe(30 * DAY);
    expect(await isBlocked(ctx.db, 'user', userId, ctx.clock.now())).toBe(true);

    const alerts = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.automaticBlock);
    expect(alerts).toEqual([
      expect.objectContaining({ severity: 'warning', reference: second.reference, receiptId: second.id }),
    ]);
    expect(alerts[0]!.message).toContain(userId);
    expect(alerts[0]!.message).toContain('user');
    const text = JSON.stringify(ctx.alerts.alerts);
    for (const secret of ['+2348012345678', 'phone-hash-1', 'phone-hash-2'])
      expect(text).not.toContain(secret);
  });

  it('never blocks a phone number automatically; warns once at the threshold, without naming it', async () => {
    const ctx = ctxWith();
    const a = await closedAs(ctx, 3, { phoneHash: 'phone-hash-x' });
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.phoneHoaxThreshold);
    const b = await closedAs(ctx, 3, { phoneHash: 'phone-hash-x' });
    expect(await liveStrikeCount(ctx.db, 'phone', 'phone-hash-x', ctx.clock.now())).toBe(2);
    expect(await isBlocked(ctx.db, 'phone', 'phone-hash-x', ctx.clock.now())).toBe(false);
    expect(await isBlocked(ctx.db, 'user', a.userId, ctx.clock.now())).toBe(false);
    expect(await isBlocked(ctx.db, 'user', b.userId, ctx.clock.now())).toBe(false);
    expect(await blocks(ctx)).toEqual([]);
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.automaticBlock);

    const alerts = ctx.alerts.alerts.filter((x) => x.code === ALERT_CODES.phoneHoaxThreshold);
    expect(alerts).toEqual([
      expect.objectContaining({ severity: 'warning', reference: b.reference, receiptId: b.id }),
    ]);
    expect(alerts[0]!.message).toContain(b.reference);
    expect(alerts[0]!.message).toContain('not blocked');
    const text = JSON.stringify(ctx.alerts.alerts);
    for (const secret of ['phone-hash-x', '+2348012345678', '+234']) expect(text).not.toContain(secret);
  });

  it('does not repeat the phone warning on later polls of the same hoax closures', async () => {
    const ctx = ctxWith();
    await closedAs(ctx, 3, { phoneHash: 'phone-hash-r' });
    const second = await closedAs(ctx, 7, { phoneHash: 'phone-hash-r' });
    expect(ctx.alerts.codes().filter((c) => c === ALERT_CODES.phoneHoaxThreshold)).toHaveLength(1);
    ctx.alerts.clear();
    // Both calls stay closed as hoaxes; the poller keeps reading them at the closed interval.
    mock.control.setCallState(second.callId, 3);
    for (let i = 0; i < 5; i++) {
      ctx.clock.advance(CLOSED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
    }
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.phoneHoaxThreshold);
    expect(await liveStrikeCount(ctx.db, 'phone', 'phone-hash-r', ctx.clock.now())).toBe(2);
  });

  it('warns again for each new hoax closure past the threshold', async () => {
    const ctx = ctxWith();
    for (let i = 0; i < 3; i++) await closedAs(ctx, 3, { phoneHash: 'phone-hash-m' });
    const warned = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.phoneHoaxThreshold);
    expect(warned.map((a) => a.message.match(/has (\d+) unfounded/)?.[1])).toEqual(['2', '3']);
    expect(await blocks(ctx)).toEqual([]);
  });

  it('does not warn about a phone number an operator has already blocked', async () => {
    const ctx = ctxWith();
    await ctx.db
      .insertInto('blocks')
      .values({
        id: 'blk_manual_phone',
        subject_type: 'phone',
        subject: 'phone-hash-k',
        reason: 'manual',
        source: 'manual',
        created_at: ctx.clock.now(),
        expires_at: null,
      })
      .execute();
    for (let i = 0; i < 2; i++) await closedAs(ctx, 3, { phoneHash: 'phone-hash-k' });
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.phoneHoaxThreshold);
    expect((await blocks(ctx)).map((b) => b.id)).toEqual(['blk_manual_phone']);
  });

  it('does not add a second block while one is live', async () => {
    const ctx = ctxWith();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    for (let i = 0; i < 3; i++) await closedAs(ctx, 3, { userId, phoneHash: `p${i}` });
    expect((await blocks(ctx)).filter((b) => b.subject_type === 'user')).toHaveLength(1);
  });

  it('with HOAX_STRIKES_TO_BLOCK=0 strikes are recorded but nothing is blocked or reported', async () => {
    const ctx = ctxWith({ hoaxStrikesToBlock: 0 });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    for (let i = 0; i < 3; i++) await closedAs(ctx, 7, { userId });
    expect(await strikesFor(ctx.db)).toHaveLength(6);
    expect(await blocks(ctx)).toEqual([]);
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.automaticBlock);
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.phoneHoaxThreshold);
  });

  it('an expired strike does not count toward the threshold', async () => {
    const ctx = ctxWith({ strikeTtlDays: 30 });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const first = await closedAs(ctx, 3, { userId, phoneHash: 'pa' });
    // Let the first submission's status window end so it is no longer open.
    ctx.clock.advance(30 * DAY + SECOND);
    await runStatusPollerPass(ctx);
    expect(await liveStrikeCount(ctx.db, 'user', userId, ctx.clock.now())).toBe(0);
    await closedAs(ctx, 3, { userId, phoneHash: 'pb' });
    expect(await liveStrikeCount(ctx.db, 'user', userId, ctx.clock.now())).toBe(1);
    expect(await blocks(ctx)).toEqual([]);
    expect(first.id).toBeDefined();
  });

  it('creates no strike for a demo submission (it never reaches the poller’s Core path)', async () => {
    const ctx = ctxWith();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    await ctx.db
      .insertInto('submissions')
      .values({
        id: 'sos_DEMO1',
        user_id: userId,
        idempotency_key: 'demo-key',
        intake_code: 'DEMO-DEPT',
        is_demo: true,
        reference: 'SOS-DEMO',
        status: 'received',
        nature_label: 'SOS – caller recording to follow',
        phone: '+2348012345678',
        phone_hash: 'ph-demo',
        ip: '203.0.113.1',
        accepted_at: ctx.clock.now(),
        delivered_at: ctx.clock.now(),
        next_poll_at: ctx.clock.now(),
        updated_at: ctx.clock.now(),
      })
      .execute();
    mock.control.clearRequests();
    for (let i = 0; i < 100; i++) {
      ctx.clock.advance(SECOND);
      await runStatusPollerPass(ctx);
    }
    expect(mock.control.requests()).toEqual([]);
    expect(await strikesFor(ctx.db)).toEqual([]);
  });
});

describe('lifting automatic blocks when a hoax closure is reversed', () => {
  it('lifts the automatic user block the strike caused, and warns', async () => {
    const ctx = ctxWith();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    await closedAs(ctx, 3, { userId });
    const second = await closedAs(ctx, 3, { userId });
    expect(await isBlocked(ctx.db, 'user', userId, ctx.clock.now())).toBe(true);
    expect(await isBlocked(ctx.db, 'phone', 'phone-hash-a', ctx.clock.now())).toBe(false);
    ctx.alerts.clear();

    mock.control.setCallState(second.callId, 0);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await isBlocked(ctx.db, 'user', userId, ctx.clock.now())).toBe(false);
    expect(await liveStrikeCount(ctx.db, 'phone', 'phone-hash-a', ctx.clock.now())).toBe(1);
    const lifted = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.automaticBlock);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.message).toContain(userId);
    expect(JSON.stringify(ctx.alerts.alerts)).not.toContain('phone-hash-a');
  });

  it('never lifts a manual block, nor a block that still has enough strikes behind it', async () => {
    const ctx = ctxWith();
    const now = ctx.clock.now();
    const sub = { id: 'sos_X1', reference: 'SOS-X1', user_id: 'usr_X', phone_hash: 'ph_X' };
    const limits = { hoaxStrikesToBlock: 2, strikeTtlDays: 30, blockTtlDays: 30 };
    await ctx.db
      .insertInto('blocks')
      .values({
        id: 'blk_manual',
        subject_type: 'phone',
        subject: 'ph_X',
        reason: 'manual',
        source: 'manual',
        created_at: now,
        expires_at: null,
      })
      .execute();
    await recordHoaxStrikes(ctx.db, sub, now, limits);
    await recordHoaxStrikes(ctx.db, { ...sub, id: 'sos_X2' }, now, limits);
    await recordHoaxStrikes(ctx.db, { ...sub, id: 'sos_X3' }, now, limits);
    expect(await isBlocked(ctx.db, 'user', 'usr_X', now)).toBe(true);

    // Three strikes, one removed: two remain, so the user block stands.
    const lifted = await removeStrikes(ctx.db, { ...sub, id: 'sos_X3' }, now, limits);
    expect(lifted).toEqual([]);
    expect(await isBlocked(ctx.db, 'user', 'usr_X', now)).toBe(true);

    // Below the threshold now: the automatic user block goes, the manual phone block stays.
    const lifted2 = await removeStrikes(ctx.db, { ...sub, id: 'sos_X2' }, now, limits);
    expect(lifted2.map((c) => c.kind)).toEqual(['user_block_lifted']);
    expect(await isBlocked(ctx.db, 'user', 'usr_X', now)).toBe(false);
    expect(await isBlocked(ctx.db, 'phone', 'ph_X', now)).toBe(true);
  });

  it('recording a strike twice for one submission is a no-op', async () => {
    const ctx = ctxWith();
    const now = ctx.clock.now();
    const sub = { id: 'sos_Y1', reference: 'SOS-Y1', user_id: 'usr_Y', phone_hash: 'ph_Y' };
    const limits = { hoaxStrikesToBlock: 1, strikeTtlDays: 30, blockTtlDays: 30 };
    const first = await recordHoaxStrikes(ctx.db, sub, now, limits);
    const again = await recordHoaxStrikes(ctx.db, sub, now, limits);
    expect(first.map((o) => o.kind)).toEqual(['user_block_applied', 'phone_threshold_reached']);
    expect(again).toEqual([]);
    expect(await strikesFor(ctx.db)).toHaveLength(2);
  });
});
