/**
 * Fan-out across relay instances (docs/live-sos-plan.md D16, §5.4, §8): two app instances on one
 * database, each with its own pool and its own LISTEN connection, and a real `ws` client.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revokeFamily } from '../../src/auth/sessions.js';
import { FakeClock } from '../../src/clock.js';
import { CLOSE } from '../../src/live/protocol.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import {
  commitChange,
  killListeners,
  listenerCount,
  seedSos,
  sleep,
  startInstance,
  stopInstances,
  TestSocket,
} from './socketHarness.js';

beforeEach(() => resetDb());
afterEach(() => stopInstances());
afterAll(() => closeTestDb());

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describe('two instances on one database', () => {
  it('a socket on instance A receives a change committed on instance B', async () => {
    const clock = new FakeClock();
    const a = await startInstance({ clock });
    const b = await startInstance({ clock });
    const user = await seedUser(a.ctx);
    const id = await seedSos(a.ctx, user);

    const socket = await TestSocket.open(a.url, user.token());
    socket.send({ type: 'subscribe', receiptId: id });
    expect(await socket.next()).toMatchObject({ version: 0, status: 'queued' });

    await commitChange(b.db, id, 'received');
    expect(await socket.next()).toMatchObject({ version: 1, status: 'received' });
    await commitChange(b.db, id, 'dispatched');
    expect(await socket.next()).toMatchObject({ version: 2, status: 'dispatched' });
    await commitChange(b.db, id, 'closed');
    expect(await socket.next()).toMatchObject({ version: 3, status: 'closed' });
    expect((await socket.closedWithin()).code).toBe(CLOSE.final);
  });

  it('sockets for one SOS on both instances each get the change once', async () => {
    const clock = new FakeClock();
    const a = await startInstance({ clock });
    const b = await startInstance({ clock });
    const user = await seedUser(a.ctx);
    const id = await seedSos(a.ctx, user);
    const onA = await TestSocket.open(a.url, user.token());
    const onB = await TestSocket.open(b.url, user.token());
    for (const s of [onA, onB]) {
      s.send({ type: 'subscribe', receiptId: id });
      await s.next();
    }
    await commitChange(testDb(), id);
    expect((await onA.next()).version).toBe(1);
    expect((await onB.next()).version).toBe(1);
    expect(await onA.drain()).toEqual([]);
    expect(await onB.drain()).toEqual([]);
  });

  it('a session revoked on instance B closes its socket on instance A with 4003', async () => {
    const clock = new FakeClock();
    const a = await startInstance({ clock });
    const b = await startInstance({ clock });
    const user = await seedUser(a.ctx);
    const socket = await TestSocket.open(a.url, user.token());
    await socket.drain();
    await revokeFamily(b.db, user.familyId, clock.now());
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
  });

  it('deleting the user closes its sockets on every instance with 4003', async () => {
    const clock = new FakeClock();
    const a = await startInstance({ clock });
    const b = await startInstance({ clock });
    const user = await seedUser(a.ctx);
    const socket = await TestSocket.open(a.url, user.token());
    await socket.drain();
    await b.db.deleteFrom('users').where('id', '=', user.user.id).execute();
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
  });
});

describe('the listener', () => {
  it('holds one connection per instance, opened with the first socket and closed with the app', async () => {
    const a = await startInstance();
    const user = await seedUser(a.ctx);
    expect(await listenerCount(testDb())).toBe(0);
    const s1 = await TestSocket.open(a.url, user.token());
    const s2 = await TestSocket.open(a.url, user.token());
    await s1.drain();
    await s2.drain();
    expect(await listenerCount(testDb())).toBe(1);
    await a.stop();
    await waitFor(async () => (await listenerCount(testDb())) === 0);
  });

  it('reconnects after it drops and re-pushes a fresh snapshot to every socket', async () => {
    const a = await startInstance({ live: { listenerRetryMinMs: 300, listenerRetryMaxMs: 300 } });
    const user = await seedUser(a.ctx);
    const id = await seedSos(a.ctx, user);
    const socket = await TestSocket.open(a.url, user.token());
    socket.send({ type: 'subscribe', receiptId: id });
    expect((await socket.next()).version).toBe(0);

    expect(await killListeners(testDb())).toBe(1);
    await waitFor(async () => (await listenerCount(testDb())) === 0);
    // Committed while nobody listens: this notification is lost.
    await commitChange(testDb(), id, 'received');

    expect(await socket.next(3000)).toMatchObject({ version: 1, status: 'received' });
    expect(await listenerCount(testDb())).toBe(1);
    // And it listens again.
    await commitChange(testDb(), id);
    expect((await socket.next()).version).toBe(2);
  });

  it('re-pushes the current snapshot after a reconnect even when nothing changed', async () => {
    const a = await startInstance();
    const user = await seedUser(a.ctx);
    const id = await seedSos(a.ctx, user);
    const socket = await TestSocket.open(a.url, user.token());
    socket.send({ type: 'subscribe', receiptId: id });
    expect((await socket.next()).version).toBe(0);
    expect(await killListeners(testDb())).toBe(1);
    expect(await socket.next(3000)).toMatchObject({ type: 'state', version: 0, receiptId: id });
  });

  it('after a reconnect, catches a revocation it missed', async () => {
    const a = await startInstance({
      live: { listenerRetryMinMs: 300, listenerRetryMaxMs: 300, idleTimeoutMs: 5000 },
    });
    const user = await seedUser(a.ctx);
    const socket = await TestSocket.open(a.url, user.token());
    await socket.drain();
    expect(await killListeners(testDb())).toBe(1);
    await waitFor(async () => (await listenerCount(testDb())) === 0);
    // Nobody listens: this notification is lost, and nothing is sent on the socket.
    await revokeFamily(testDb(), user.familyId, a.ctx.clock.now());
    await sleep(50);
    expect(socket.isClosed).toBe(false);
    expect((await socket.closedWithin(3000)).code).toBe(CLOSE.revoked);
  });
});
