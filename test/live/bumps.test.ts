/**
 * Slice 6 of docs/live-sos-plan.md: every submission status change bumps live_version (and so
 * NOTIFYs sos_live) in its own transaction, and the snapshot shows the change. A poll that changes
 * nothing visible does not bump.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { MINUTE, SECOND } from '../../src/clock.js';
import { attemptDelivery, HARD_STOP_MS } from '../../src/delivery/deliver.js';
import { runDeliveryPass } from '../../src/jobs/deliveryWorker.js';
import {
  DISPATCHED_INTERVAL_MS,
  RECEIVED_INTERVAL_MS,
  runStatusPollerPass,
  STATUS_WINDOW_MS,
} from '../../src/jobs/statusPoller.js';
import { readSnapshot } from '../../src/live/read.js';
import { getSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, DEMO_INTAKE_CODE, resetDb, unusedCore } from '../helpers/context.js';
import { deliverToMock, insertSubmissionOn, insertUser, mockContext } from '../jobs/fixtures.js';

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

type Ctx = ReturnType<typeof createTestContext>;

async function version(ctx: Ctx, id: string): Promise<number> {
  return Number((await getSubmission(ctx.db, id)).live_version);
}

async function snapshot(ctx: Ctx, id: string) {
  const { user_id } = await getSubmission(ctx.db, id);
  const snap = await readSnapshot(ctx.db, id, user_id, ctx.clock.now());
  if (!snap) throw new Error('no snapshot');
  return snap;
}

describe('live_version: delivery', () => {
  it('queued → received bumps once', async () => {
    const ctx = mockContext(mock);
    const { id } = await deliverToMock(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'received', version: 1 });
  });

  it('a Core rejection (→ failed) bumps', async () => {
    const ctx = mockContext(mock);
    mock.control.injectFault('Calls/SaveCall', {
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400 },
    });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now());
    expect(await attemptDelivery(ctx, id)).toBe('failed');
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'failed', version: 1 });
  });

  it('a retry that leaves it queued does not bump', async () => {
    const ctx = mockContext(mock);
    mock.control.injectFault('Calls/SaveCall', { status: 503 });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now());
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect(await version(ctx, id)).toBe(0);
  });

  it('the 30-minute hard stop (→ failed) bumps', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now(), {
      next_attempt_at: new Date(ctx.clock.now().getTime() + HOUR_AHEAD),
    });
    ctx.clock.advance(HARD_STOP_MS);
    await runDeliveryPass(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'failed', version: 1 });
  });

  it('an inline attempt while paused (→ failed, not sent) bumps', async () => {
    const ctx = mockContext(mock);
    await ctx.db.updateTable('relay_state').set({ paused: true }).where('id', '=', 1).execute();
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now());
    expect(await attemptDelivery(ctx, id, { inline: true })).toBe('not_sent');
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'failed', version: 1 });
  });
});

const HOUR_AHEAD = 60 * MINUTE;

describe('live_version: status poller', () => {
  it('received → dispatched → closed bumps on each change, and the snapshot shows it', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);

    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await version(ctx, id)).toBe(1);

    mock.control.setCallState(callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({
      status: 'dispatched',
      version: 2,
      updatedAt: ctx.clock.now().toISOString(),
    });

    mock.control.setCallState(callId, 1);
    ctx.clock.advance(DISPATCHED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'closed', version: 3 });
  });

  it('a poll that changes nothing visible does not bump', async () => {
    const ctx = mockContext(mock);
    const { id, callId } = await deliverToMock(ctx);
    mock.control.setCallState(callId, 0);
    ctx.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(ctx);
    const before = await version(ctx, id);
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(DISPATCHED_INTERVAL_MS);
      await runStatusPollerPass(ctx);
    }
    expect(await version(ctx, id)).toBe(before);
  });

  it('the 24-hour window close bumps', async () => {
    const ctx = mockContext(mock);
    const { id } = await deliverToMock(ctx);
    ctx.clock.advance(STATUS_WINDOW_MS);
    await runStatusPollerPass(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'closed', version: 2 });
  });

  it('demo transitions bump once per step', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const userId = await insertUser(ctx.db, ctx.clock.now());
    const id = await insertSubmissionOn(ctx.db, userId, ctx.clock.now(), {
      is_demo: true,
      intake_code: DEMO_INTAKE_CODE,
    });
    expect(await attemptDelivery(ctx, id)).toBe('received');
    expect(await version(ctx, id)).toBe(1);
    // A late pass walks received → dispatched → closed in one transaction: two changes, two bumps.
    ctx.clock.advance(ctx.config.demoCloseAfterS * SECOND);
    await runStatusPollerPass(ctx);
    expect(await snapshot(ctx, id)).toMatchObject({ status: 'closed', version: 3 });
  });
});
