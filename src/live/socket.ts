/**
 * The live socket, `GET /v1/live` (docs/live-sos-plan.md §5.2, D15, D16, D18; docs/app-api-contract.md §5).
 *
 * One `LiveHub` per relay instance. It owns the instance's LISTEN connection (src/live/listener.ts)
 * and an index of its sockets by subscribed submission, by token family and by user:
 * - a `sos_live` notification reads the snapshot once (readSnapshotById) and offers it to each socket
 *   subscribed to that SOS;
 * - a `session_revoked` notification closes that family's sockets with 4003;
 * - after the listener reconnects, every subscribed SOS is re-read and pushed, and every socket's
 *   session is re-checked, since notifications sent while it was away are lost.
 *
 * One `LiveSocket` per connection. Its messages are handled one at a time, in order. Every message
 * after auth re-checks the session (`verifyAccess`: expiry, revoked or missing family) as a backstop
 * to the notification. A socket never receives a lower `version` than the last one it was sent, so
 * a slow read that loses a race with a newer one is dropped, not delivered.
 *
 * Nothing here logs a token or a location.
 */
import type { RawData, WebSocket } from 'ws';
import { AuthError } from '../auth/errors.js';
import { type AuthKeys, deriveAuthKeys } from '../auth/keys.js';
import { verifyAccess } from '../auth/requireUser.js';
import { SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import { FINAL_STATUSES } from '../db/types.js';
import { safeError } from '../errors.js';
import { RECEIPT_ID_PATTERN } from '../ids.js';
import { locationIsFresh, locationIsSound } from '../sos/validate.js';
import { LiveListener } from './listener.js';
import { storeLiveLocation } from './location.js';
import { CLOSE, type ClientMessage, parseClientMessage, type ServerErrorCode } from './protocol.js';
import { readSnapshot, readSnapshotById } from './read.js';
import type { LiveSnapshot } from './snapshot.js';
import { watchSubmission } from './watch.js';

export interface LiveOptions {
  /** A socket with no Bearer header must send `auth` within this. Plan D15: 5 s. */
  authTimeoutMs: number;
  /** Closed 4008 after this long with no `ping`. Plan §5.2: 60 s. */
  idleTimeoutMs: number;
  /** Listener reconnect backoff: first delay, doubling up to the max. */
  listenerRetryMinMs: number;
  listenerRetryMaxMs: number;
  /** Authenticated sockets one user may hold on one instance; one more is closed 4029. */
  maxSocketsPerUser: number;
  /** A socket with more than this queued and unsent is not reading: it is dropped. */
  maxBufferedBytes: number;
  /** At most this many messages per socket per window; the rest get `rate_limited`. */
  messageBudget: number;
  messageWindowMs: number;
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = {
  authTimeoutMs: 5 * SECOND,
  idleTimeoutMs: 60 * SECOND,
  listenerRetryMinMs: 500,
  listenerRetryMaxMs: 30 * SECOND,
  maxSocketsPerUser: 5,
  maxBufferedBytes: 64 * 1024,
  messageBudget: 20,
  messageWindowMs: 10 * SECOND,
};

/** How long shutdown waits for in-flight message handlers and reads before the pool closes. */
const DRAIN_ON_CLOSE_MS = 2 * SECOND;

const RECEIPT_ID = new RegExp(RECEIPT_ID_PATTERN);

type Offer = 'answer' | 'push' | 'refresh';

function addTo<K>(map: Map<K, Set<LiveSocket>>, key: K, socket: LiveSocket): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(socket);
}

function removeFrom<K>(map: Map<K, Set<LiveSocket>>, key: K | undefined, socket: LiveSocket): void {
  if (key === undefined) return;
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) map.delete(key);
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class LiveHub {
  readonly options: LiveOptions;
  readonly keys: AuthKeys;
  private readonly listener: LiveListener;
  private readonly sockets = new Set<LiveSocket>();
  private readonly bySubmission = new Map<string, Set<LiveSocket>>();
  private readonly byFamily = new Map<string, Set<LiveSocket>>();
  private readonly byUser = new Map<string, Set<LiveSocket>>();
  /** One snapshot read at a time per submission; a notification during it asks for one more. */
  private readonly reads = new Map<string, { again: boolean; refresh: boolean }>();
  private readonly inflight = new Set<Promise<void>>();
  private closing = false;

  constructor(
    readonly ctx: AppContext,
    options: Partial<LiveOptions> = {},
  ) {
    this.options = { ...DEFAULT_LIVE_OPTIONS, ...options };
    this.keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
    this.listener = new LiveListener(
      {
        connectionString: ctx.config.databaseUrl,
        retryMinMs: this.options.listenerRetryMinMs,
        retryMaxMs: this.options.listenerRetryMaxMs,
        log: ctx.log,
      },
      {
        onLive: (id) => this.push(id, 'push'),
        onRevoked: (familyId) => this.revoked(familyId),
        onReconnect: () => this.reconnected(),
      },
    );
  }

  /** A new upgraded connection. Called synchronously from the route, so no message is missed. */
  accept(ws: WebSocket, bearer: string | undefined): void {
    if (this.closing) {
      ws.close(CLOSE.restart, 'restarting');
      return;
    }
    const socket = new LiveSocket(this, ws);
    this.sockets.add(socket);
    // The listener is opened with the first socket, so an app that never serves one holds no connection.
    void this.listener.start();
    socket.begin(bearer);
  }

  /** Resolves once the listener has made its first connection attempt. */
  listening(): Promise<void> {
    return this.listener.start();
  }

  socketsOf(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  bindSession(
    socket: LiveSocket,
    userId: string,
    familyId: string,
    previousFamily: string | undefined,
  ): void {
    removeFrom(this.byFamily, previousFamily, socket);
    addTo(this.byFamily, familyId, socket);
    addTo(this.byUser, userId, socket);
  }

  bindSubmission(socket: LiveSocket, submissionId: string, previous: string | undefined): void {
    removeFrom(this.bySubmission, previous, socket);
    addTo(this.bySubmission, submissionId, socket);
  }

  forget(socket: LiveSocket): void {
    this.sockets.delete(socket);
    removeFrom(this.bySubmission, socket.subscribed, socket);
    removeFrom(this.byFamily, socket.familyId, socket);
    removeFrom(this.byUser, socket.userId, socket);
  }

  /** Keeps `work` in flight for shutdown, and never lets it reject. */
  track(work: () => Promise<void>): Promise<void> {
    const p = work().catch((err) => {
      this.ctx.log.warn({ error: safeError(err) }, 'live socket task failed');
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private push(submissionId: string, mode: 'push' | 'refresh'): void {
    if (!this.bySubmission.has(submissionId)) return;
    const running = this.reads.get(submissionId);
    if (running) {
      running.again = true;
      running.refresh ||= mode === 'refresh';
      return;
    }
    const state = { again: false, refresh: mode === 'refresh' };
    this.reads.set(submissionId, state);
    void this.track(async () => {
      try {
        do {
          const offer: Offer = state.refresh ? 'refresh' : 'push';
          state.again = false;
          state.refresh = false;
          const found = await readSnapshotById(this.ctx.db, submissionId, this.ctx.clock.now());
          const subscribers = this.bySubmission.get(submissionId);
          if (!subscribers) break;
          if (!found) {
            // Purged while watched.
            for (const s of [...subscribers]) s.close(CLOSE.notFound, 'not found');
            break;
          }
          const { userId, ...snapshot } = found;
          for (const s of [...subscribers]) s.offer(snapshot, offer, userId);
        } while (state.again);
      } finally {
        this.reads.delete(submissionId);
      }
    });
  }

  private revoked(familyId: string): void {
    const sockets = this.byFamily.get(familyId);
    if (!sockets) return;
    for (const s of [...sockets]) s.close(CLOSE.revoked, 'session revoked');
  }

  private reconnected(): void {
    for (const id of [...this.bySubmission.keys()]) this.push(id, 'refresh');
    for (const s of [...this.sockets]) s.recheckSoon();
  }

  /** App shutdown: every socket 1012, then the listener; waits briefly for in-flight work. */
  async close(): Promise<void> {
    this.closing = true;
    for (const s of [...this.sockets]) s.close(CLOSE.restart, 'restarting');
    await this.listener.stop();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DRAIN_ON_CLOSE_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}

export class LiveSocket {
  userId: string | undefined;
  familyId: string | undefined;
  subscribed: string | undefined;
  private token: string | undefined;
  private lastVersion = -1;
  private closed = false;
  private authTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    private readonly hub: LiveHub,
    private readonly ws: WebSocket,
  ) {}

  private get ctx(): AppContext {
    return this.hub.ctx;
  }

  begin(bearer: string | undefined): void {
    this.ws.on('message', (data, isBinary) => this.received(data, isBinary));
    this.ws.on('close', () => this.dispose());
    // ws closes the socket itself after an error (a frame over maxPayload is closed 1009).
    this.ws.on('error', () => {});
    this.resetIdle();
    if (bearer !== undefined) {
      this.enqueue(() => this.authenticate(bearer));
    } else {
      this.authTimer = setTimeout(
        () => this.close(CLOSE.unauthorized, 'no auth'),
        this.hub.options.authTimeoutMs,
      );
    }
  }

  close(code: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  /** Re-checks the session after the listener was away (a revocation may have been missed). */
  recheckSoon(): void {
    if (this.userId !== undefined) this.enqueue(async () => void (await this.recheck()));
  }

  /** A snapshot for this socket's SOS. Dropped if it is for another SOS, user or an older version. */
  offer(snapshot: LiveSnapshot, mode: Offer, ownerId?: string): void {
    if (this.closed || snapshot.receiptId !== this.subscribed) return;
    if (ownerId !== undefined && ownerId !== this.userId) return;
    if (mode === 'push' ? snapshot.version <= this.lastVersion : snapshot.version < this.lastVersion) return;
    // Backpressure: snapshots are whole states, so a socket that has stopped reading loses nothing by
    // being dropped. It reconnects and gets the current one.
    if (this.ws.bufferedAmount > this.hub.options.maxBufferedBytes) {
      this.ctx.log.warn({ userId: this.userId }, 'live socket not reading; dropped');
      this.closed = true;
      this.dispose();
      this.ws.terminate();
      return;
    }
    this.lastVersion = snapshot.version;
    this.send(snapshot);
    if (FINAL_STATUSES.includes(snapshot.status)) this.close(CLOSE.final, 'final');
  }

  private dispose(): void {
    this.closed = true;
    clearTimeout(this.authTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.idleTimer);
    this.hub.forget(this);
  }

  private send(message: object): void {
    // Once close() has run the socket is CLOSING, so nothing is sent after a close frame.
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private sendError(code: ServerErrorCode): void {
    if (!this.closed) this.send({ type: 'error', code });
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(() =>
      this.closed
        ? undefined
        : this.hub.track(async () => {
            try {
              await work();
            } catch (err) {
              this.ctx.log.warn({ userId: this.userId, error: safeError(err) }, 'live socket message failed');
              this.sendError('unavailable');
            }
          }),
    );
  }

  private withinBudget(): boolean {
    const now = this.ctx.clock.now().getTime();
    if (now - this.windowStart >= this.hub.options.messageWindowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= this.hub.options.messageBudget;
  }

  private received(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (!this.withinBudget()) {
      this.sendError('rate_limited');
      return;
    }
    const text = isBinary ? undefined : rawText(data);
    this.enqueue(() => this.handle(text));
  }

  private async handle(text: string | undefined): Promise<void> {
    const parsed = text === undefined ? undefined : parseClientMessage(text);
    const message = parsed?.ok ? parsed.message : undefined;

    if (message?.type === 'auth') return this.authenticate(message.token);
    if (this.userId === undefined) return this.close(CLOSE.unauthorized, 'auth required');
    if (!(await this.recheck())) return;
    if (!message) return this.sendError('bad_message');

    switch (message.type) {
      case 'subscribe':
        return this.subscribe(message.receiptId);
      case 'ping':
        return this.ping();
      case 'location':
        return this.location(message);
    }
  }

  /** The upgrade's Bearer token, or an in-band `auth` (the first one, or a re-auth). */
  private async authenticate(token: string): Promise<void> {
    // A revocation or snapshot change committed before the instance's first LISTEN is never announced
    // to it; one committed after is. So the session is checked (and, later, the snapshot read) only once
    // the listener has had its first try. After that this is an already-resolved promise.
    await this.hub.listening();
    if (this.closed) return;
    let access: Awaited<ReturnType<typeof verifyAccess>>;
    try {
      access = await verifyAccess(this.ctx, this.hub.keys, token, { allowExpired: false });
    } catch (err) {
      if (err instanceof AuthError) return this.refuse(err);
      // The database is unreachable. Before auth there is nothing to keep: try again later.
      if (this.userId === undefined) return this.close(CLOSE.tryAgain, 'try again later');
      throw err;
    }
    if (this.closed) return;
    if (this.userId !== undefined && access.userId !== this.userId) {
      return this.close(CLOSE.unauthorized, 'another user');
    }
    if (
      this.userId === undefined &&
      this.hub.socketsOf(access.userId) >= this.hub.options.maxSocketsPerUser
    ) {
      return this.close(CLOSE.tooManySockets, 'too many sockets');
    }
    clearTimeout(this.authTimer);
    this.hub.bindSession(this, access.userId, access.familyId, this.familyId);
    this.userId = access.userId;
    this.familyId = access.familyId;
    this.token = token;
    clearTimeout(this.expiryTimer);
    const ttl = Math.max(0, access.expiresAt.getTime() - this.ctx.clock.now().getTime());
    this.expiryTimer = setTimeout(() => this.close(CLOSE.unauthorized, 'token expired'), ttl);
  }

  /** The backstop: is the current token still unexpired, and its session live? */
  private async recheck(): Promise<boolean> {
    try {
      await verifyAccess(this.ctx, this.hub.keys, this.token, { allowExpired: false });
    } catch (err) {
      if (err instanceof AuthError) {
        this.refuse(err);
        return false;
      }
      // Unreachable database: the message itself will fail or succeed on its own.
      return !this.closed;
    }
    return !this.closed;
  }

  private refuse(err: AuthError): void {
    this.close(err.code === 'session_revoked' ? CLOSE.revoked : CLOSE.unauthorized, err.code);
  }

  private async subscribe(receiptId: string): Promise<void> {
    if (!RECEIPT_ID.test(receiptId)) return this.close(CLOSE.notFound, 'not found');
    if (receiptId !== this.subscribed) {
      this.hub.bindSubmission(this, receiptId, this.subscribed);
      this.subscribed = receiptId;
      this.lastVersion = -1;
    }
    const now = this.ctx.clock.now();
    const snapshot = await readSnapshot(this.ctx.db, receiptId, this.userId!, now);
    if (this.closed) return;
    if (!snapshot) return this.close(CLOSE.notFound, 'not found');
    if (!FINAL_STATUSES.includes(snapshot.status)) await watchSubmission(this.ctx.db, receiptId, now);
    this.offer(snapshot, 'answer');
  }

  private async ping(): Promise<void> {
    this.resetIdle();
    if (this.subscribed !== undefined) {
      await watchSubmission(this.ctx.db, this.subscribed, this.ctx.clock.now());
    }
    this.send({ type: 'pong' });
  }

  private async location(message: Extract<ClientMessage, { type: 'location' }>): Promise<void> {
    if (this.subscribed === undefined) return this.sendError('not_subscribed');
    const now = this.ctx.clock.now();
    const capturedAt = new Date(message.capturedAt);
    if (!locationIsSound(message) || !locationIsFresh(capturedAt, now)) {
      return this.sendError('invalid_location');
    }
    // Stored or ignored (one per 5 s, open SOS only); a stored one comes back as a snapshot.
    await storeLiveLocation(
      this.ctx.db,
      this.subscribed,
      this.userId!,
      { lat: message.lat, lon: message.lon, capturedAt },
      now,
    );
  }

  private resetIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(CLOSE.idle, 'idle'), this.hub.options.idleTimeoutMs);
  }
}
