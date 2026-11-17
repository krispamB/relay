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
import { deliverToMock, insertDevice, mockContext, strikesFor } from '../jobs/fixtures.js';

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
  opts: { deviceId?: string; phoneHash?: string } = {},
): Promise<{ id: string; callId: string; deviceId: string; reference: string }> {
  const s = await deliverToMock(ctx, {
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
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
      ['device', s.deviceId, s.id],
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

  it('blocks the device automatically at the threshold, with a warning naming the device only', async () => {
    const ctx = ctxWith();
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    await closedAs(ctx, 3, { deviceId, phoneHash: 'phone-hash-1' });
    expect(await blocks(ctx)).toEqual([]);
    expect(await isBlocked(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(false);

    const second = await closedAs(ctx, 7, { deviceId, phoneHash: 'phone-hash-2' });
    const all = await blocks(ctx);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ subject_type: 'device', subject: deviceId, source: 'automatic' });
    expect(all[0]!.expires_at!.getTime() - all[0]!.created_at.getTime()).toBe(30 * DAY);
    expect(await isBlocked(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(true);

    const alerts = ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.automaticBlock);
    expect(alerts).toEqual([
      expect.objectContaining({ severity: 'warning', reference: second.reference, receiptId: second.id }),
    ]);
    expect(alerts[0]!.message).toContain(deviceId);
    expect(alerts[0]!.message).toContain('device');
    const text = JSON.stringify(ctx.alerts.alerts);
    for (const secret of ['+2348012345678', 'phone-hash-1', 'phone-hash-2'])
      expect(text).not.toContain(secret);
  });

  it('blocks a phone number used from two devices, without naming it', async () => {
    const ctx = ctxWith();
    const a = await closedAs(ctx, 3, { phoneHash: 'phone-hash-x' });
    const b = await closedAs(ctx, 3, { phoneHash: 'phone-hash-x' });
    expect(await isBlocked(ctx.db, 'phone', 'phone-hash-x', ctx.clock.now())).toBe(true);
    expect(await isBlocked(ctx.db, 'device', a.deviceId, ctx.clock.now())).toBe(false);
    expect(await isBlocked(ctx.db, 'device', b.deviceId, ctx.clock.now())).toBe(false);
    const alert = ctx.alerts.alerts.find((x) => x.code === ALERT_CODES.automaticBlock)!;
    expect(alert.message).toContain('a phone number');
    expect(alert.message).not.toContain('phone-hash-x');
    expect(alert.message).not.toContain('+234');
  });

  it('does not add a second block while one is live', async () => {
    const ctx = ctxWith();
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    for (let i = 0; i < 3; i++) await closedAs(ctx, 3, { deviceId, phoneHash: `p${i}` });
    expect((await blocks(ctx)).filter((b) => b.subject_type === 'device')).toHaveLength(1);
  });

  it('with HOAX_STRIKES_TO_BLOCK=0 strikes are recorded but nothing is blocked', async () => {
    const ctx = ctxWith({ hoaxStrikesToBlock: 0 });
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    for (let i = 0; i < 3; i++) await closedAs(ctx, 7, { deviceId });
    expect(await strikesFor(ctx.db)).toHaveLength(6);
    expect(await blocks(ctx)).toEqual([]);
    expect(ctx.alerts.codes()).not.toContain(ALERT_CODES.automaticBlock);
  });

  it('an expired strike does not count toward the threshold', async () => {
    const ctx = ctxWith({ strikeTtlDays: 30 });
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    const first = await closedAs(ctx, 3, { deviceId, phoneHash: 'pa' });
    // Let the first submission's status window end so it is no longer open.
    ctx.clock.advance(30 * DAY + SECOND);
    await runStatusPollerPass(ctx);
    expect(await liveStrikeCount(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(0);
    await closedAs(ctx, 3, { deviceId, phoneHash: 'pb' });
    expect(await liveStrikeCount(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(1);
    expect(await blocks(ctx)).toEqual([]);
    expect(first.id).toBeDefined();
  });

  it('creates no strike for a demo submission (it never reaches the poller’s Core path)', async () => {
    const ctx = ctxWith();
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    await ctx.db
      .insertInto('submissions')
      .values({
        id: 'sos_DEMO1',
        device_id: deviceId,
        idempotency_key: 'demo-key',
        intake_code: 'DEMO-DEPT',
        is_demo: true,
        reference: 'SOS-DEMO',
        status: 'received',
        nature_id: 'medical',
        nature_label: 'Medical emergency',
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
  it('lifts the automatic blocks the strike caused, and warns', async () => {
    const ctx = ctxWith();
    const deviceId = await insertDevice(ctx.db, ctx.clock.now());
    await closedAs(ctx, 3, { deviceId });
    const second = await closedAs(ctx, 3, { deviceId });
    expect(await isBlocked(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(true);
    expect(await isBlocked(ctx.db, 'phone', 'phone-hash-a', ctx.clock.now())).toBe(true);
    ctx.alerts.clear();

    mock.control.setCallState(second.callId, 0);
    ctx.clock.advance(CLOSED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await isBlocked(ctx.db, 'device', deviceId, ctx.clock.now())).toBe(false);
    expect(await isBlocked(ctx.db, 'phone', 'phone-hash-a', ctx.clock.now())).toBe(false);
    expect(ctx.alerts.alerts.filter((a) => a.code === ALERT_CODES.automaticBlock)).toHaveLength(2);
    expect(JSON.stringify(ctx.alerts.alerts)).not.toContain('phone-hash-a');
  });

  it('never lifts a manual block, nor a block that still has enough strikes behind it', async () => {
    const ctx = ctxWith();
    const now = ctx.clock.now();
    const sub = { id: 'sos_X1', reference: 'SOS-X1', device_id: 'dev_X', phone_hash: 'ph_X' };
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
    expect(await isBlocked(ctx.db, 'device', 'dev_X', now)).toBe(true);

    // Three strikes, one removed: two remain, so the device block stands.
    const lifted = await removeStrikes(ctx.db, { ...sub, id: 'sos_X3' }, now, limits);
    expect(lifted).toEqual([]);
    expect(await isBlocked(ctx.db, 'device', 'dev_X', now)).toBe(true);

    // Below the threshold now: the automatic device block goes, the manual phone block stays.
    const lifted2 = await removeStrikes(ctx.db, { ...sub, id: 'sos_X2' }, now, limits);
    expect(lifted2.map((c) => [c.change, c.subjectType])).toEqual([['lifted', 'device']]);
    expect(await isBlocked(ctx.db, 'device', 'dev_X', now)).toBe(false);
    expect(await isBlocked(ctx.db, 'phone', 'ph_X', now)).toBe(true);
  });

  it('recording a strike twice for one submission is a no-op', async () => {
    const ctx = ctxWith();
    const now = ctx.clock.now();
    const sub = { id: 'sos_Y1', reference: 'SOS-Y1', device_id: 'dev_Y', phone_hash: 'ph_Y' };
    const limits = { hoaxStrikesToBlock: 1, strikeTtlDays: 30, blockTtlDays: 30 };
    const first = await recordHoaxStrikes(ctx.db, sub, now, limits);
    const again = await recordHoaxStrikes(ctx.db, sub, now, limits);
    expect(first).toHaveLength(2);
    expect(again).toEqual([]);
    expect(await strikesFor(ctx.db)).toHaveLength(2);
  });
});
