import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import type { Config, Limits } from '../../src/config.js';
import type { CoreClient } from '../../src/core/types.js';
import type { Labels, MetricName, Metrics } from '../../src/metrics.js';
import type { SaveResult } from '../delivery/fixtures.js';
import {
  createTestContext,
  markHealthy,
  TEST_INTAKE_CODE,
  type TestContext,
  testConfig,
} from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';

/** A valid phone number for tests that need one fixed number; `caller(h)` draws a unique one. */
export const PHONE = '+2348012345678';
/** The full name `caller(h)` gives its user unless told otherwise. */
export const NAME = 'Adaeze Okonkwo-Bello';
export const ADDRESS = '12 Marina Road, opposite Kingsway pharmacy';
export const LAT = 6.524417;
export const LON = 3.379206;

/** Valid Nigerian mobile numbers, distinct per index, for tests that need many phones. */
export function phoneN(i: number): string {
  return `+23480123456${String(i % 100).padStart(2, '0')}`;
}

export class RecordingMetrics implements Metrics {
  readonly incs: { name: MetricName; labels?: Labels }[] = [];
  readonly observations: { name: MetricName; seconds: number }[] = [];
  inc(name: MetricName, labels?: Labels): void {
    this.incs.push({ name, labels });
  }
  observe(name: MetricName, seconds: number): void {
    this.observations.push({ name, seconds });
  }
  set(): void {}
  count(name: MetricName, labels: Labels = {}): number {
    return this.incs.filter(
      (i) => i.name === name && Object.entries(labels).every(([k, v]) => i.labels?.[k] === v),
    ).length;
  }
}

/** A pino logger at trace level whose every line is kept, for scanning. */
export function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: 'trace' }, stream), lines };
}

/**
 * A Core whose saveCall takes `delayMs` but, like the real client, gives up at the timeout it is
 * handed and reports a retryable timeout.
 */
export function slowCore(delayMs: number, result: SaveResult = { kind: 'ok', data: { callId: '777' } }) {
  const calls: { timeoutMs: number | undefined }[] = [];
  const core: CoreClient & { calls: typeof calls } = {
    calls,
    saveCall: async (_input, _id, opts) => {
      calls.push({ timeoutMs: opts?.timeoutMs });
      const limit = opts?.timeoutMs ?? 6000;
      await new Promise((r) => setTimeout(r, Math.min(delayMs, limit)));
      return delayMs > limit ? { kind: 'retryable', reason: 'timeout' } : result;
    },
    getCall: async () => {
      throw new Error('unexpected');
    },
    getPendingCalls: async () => {
      throw new Error('unexpected');
    },
    getCallTypes: async () => {
      throw new Error('unexpected');
    },
    getCallPriorities: async () => {
      throw new Error('unexpected');
    },
    getFieldPolicy: async () => {
      throw new Error('unexpected');
    },
  };
  return core;
}

export interface Harness {
  ctx: TestContext;
  app: PublicApp;
  metrics: RecordingMetrics;
}

export async function harness(
  opts: {
    core?: CoreClient;
    limits?: Partial<Limits>;
    config?: Partial<Config>;
    log?: TestContext['log'];
    healthy?: boolean;
  } = {},
): Promise<Harness> {
  const metrics = new RecordingMetrics();
  const base = testConfig(opts.config);
  const ctx = createTestContext({
    config: { ...base, limits: { ...base.limits, ...opts.limits } },
    metrics,
    ...(opts.core ? { core: opts.core } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  if (opts.healthy !== false) await markHealthy(ctx);
  const app = await buildPublicApp(ctx);
  return { ctx, app, metrics };
}

export function isoAgo(ctx: TestContext, ms: number): string {
  return new Date(ctx.clock.now().getTime() - ms).toISOString();
}

export function sosBody(ctx: TestContext, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intakeCode: TEST_INTAKE_CODE,
    location: { lat: LAT, lon: LON, accuracyM: 12, capturedAt: isoAgo(ctx, 8000), source: 'gps' },
    ...overrides,
  };
}

export interface PostOpts {
  token?: string | null;
  key?: string | null;
  body?: unknown;
  /** Raw payload, sent as is. */
  payload?: string;
  ip?: string;
  headers?: Record<string, string>;
}

export async function postSos(app: PublicApp, opts: PostOpts) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-real-ip': opts.ip ?? '203.0.113.7',
  };
  if (opts.token !== null && opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sos',
    headers: { ...headers, ...opts.headers },
    payload: opts.payload ?? JSON.stringify(opts.body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
  return { status: res.statusCode, body: res.json() as Record<string, any>, headers: res.headers };
}

/**
 * Seeds a signed-in user and returns a sender bound to them, with a fresh access token per request.
 * The phone is unique unless `phone` is given (phones are unique per account).
 */
export async function caller(h: Harness, opts: { phone?: string; fullName?: string } = {}) {
  const seeded = await seedUser(h.ctx, { fullName: NAME, ...opts });
  return {
    ...seeded,
    send: (overrides: Record<string, unknown> = {}, opts: Omit<PostOpts, 'token' | 'body'> = {}) =>
      postSos(h.app, { token: seeded.token(), body: sosBody(h.ctx, overrides), ...opts }),
  };
}

/** Marks every open submission of a user closed, so they may send again. */
export async function closeAll(h: Harness, userId: string): Promise<void> {
  await h.ctx.db
    .updateTable('submissions')
    .set({ status: 'closed', closed_at: h.ctx.clock.now() })
    .where('user_id', '=', userId)
    .where('status', 'in', ['queued', 'received', 'dispatched'])
    .execute();
}

export async function submissionCount(h: Harness): Promise<number> {
  const rows = await h.ctx.db.selectFrom('submissions').select('id').execute();
  return rows.length;
}
