import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWebhookAlerter } from '../../src/alerts/webhook.js';
import { FakeClock, MINUTE } from '../../src/clock.js';
import { silentLogger } from '../../src/logger.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const URL_SECRET = 'https://hooks.example.test/secret-path-abc123';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(script: Array<'ok' | 'fail' | 'throw' | 'hang'> = ['ok']) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const step = script.length > 1 ? script.shift()! : script[0]!;
    if (step === 'throw') throw new Error('network down');
    if (step === 'fail') return new Response('no', { status: 500 });
    if (step === 'hang') {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function make(
  opts: {
    fetch?: ReturnType<typeof fakeFetch>;
    url?: string | undefined;
    clock?: FakeClock;
    log?: pino.Logger;
  } = {},
) {
  const clock = opts.clock ?? new FakeClock();
  const f = opts.fetch ?? fakeFetch();
  const alerter = createWebhookAlerter({
    db: testDb(),
    clock,
    log: opts.log ?? silentLogger(),
    webhookUrl: 'url' in opts ? opts.url : URL_SECRET,
    fetchImpl: f.fn,
    timeoutMs: 50,
    retryDelaysMs: [1, 1],
  });
  return { alerter, clock, f };
}

const alert = {
  severity: 'critical' as const,
  code: 'delivery_paused',
  message: 'SOS delivery paused: Core returned 401',
};

describe('webhook alerter', () => {
  it('posts the documented body', async () => {
    const { alerter, f } = make();
    await alerter.raise({ ...alert, reference: 'SOS-ABCD', receiptId: 'sos_X' });
    await alerter.flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(URL_SECRET);
    expect(f.calls[0]!.body).toEqual({
      severity: 'critical',
      code: 'delivery_paused',
      text: '[critical] SOS delivery paused: Core returned 401',
      reference: 'SOS-ABCD',
      receiptId: 'sos_X',
      at: '2026-11-17T12:00:00.000Z',
    });
  });

  it('uses null for a missing reference and receipt id', async () => {
    const { alerter, f } = make();
    await alerter.raise(alert);
    await alerter.flush();
    expect(f.calls[0]!.body.reference).toBeNull();
    expect(f.calls[0]!.body.receiptId).toBeNull();
  });

  it('only logs with no webhook, at the severity level', async () => {
    const lines: Array<{ level: number; msg: string }> = [];
    const log = pino({ level: 'trace' }, { write: (s: string) => lines.push(JSON.parse(s)) });
    const { alerter, f } = make({ url: undefined, log });
    await alerter.raise(alert);
    await alerter.raise({ severity: 'warning', code: 'w', message: 'careful' });
    await alerter.flush();
    expect(f.calls).toHaveLength(0);
    expect(lines.find((l) => l.msg === alert.message)?.level).toBe(60);
    expect(lines.find((l) => l.msg === 'careful')?.level).toBe(40);
    const rows = await testDb().selectFrom('alert_log').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('logs the alert even when the webhook is set, and never logs the URL', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'trace' }, { write: (s: string) => lines.push(s) });
    const { alerter } = make({ fetch: fakeFetch(['fail']), log });
    await alerter.raise(alert);
    await alerter.flush();
    expect(lines.some((l) => l.includes(alert.message))).toBe(true);
    expect(lines.some((l) => l.includes('delivery failed'))).toBe(true);
    expect(lines.join('')).not.toContain('secret-path');
  });

  it('de-duplicates the same code for 15 minutes, then releases', async () => {
    const { alerter, clock, f } = make();
    await alerter.raise(alert);
    clock.advance(14 * MINUTE);
    await alerter.raise(alert);
    await alerter.flush();
    expect(f.calls).toHaveLength(1);
    clock.advance(1 * MINUTE);
    await alerter.raise(alert);
    await alerter.flush();
    expect(f.calls).toHaveLength(2);
  });

  it('de-duplicates per code', async () => {
    const { alerter, f } = make();
    await alerter.raise(alert);
    await alerter.raise({ ...alert, code: 'other' });
    await alerter.flush();
    expect(f.calls).toHaveLength(2);
  });

  it('always: true skips de-duplication', async () => {
    const { alerter, f } = make();
    await alerter.raise({ ...alert, always: true });
    await alerter.raise({ ...alert, always: true });
    await alerter.flush();
    expect(f.calls).toHaveLength(2);
  });

  it('retries on failure and gives up after three tries', async () => {
    const f = fakeFetch(['fail', 'throw', 'ok']);
    const { alerter } = make({ fetch: f });
    await alerter.raise(alert);
    await alerter.flush();
    expect(f.calls).toHaveLength(3);

    const g = fakeFetch(['fail']);
    const b = make({ fetch: g });
    await b.alerter.raise({ ...alert, code: 'x' });
    await b.alerter.flush();
    expect(g.calls).toHaveLength(3);
  });

  it('retries after a timeout', async () => {
    const f = fakeFetch(['hang', 'ok']);
    const { alerter } = make({ fetch: f });
    await alerter.raise(alert);
    await alerter.flush();
    expect(f.calls).toHaveLength(2);
  });

  it('raise() returns without waiting for a slow webhook and never throws', async () => {
    const f = fakeFetch(['hang']);
    const { alerter } = make({ fetch: f });
    const started = Date.now();
    await alerter.raise(alert);
    expect(Date.now() - started).toBeLessThan(40);
    await alerter.flush();
    expect(f.calls).toHaveLength(3);

    const bad = createWebhookAlerter({
      db: {
        insertInto: () => {
          throw new Error('db gone');
        },
      } as never,
      clock: new FakeClock(),
      log: silentLogger(),
      webhookUrl: URL_SECRET,
      fetchImpl: fakeFetch().fn,
      retryDelaysMs: [],
    });
    await expect(bad.raise(alert)).resolves.toBeUndefined();
    await bad.flush();
  });

  it('two alerters sharing a database de-duplicate between them', async () => {
    const clock = new FakeClock();
    const a = make({ clock });
    const b = make({ clock });
    await Promise.all([a.alerter.raise(alert), b.alerter.raise(alert)]);
    await a.alerter.flush();
    await b.alerter.flush();
    expect(a.f.calls.length + b.f.calls.length).toBe(1);
  });
});
