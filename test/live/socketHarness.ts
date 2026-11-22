/**
 * A real `ws` client against a listening relay, for the live socket tests. Each `Instance` is one
 * relay process: its own app, its own context, its own pool and its own LISTEN connection, on the
 * one test database.
 */
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { inject } from 'vitest';
import WebSocket from 'ws';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { FakeClock } from '../../src/clock.js';
import { createDb, type Db } from '../../src/db/index.js';
import type { NewSubmission, SubmissionStatus } from '../../src/db/types.js';
import { newReceiptId } from '../../src/ids.js';
import { LISTENER_APPLICATION_NAME } from '../../src/live/listener.js';
import type { LiveOptions } from '../../src/live/socket.js';
import { bumpLiveVersion } from '../../src/live/version.js';
import { insertSubmission } from '../delivery/fixtures.js';
import { createTestContext, type TestContext, testConfig } from '../helpers/context.js';
import type { SeededUser } from '../helpers/seed.js';

/** Short timings so the tests run on real timers in well under a second each. */
export const FAST: Partial<LiveOptions> = {
  authTimeoutMs: 300,
  idleTimeoutMs: 800,
  listenerRetryMinMs: 50,
  listenerRetryMaxMs: 200,
};

export interface Instance {
  ctx: TestContext;
  app: PublicApp;
  url: string;
  /** This instance's own pool: closed by `stop`. */
  db: Db;
  stop: () => Promise<void>;
}

const started: Instance[] = [];

export async function startInstance(
  opts: { clock?: FakeClock; live?: Partial<LiveOptions> } = {},
): Promise<Instance> {
  const base = testConfig();
  const db = createDb(inject('databaseUrl'), 3);
  const ctx = createTestContext({
    db,
    clock: opts.clock ?? new FakeClock(),
    config: { ...base, limits: { ...base.limits, requestsPerIpPerMinute: 10_000 } },
  });
  const app = await buildPublicApp(ctx, { live: { ...FAST, ...opts.live } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  let stopped = false;
  const instance: Instance = {
    ctx,
    app,
    db,
    url: `ws://127.0.0.1:${port}/v1/live`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await app.close();
      await db.destroy();
    },
  };
  started.push(instance);
  return instance;
}

/** Call in afterEach. */
export async function stopInstances(): Promise<void> {
  for (const i of started.splice(0)) await i.stop();
}

export interface Closed {
  code: number;
  reason: string;
}

// biome-ignore lint/suspicious/noExplicitAny: test messages are inspected loosely
type Msg = any;

/** One client socket. Messages are queued so a test can await them in order. */
export class TestSocket {
  private readonly queue: Msg[] = [];
  private readonly waiters: ((m: Msg) => void)[] = [];
  readonly closed: Promise<Closed>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.isClosed = true;
        resolve({ code, reason: String(reason) });
      });
    });
    ws.on('error', () => {});
  }

  static open(url: string, token?: string): Promise<TestSocket> {
    const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const s = new TestSocket(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(s));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** The next message, or a failure after `timeoutMs`. */
  next(timeoutMs = 3000): Promise<Msg> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = (m: Msg) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Sends a ping and returns every message received before its pong. The relay handles one socket's
   * messages in order, so everything an earlier message caused has been sent by then.
   */
  async drain(timeoutMs = 3000): Promise<Msg[]> {
    this.send({ type: 'ping' });
    const seen: Msg[] = [];
    for (;;) {
      const m = await this.next(timeoutMs);
      if (m.type === 'pong') return seen;
      seen.push(m);
    }
  }

  /** Resolves with the close, or fails if the socket is still open after `timeoutMs`. */
  closedWithin(timeoutMs = 3000): Promise<Closed> {
    return Promise.race([
      this.closed,
      new Promise<Closed>((_, reject) =>
        setTimeout(() => reject(new Error(`socket still open after ${timeoutMs} ms`)), timeoutMs),
      ),
    ]);
  }

  /** Messages received so far and not yet taken. */
  pending(): Msg[] {
    return [...this.queue];
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An access token for `user` that expires `ttlMs` after the clock's current time (whole seconds). */
export function tokenExpiringIn(ctx: TestContext, user: SeededUser, ttlMs: number): string {
  const key = deriveAuthKeys(ctx.config.auth.tokenSecret).access;
  const iat = ctx.clock.now();
  return signAccessToken(key, {
    sub: user.user.id,
    fam: user.familyId,
    jti: `jti-${Math.random()}`,
    iat,
    exp: new Date(iat.getTime() + ttlMs),
  });
}

/** An SOS of `user`'s, `queued` unless told otherwise. Its id is a well-formed receipt id. */
export async function seedSos(
  ctx: TestContext,
  user: SeededUser,
  overrides: Partial<NewSubmission> = {},
): Promise<string> {
  return insertSubmission(ctx.db, ctx.clock.now(), {
    id: newReceiptId(ctx.clock.now().getTime()),
    user_id: user.user.id,
    ...overrides,
  });
}

/** Commits a change the snapshot shows (optionally a status change) from `db`, as the poller would. */
export async function commitChange(db: Db, submissionId: string, status?: SubmissionStatus): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (status) await trx.updateTable('submissions').set({ status }).where('id', '=', submissionId).execute();
    await bumpLiveVersion(trx, submissionId);
  });
}

/** Kills every live listener connection, as a database restart or network drop would. */
export async function killListeners(db: Db): Promise<number> {
  const r = await sql<{ pid: number }>`
    SELECT pg_terminate_backend(pid) AS pid FROM pg_stat_activity
    WHERE application_name = ${LISTENER_APPLICATION_NAME}`.execute(db);
  return r.rows.length;
}

/** How many live listener connections the database sees. */
export async function listenerCount(db: Db): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ${LISTENER_APPLICATION_NAME}`.execute(
    db,
  );
  return Number(r.rows[0]?.n ?? 0);
}
