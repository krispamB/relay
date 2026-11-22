/**
 * Backpressure on the live socket: snapshots are whole states, so a socket that has stopped reading
 * (its unsent buffer over maxBufferedBytes) is dropped rather than queued to without bound. The app
 * reconnects and gets the current state. With a stand-in for the ws socket, so the buffer can be set.
 */
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { LiveHub } from '../../src/live/socket.js';
import { closeTestDb, createTestContext, resetDb, type TestContext } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import { commitChange, seedSos, sleep } from './socketHarness.js';

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminated = false;
  closedWith: number | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = 2;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

let ctx: TestContext;
let hub: LiveHub;

beforeEach(async () => {
  await resetDb();
  ctx = createTestContext();
  hub = new LiveHub(ctx, { maxBufferedBytes: 1000 });
});
afterEach(() => hub.close());
afterAll(() => closeTestDb());

describe('backpressure', () => {
  it('drops a socket whose unsent buffer is over the limit instead of sending to it', async () => {
    const user = await seedUser(ctx);
    const id = await seedSos(ctx, user);
    const ws = new FakeWs();
    hub.accept(ws as unknown as WebSocket, user.token());
    ws.message({ type: 'subscribe', receiptId: id });
    await until(() => ws.sent.length === 1);
    expect(ws.sent[0]).toMatchObject({ type: 'state', version: 0 });

    ws.bufferedAmount = 5000;
    await commitChange(ctx.db, id);
    await until(() => ws.terminated);
    expect(ws.sent).toHaveLength(1);
    expect(ws.closedWith).toBeUndefined();
  });
});
