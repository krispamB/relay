/**
 * The instance's one LISTEN connection (docs/live-sos-plan.md D16, §5.4). A dedicated `pg.Client`,
 * outside the Kysely pool, listening on LIVE_CHANNEL (payload: a submission id whose snapshot changed)
 * and SESSION_REVOKED_CHANNEL (payload: a revoked or deleted token family id).
 *
 * When the connection drops (a database restart, a network cut, an idle-session kill) it reconnects
 * with exponential backoff and jitter, and then calls `onReconnect`, so the hub can push a fresh
 * snapshot to every socket and re-check every session: whatever was notified while it was away is
 * lost, and this costs at most one push. A first connect that fails is retried the same way.
 */
import pg from 'pg';
import { SESSION_REVOKED_CHANNEL } from '../auth/sessions.js';
import type { Logger } from '../logger.js';
import { LIVE_CHANNEL } from './version.js';

/** Shows in pg_stat_activity, so an operator (or a test) can find the listener connections. */
export const LISTENER_APPLICATION_NAME = 'sos-relay-live';

export interface ListenerHandlers {
  onLive: (submissionId: string) => void;
  onRevoked: (familyId: string) => void;
  /** After a connect that followed a drop or a failed first attempt. */
  onReconnect: () => void;
}

export interface ListenerOptions {
  connectionString: string;
  retryMinMs: number;
  retryMaxMs: number;
  log: Logger;
}

export class LiveListener {
  private client: pg.Client | undefined;
  private starting: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly options: ListenerOptions,
    private readonly handlers: ListenerHandlers,
  ) {}

  /** Connects once; later calls return the same promise. Never rejects: a failure is retried. */
  start(): Promise<void> {
    this.starting ??= this.connect().then((ok) => {
      if (!ok) this.scheduleRetry();
    });
    return this.starting;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }

  private async connect(): Promise<boolean> {
    if (this.stopped) return false;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      application_name: LISTENER_APPLICATION_NAME,
      keepAlive: true,
      connectionTimeoutMillis: 5000,
    });
    // An 'error' is always followed by 'end', where the reconnect happens. Without a listener an
    // error event would crash the process.
    client.on('error', (err) => {
      this.options.log.warn({ code: (err as { code?: string }).code }, 'live listener connection error');
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      await client.query(`LISTEN ${SESSION_REVOKED_CHANNEL}`);
    } catch (err) {
      this.options.log.warn({ code: (err as { code?: string }).code }, 'live listener could not connect');
      await client.end().catch(() => {});
      return false;
    }
    if (this.stopped) {
      await client.end().catch(() => {});
      return false;
    }
    client.on('notification', (n) => {
      if (!n.payload) return;
      if (n.channel === LIVE_CHANNEL) this.handlers.onLive(n.payload);
      else if (n.channel === SESSION_REVOKED_CHANNEL) this.handlers.onRevoked(n.payload);
    });
    client.once('end', () => {
      if (this.client !== client) return;
      this.client = undefined;
      if (this.stopped) return;
      this.options.log.warn('live listener connection lost; reconnecting');
      this.scheduleRetry();
    });
    this.client = client;
    return true;
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const { retryMinMs, retryMaxMs } = this.options;
    const base = Math.min(retryMaxMs, retryMinMs * 2 ** this.failures);
    // Up to 20% jitter, so instances that lost the database together do not reconnect in lockstep.
    const delay = Math.round(base * (0.8 + Math.random() * 0.2));
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect().then((ok) => {
        if (!ok) return this.scheduleRetry();
        this.failures = 0;
        this.options.log.info('live listener reconnected');
        this.handlers.onReconnect();
      });
    }, delay);
    this.retryTimer.unref();
  }
}
