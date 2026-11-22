/**
 * GET /v1/live (docs/live-sos-plan.md §5.2, D15, D18; docs/app-api-contract.md §5) on one relay
 * instance, with a real `ws` client, against real Postgres. Cross-instance fan-out and the listener
 * are in fanout.test.ts.
 */
import { sql } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revokeFamily } from '../../src/auth/sessions.js';
import { refreshTokenHash } from '../../src/auth/tokens.js';
import { MINUTE, SECOND } from '../../src/clock.js';
import { CLOSE } from '../../src/live/protocol.js';
import { getSubmission } from '../delivery/fixtures.js';
import { closeTestDb, resetDb } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import {
  commitChange,
  type Instance,
  seedSos,
  sleep,
  startInstance,
  stopInstances,
  TestSocket,
  tokenExpiringIn,
} from './socketHarness.js';

let relay: Instance;

beforeEach(async () => {
  await resetDb();
  relay = await startInstance();
});
afterEach(() => stopInstances());
afterAll(() => closeTestDb());

/** A user and a socket of theirs whose upgrade token has been accepted (the first pong proves it). */
async function signedIn() {
  const user = await seedUser(relay.ctx);
  const socket = await TestSocket.open(relay.url, user.token());
  await socket.drain();
  return { user, socket };
}

function fix(overrides: Record<string, unknown> = {}) {
  return {
    type: 'location',
    lat: 6.6,
    lon: 3.4,
    capturedAt: relay.ctx.clock.now().toISOString(),
    ...overrides,
  };
}

describe('auth', () => {
  it('accepts a Bearer token on the upgrade', async () => {
    const { socket } = await signedIn();
    socket.send({ type: 'ping' });
    expect(await socket.next()).toEqual({ type: 'pong' });
  });

  it('accepts an in-band auth message as the first message', async () => {
    const user = await seedUser(relay.ctx);
    const socket = await TestSocket.open(relay.url);
    socket.send({ type: 'auth', token: user.token() });
    socket.send({ type: 'ping' });
    expect(await socket.next()).toEqual({ type: 'pong' });
  });

  it('closes 4001 when no auth arrives within the auth timeout', async () => {
    const socket = await TestSocket.open(relay.url);
    const started = Date.now();
    const closed = await socket.closedWithin(2000);
    expect(closed.code).toBe(CLOSE.unauthorized);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('closes 4001 when the first message is not auth', async () => {
    const socket = await TestSocket.open(relay.url);
    socket.send({ type: 'ping' });
    expect((await socket.closedWithin()).code).toBe(CLOSE.unauthorized);
  });

  it('closes 4001 for a forged, expired or malformed upgrade token', async () => {
    const user = await seedUser(relay.ctx);
    const expired = tokenExpiringIn(relay.ctx, user, SECOND);
    relay.ctx.clock.advance(2 * SECOND);
    for (const token of ['nope', `${user.token()}x`, expired]) {
      const socket = await TestSocket.open(relay.url, token);
      expect((await socket.closedWithin()).code).toBe(CLOSE.unauthorized);
    }
  });

  it('closes 4003 when the token belongs to a revoked session', async () => {
    const user = await seedUser(relay.ctx);
    await revokeFamily(relay.ctx.db, user.familyId, relay.ctx.clock.now());
    const socket = await TestSocket.open(relay.url, user.token());
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
  });

  it('closes 4001 when the token expires without re-auth', async () => {
    relay = await startInstance({ live: { idleTimeoutMs: 5000 } });
    const user = await seedUser(relay.ctx);
    const socket = await TestSocket.open(relay.url, tokenExpiringIn(relay.ctx, user, SECOND));
    socket.send({ type: 'ping' });
    expect(await socket.next()).toEqual({ type: 'pong' });
    const started = Date.now();
    expect((await socket.closedWithin(3000)).code).toBe(CLOSE.unauthorized);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('re-auth with a new token of the same user keeps the socket past the old expiry', async () => {
    relay = await startInstance({ live: { idleTimeoutMs: 5000 } });
    const user = await seedUser(relay.ctx);
    const socket = await TestSocket.open(relay.url, tokenExpiringIn(relay.ctx, user, SECOND));
    socket.send({ type: 'auth', token: user.token() });
    await sleep(1300);
    expect(socket.isClosed).toBe(false);
    socket.send({ type: 'ping' });
    expect(await socket.next()).toEqual({ type: 'pong' });
  });

  it('closes 4001 on re-auth with another user’s token', async () => {
    const { socket } = await signedIn();
    const other = await seedUser(relay.ctx);
    socket.send({ type: 'auth', token: other.token() });
    expect((await socket.closedWithin()).code).toBe(CLOSE.unauthorized);
  });

  it('backstop: a message after the token expired (by the relay clock) closes 4001', async () => {
    const { socket } = await signedIn();
    relay.ctx.clock.advance(16 * MINUTE);
    socket.send({ type: 'ping' });
    expect((await socket.closedWithin()).code).toBe(CLOSE.unauthorized);
  });

  it('closes open sockets 4003 when the session is signed out', async () => {
    const { user, socket } = await signedIn();
    const second = await TestSocket.open(relay.url, user.token());
    await second.drain();
    // Over HTTP, so the revocation goes through the real sign-out path.
    const signin = await relay.ctx.db
      .insertInto('refresh_tokens')
      .values({
        id: '00000000-0000-4000-8000-000000000001',
        family_id: user.familyId,
        user_id: user.user.id,
        parent_id: null,
        token_hash: refreshTokenHash(`rt_${'a'.repeat(43)}`),
        issued_at: relay.ctx.clock.now(),
        expires_at: new Date(relay.ctx.clock.now().getTime() + 60 * MINUTE),
        access_iat: relay.ctx.clock.now(),
        access_exp: new Date(relay.ctx.clock.now().getTime() + 15 * MINUTE),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(signin.id).toBeTruthy();
    const res = await relay.app.inject({
      method: 'POST',
      url: '/v1/auth/signout',
      headers: { authorization: `Bearer ${user.token()}`, 'content-type': 'application/json' },
      payload: { refreshToken: `rt_${'a'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(204);
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
    expect((await second.closedWithin()).code).toBe(CLOSE.revoked);
  });

  it('a socket of another session of the same user stays open when one session is revoked', async () => {
    const { user, socket } = await signedIn();
    const otherSession = await seedUser(relay.ctx);
    const other = await TestSocket.open(relay.url, otherSession.token());
    await revokeFamily(relay.ctx.db, user.familyId, relay.ctx.clock.now());
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
    expect(await other.drain()).toEqual([]);
  });

  it('backstop: a revocation that sent no notification is caught on the next message', async () => {
    const { user, socket } = await signedIn();
    // Bypass the trigger, as if the notification were lost.
    await relay.ctx.db.connection().execute(async (conn) => {
      await sql`SET session_replication_role = replica`.execute(conn);
      await conn
        .updateTable('token_families')
        .set({ revoked_at: relay.ctx.clock.now() })
        .where('id', '=', user.familyId)
        .execute();
      await sql`SET session_replication_role = DEFAULT`.execute(conn);
    });
    await sleep(100);
    expect(socket.isClosed).toBe(false);
    socket.send({ type: 'ping' });
    expect((await socket.closedWithin()).code).toBe(CLOSE.revoked);
  });

  it('refuses a user’s sixth socket on one instance with 4029', async () => {
    const user = await seedUser(relay.ctx);
    const open: TestSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await TestSocket.open(relay.url, user.token());
      await s.drain();
      open.push(s);
    }
    const sixth = await TestSocket.open(relay.url, user.token());
    expect((await sixth.closedWithin()).code).toBe(CLOSE.tooManySockets);
    // Closing one frees a place.
    open[0]!.close();
    await open[0]!.closedWithin();
    await sleep(50);
    const again = await TestSocket.open(relay.url, user.token());
    expect(await again.drain()).toEqual([]);
  });
});

describe('subscribe', () => {
  it('answers with the snapshot and marks the SOS watched', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    const state = await socket.next();
    expect(state).toMatchObject({ type: 'state', receiptId: id, status: 'queued', version: 0, units: [] });
    const row = await getSubmission(relay.ctx.db, id);
    expect(row.live_watch_until?.toISOString()).toBe(
      new Date(relay.ctx.clock.now().getTime() + MINUTE).toISOString(),
    );
  });

  it('closes 4004 for another user’s SOS, and does not mark it watched', async () => {
    const { socket } = await signedIn();
    const owner = await seedUser(relay.ctx);
    const id = await seedSos(relay.ctx, owner);
    socket.send({ type: 'subscribe', receiptId: id });
    expect((await socket.closedWithin()).code).toBe(CLOSE.notFound);
    expect(socket.pending()).toEqual([]);
    expect((await getSubmission(relay.ctx.db, id)).live_watch_until).toBeNull();
  });

  it('closes 4004 for an unknown or malformed receipt id', async () => {
    for (const receiptId of ['sos_01JZZZZZZZZZZZZZZZZZZZZZZZ', 'not-a-receipt']) {
      const { socket } = await signedIn();
      socket.send({ type: 'subscribe', receiptId });
      expect((await socket.closedWithin()).code).toBe(CLOSE.notFound);
    }
  });

  it('sends the final snapshot and closes 1000 for a closed or failed SOS', async () => {
    for (const status of ['closed', 'failed'] as const) {
      const { user, socket } = await signedIn();
      const id = await seedSos(relay.ctx, user, { status });
      socket.send({ type: 'subscribe', receiptId: id });
      expect(await socket.next()).toMatchObject({ type: 'state', receiptId: id, status });
      expect((await socket.closedWithin()).code).toBe(CLOSE.final);
    }
  });

  it('pushes each committed change, and the final one with a 1000', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    expect((await socket.next()).version).toBe(0);
    await commitChange(relay.ctx.db, id, 'received');
    expect(await socket.next()).toMatchObject({ version: 1, status: 'received' });
    await commitChange(relay.ctx.db, id, 'closed');
    expect(await socket.next()).toMatchObject({ version: 2, status: 'closed' });
    expect((await socket.closedWithin()).code).toBe(CLOSE.final);
  });

  it('a second subscribe replaces the first', async () => {
    const { user, socket } = await signedIn();
    const first = await seedSos(relay.ctx, user);
    const second = await seedSos(relay.ctx, user, { is_demo: true, intake_code: 'DEMO-DEPT' });
    socket.send({ type: 'subscribe', receiptId: first });
    expect((await socket.next()).receiptId).toBe(first);
    socket.send({ type: 'subscribe', receiptId: second });
    expect((await socket.next()).receiptId).toBe(second);

    await commitChange(relay.ctx.db, first);
    await sleep(150);
    expect(await socket.drain()).toEqual([]);
    await commitChange(relay.ctx.db, second);
    expect(await socket.next()).toMatchObject({ receiptId: second, version: 1 });
  });
});

describe('ping', () => {
  it('answers pong and extends the watch of the subscribed SOS', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    await socket.next();
    relay.ctx.clock.advance(20 * SECOND);
    socket.send({ type: 'ping' });
    expect(await socket.next()).toEqual({ type: 'pong' });
    const row = await getSubmission(relay.ctx.db, id);
    expect(row.live_watch_until?.toISOString()).toBe(
      new Date(relay.ctx.clock.now().getTime() + MINUTE).toISOString(),
    );
  });

  it('closes 4008 after the idle timeout with no ping, and pings keep it open', async () => {
    const { socket } = await signedIn();
    for (let i = 0; i < 4; i++) {
      await sleep(400);
      socket.send({ type: 'ping' });
      expect(await socket.next()).toEqual({ type: 'pong' });
    }
    expect(socket.isClosed).toBe(false);

    // Other messages do not count as a heartbeat.
    const opened = Date.now();
    const quiet = (await signedIn()).socket;
    await sleep(400);
    quiet.send(fix());
    expect(await quiet.next()).toEqual({ type: 'error', code: 'not_subscribed' });
    expect((await quiet.closedWithin(2000)).code).toBe(CLOSE.idle);
    expect(Date.now() - opened).toBeGreaterThanOrEqual(700);
    expect(Date.now() - opened).toBeLessThan(1150);
  });
});

describe('errors', () => {
  it('answers a bad message with an error and stays open', async () => {
    const { socket } = await signedIn();
    for (const raw of ['not json', '{"type":"dance"}', '{"type":"subscribe"}', '[]']) {
      socket.send(raw);
      expect(await socket.next()).toEqual({ type: 'error', code: 'bad_message' });
    }
    socket.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await socket.next()).toEqual({ type: 'error', code: 'bad_message' });
    expect(await socket.drain()).toEqual([]);
  });

  it('closes 1009 for a message over 8 KB', async () => {
    const { socket } = await signedIn();
    socket.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(9000) }));
    expect((await socket.closedWithin()).code).toBe(1009);
  });

  it('answers rate_limited once a socket sends too many messages, without acting on them', async () => {
    const { socket } = await signedIn();
    relay.ctx.clock.advance(10 * SECOND); // a fresh window: signedIn's ping counted in the last one
    for (let i = 0; i < 25; i++) socket.send('{"type":"dance"}');
    const answers = [];
    for (let i = 0; i < 25; i++) answers.push((await socket.next()).code);
    expect(answers.filter((c) => c === 'bad_message')).toHaveLength(20);
    expect(answers.filter((c) => c === 'rate_limited')).toHaveLength(5);
    relay.ctx.clock.advance(10 * SECOND);
    expect(await socket.drain()).toEqual([]);
  });
});

describe('location', () => {
  it('needs a subscription first', async () => {
    const { socket } = await signedIn();
    socket.send(fix());
    expect(await socket.next()).toEqual({ type: 'error', code: 'not_subscribed' });
  });

  it('refuses 0,0, a stale fix and a fix from the future with invalid_location', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    await socket.next();
    const now = relay.ctx.clock.now().getTime();
    for (const bad of [
      fix({ lat: 0, lon: 0 }),
      fix({ capturedAt: new Date(now - 11 * MINUTE).toISOString() }),
      fix({ capturedAt: new Date(now + 5 * MINUTE).toISOString() }),
    ]) {
      socket.send(bad);
      expect(await socket.next()).toEqual({ type: 'error', code: 'invalid_location' });
    }
    expect((await getSubmission(relay.ctx.db, id)).live_lat).toBeNull();
  });

  it('stores at most one fix per 5 s, bumping the version for each one stored', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    await socket.next();

    socket.send(fix({ lat: 6.6, lon: 3.4, accuracyM: 8 }));
    expect(await socket.next()).toMatchObject({ type: 'state', version: 1 });
    let row = await getSubmission(relay.ctx.db, id);
    expect([row.live_lat, row.live_lon, row.live_at?.toISOString()]).toEqual([
      6.6,
      3.4,
      relay.ctx.clock.now().toISOString(),
    ]);

    relay.ctx.clock.advance(4 * SECOND);
    socket.send(fix({ lat: 6.7 }));
    expect(await socket.drain()).toEqual([]);
    row = await getSubmission(relay.ctx.db, id);
    expect([row.live_lat, Number(row.live_version)]).toEqual([6.6, 1]);

    relay.ctx.clock.advance(SECOND);
    socket.send(fix({ lat: 6.8 }));
    expect(await socket.next()).toMatchObject({ type: 'state', version: 2 });
    expect((await getSubmission(relay.ctx.db, id)).live_lat).toBe(6.8);
  });

  it('is never stored for a closed SOS, and never sent to Core', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    await socket.next();
    // Closed under the socket, with no notification, so the socket still thinks it is subscribed.
    await relay.ctx.db.updateTable('submissions').set({ status: 'closed' }).where('id', '=', id).execute();
    socket.send(fix());
    expect(await socket.drain()).toEqual([]);
    expect((await getSubmission(relay.ctx.db, id)).live_lat).toBeNull();
  });
});

describe('fan-out details', () => {
  it('never sends a version lower than the last one the socket received', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    await relay.ctx.db.updateTable('submissions').set({ live_version: '5' }).where('id', '=', id).execute();
    socket.send({ type: 'subscribe', receiptId: id });
    expect((await socket.next()).version).toBe(5);
    // Rewind the row: a later read (here, a notification) sees a lower version than was sent.
    await relay.ctx.db.updateTable('submissions').set({ live_version: '2' }).where('id', '=', id).execute();
    await commitChange(relay.ctx.db, id); // version 3
    await sleep(150);
    expect(await socket.drain()).toEqual([]);
    await relay.ctx.db.updateTable('submissions').set({ live_version: '5' }).where('id', '=', id).execute();
    await commitChange(relay.ctx.db, id); // version 6
    expect((await socket.next()).version).toBe(6);
  });

  it('closes every socket 1012 when the relay shuts down', async () => {
    const { user, socket } = await signedIn();
    const id = await seedSos(relay.ctx, user);
    socket.send({ type: 'subscribe', receiptId: id });
    await socket.next();
    const idle = await TestSocket.open(relay.url);
    await relay.stop();
    expect((await socket.closedWithin()).code).toBe(CLOSE.restart);
    expect((await idle.closedWithin()).code).toBe(CLOSE.restart);
  });
});
