/**
 * docs/live-sos-plan.md §8: "A socket on instance A receives a change committed by the poller on
 * instance B." Instance A serves the socket; instance B is a separate context (its own Core client,
 * pointed at mock-core) running the real status poller against the same database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { newReceiptId } from '../../src/ids.js';
import { RECEIVED_INTERVAL_MS, runStatusPollerPass } from '../../src/jobs/statusPoller.js';
import { CLOSE } from '../../src/live/protocol.js';
import { closeTestDb, resetDb } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import { deliverToMock, mockContext } from '../jobs/fixtures.js';
import { startInstance, stopInstances, TestSocket } from './socketHarness.js';

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
afterEach(() => stopInstances());

describe('poller on instance B, socket on instance A', () => {
  it('pushes each status change the poller commits, then the final snapshot and 1000', async () => {
    const b = mockContext(mock);
    const a = await startInstance({ clock: b.clock });
    const user = await seedUser(a.ctx);
    const sos = await deliverToMock(b, {
      userId: user.user.id,
      overrides: { id: newReceiptId(b.clock.now().getTime()) },
    });

    const socket = await TestSocket.open(a.url, user.token());
    socket.send({ type: 'subscribe', receiptId: sos.id });
    const first = await socket.next();
    expect(first).toMatchObject({ status: 'received' });

    mock.control.setCallState(sos.callId, 0); // a dispatcher accepts the pending call
    b.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(b);
    const dispatched = await socket.next();
    expect(dispatched).toMatchObject({ status: 'dispatched' });
    expect(dispatched.version).toBeGreaterThan(first.version);

    mock.control.setCallState(sos.callId, 1); // closed
    b.clock.advance(RECEIVED_INTERVAL_MS);
    await runStatusPollerPass(b);
    const closed = await socket.next();
    expect(closed).toMatchObject({ status: 'closed', units: [] });
    expect(closed.version).toBeGreaterThan(dispatched.version);
    expect((await socket.closedWithin()).code).toBe(CLOSE.final);
  });
});
