/**
 * End-to-end: the real public app, the real Core client against the in-repo mock Core, the real
 * Postgres and the real delivery worker pass. Only attestation (accept-all) and the clock are fake.
 *
 * The status poller is built elsewhere; dispatched/closed transitions are deliberately not tested here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_API_KEY, type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { buildAdminApp } from '../../src/admin/app.js';
import { ALERT_CODES } from '../../src/alerts.js';
import type { PublicApp } from '../../src/app.js';
import { createCoreClient, SAVE_CALL_FIELDS } from '../../src/core/client.js';
import { runDeliveryPass } from '../../src/jobs/deliveryWorker.js';
import { silentLogger } from '../../src/logger.js';
import { NoopMetrics } from '../../src/metrics.js';
import {
  closeTestDb,
  DEMO_INTAKE_CODE,
  resetDb,
  TEST_INTAKE_CODE,
  type TestContext,
  testConfig,
} from '../helpers/context.js';
import { type Harness, harness, postSos, sosBody } from '../sos/helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
type Json = Record<string, any>;

let mock: RunningMockCore;
let h: Harness | undefined;

beforeAll(async () => {
  mock = await startMockCore({
    callTypes: ['Public SOS'],
    priorities: [{ Id: 3, Name: 'High' }],
  });
});
afterAll(async () => {
  await mock.close();
  await closeTestDb();
});

beforeEach(async () => {
  mock.control.reset();
  await resetDb();
  const base = testConfig();
  h = await harness({
    core: createCoreClient(
      { apiBase: mock.url, apiKey: DEFAULT_API_KEY },
      { log: silentLogger(), metrics: new NoopMetrics() },
    ),
    config: { resgrid: { ...base.resgrid, apiBase: mock.url, apiKey: DEFAULT_API_KEY } },
  });
});

afterEach(async () => {
  // Hygiene that must hold in every scenario (integration.md section 2.2, 4.2, 4.3).
  const requests = mock.control.requests();
  for (const r of requests) {
    expect(r.headers.authorization, `${r.method} ${r.path} carried Authorization`).toBeUndefined();
    expect(r.headers['x-resgrid-systemapikey']).toBeUndefined();
  }
  for (const r of mock.control.requests({ endpoint: 'Calls/SaveCall' })) {
    const body = r.body as Record<string, unknown>;
    expect(typeof body).toBe('object');
    for (const key of Object.keys(body)) {
      expect(SAVE_CALL_FIELDS as readonly string[]).toContain(key);
    }
    expect(body.IsPending).toBe(true);
    expect(r.headers['idempotency-key']).toBeTruthy();
  }
  await h?.app.close();
  h = undefined;
});

// ---------------------------------------------------------------------------------------------

const ctxOf = (): TestContext => h!.ctx;
const appOf = (): PublicApp => h!.app;

async function registerDevice(): Promise<string> {
  const nonceRes = await appOf().inject({ method: 'GET', url: '/v1/devices/nonce' });
  expect(nonceRes.statusCode).toBe(200);
  const { nonce } = nonceRes.json() as { nonce: string };
  const reg = await appOf().inject({
    method: 'POST',
    url: '/v1/devices/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ platform: 'android', nonce }),
  });
  expect(reg.statusCode).toBe(201);
  const body = reg.json() as { deviceId: string; deviceToken: string };
  expect(body.deviceId).toMatch(/^dev_/);
  return body.deviceToken;
}

async function getIntake(code = TEST_INTAKE_CODE) {
  const res = await appOf().inject({ method: 'GET', url: `/v1/intake/${code}` });
  return { status: res.statusCode, body: res.json() as Json };
}

async function getStatus(receiptId: string, statusToken: string) {
  const res = await appOf().inject({
    method: 'GET',
    url: `/v1/sos/${receiptId}/status`,
    headers: { 'x-status-token': statusToken },
  });
  return { status: res.statusCode, body: res.json() as Json };
}

/** Sends an SOS with the given token; the first call fixes the key and body so a retry can reuse them. */
function sender(token: string, overrides: Record<string, unknown> = {}) {
  const key = randomUUID();
  const payload = JSON.stringify(sosBody(ctxOf(), overrides));
  return () => postSos(appOf(), { token, key, payload });
}

const saveCalls = () => mock.control.requests({ endpoint: 'Calls/SaveCall' });

/** Advances past the retry backoff (first retries are 5 s, then 15 s) and runs one worker pass. */
async function passAfter(seconds: number): Promise<void> {
  ctxOf().clock.advanceSeconds(seconds);
  await runDeliveryPass(ctxOf());
}

async function adminPost(path: string) {
  const admin = await buildAdminApp(ctxOf());
  try {
    const res = await admin.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${ctxOf().config.adminToken}` },
    });
    return { status: res.statusCode, body: res.json() as Json };
  } finally {
    await admin.close();
  }
}

// ---------------------------------------------------------------------------------------------

describe('happy path', () => {
  it('registers, reads the intake, sends an SOS and polls its status', async () => {
    const token = await registerDevice();

    const intake = await getIntake();
    expect(intake.status).toBe(200);
    expect(intake.body.available).toBe(true);
    expect(intake.body.natures.map((n: { id: string }) => n.id)).toContain('fire');

    const res = await sender(token)();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
    expect(res.body.receiptId).toMatch(/^sos_/);

    const calls = mock.control.calls();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.InitialState).toBe(8);
    expect(call.IsPending).toBe(true);
    expect(call.Type).toBe('Public SOS');
    expect(call.Priority).toBe(3);
    expect(call.ExternalId).toBe(res.body.receiptId);
    expect(call.ReferenceId).toBe(res.body.reference);

    const status = await getStatus(res.body.receiptId, res.body.statusToken);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('received');
    expect(status.body.reference).toBe(res.body.reference);

    // The status endpoint reads the database only: no further Core request was made.
    expect(mock.control.requests()).toHaveLength(saveCalls().length);
  });
});

describe('idempotent retry', () => {
  it('returns the same receipt and token and creates no second call', async () => {
    const token = await registerDevice();
    const send = sender(token);
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.receiptId).toBe(first.body.receiptId);
    expect(second.body.statusToken).toBe(first.body.statusToken);
    expect(mock.control.calls()).toHaveLength(1);
    expect(saveCalls()).toHaveLength(1);
  });
});

describe('Core outage', () => {
  it('answers 202, then delivers once Core is back and the backoff has passed', async () => {
    const token = await registerDevice();
    mock.control.injectFault('Calls/SaveCall', { status: 503 }, 3);

    const res = await sender(token)();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(mock.control.calls()).toHaveLength(0);

    // Before the 5 s backoff has passed nothing is retried.
    await passAfter(1);
    expect(saveCalls()).toHaveLength(1);

    mock.control.clearFaults();
    await passAfter(10);
    expect(mock.control.calls()).toHaveLength(1);
    expect(mock.control.calls()[0]!.ExternalId).toBe(res.body.receiptId);

    const status = await getStatus(res.body.receiptId, res.body.statusToken);
    expect(status.body.status).toBe('received');
  });
});

describe('saved but the response was lost', () => {
  it('retries with the same Idempotency-Key and Core still holds exactly one call', async () => {
    const token = await registerDevice();
    mock.control.injectFault('Calls/SaveCall', { drop: true, afterProcessing: true }, 1);

    const res = await sender(token)();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    // Core saved it even though the relay saw a network error.
    expect(mock.control.calls()).toHaveLength(1);

    await passAfter(10);
    expect(saveCalls()).toHaveLength(2);
    const keys = saveCalls().map((r) => r.headers['idempotency-key']);
    expect(keys[0]).toBe(res.body.receiptId);
    expect(keys[1]).toBe(res.body.receiptId);

    // The guarantee, asserted on Core's own records.
    expect(mock.control.calls()).toHaveLength(1);
    const status = await getStatus(res.body.receiptId, res.body.statusToken);
    expect(status.body.status).toBe('received');
  });
});

describe('Core refuses the API key (401)', () => {
  it('pauses delivery, refuses new SOS, and resumes through the admin API', async () => {
    const tokenA = await registerDevice();
    const tokenB = await registerDevice();
    mock.control.setApiKey(`rgk_AbCdEfGh_${'x'.repeat(43)}`);

    const res = await sender(tokenA)();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(mock.control.calls()).toHaveLength(0);

    const critical = ctxOf().alerts.alerts.filter((a) => a.code === ALERT_CODES.deliveryPaused);
    expect(critical).toHaveLength(1);
    expect(critical[0]!.severity).toBe('critical');

    // A second device is refused, and the intake says so.
    const second = await postSos(appOf(), { token: tokenB, body: sosBody(ctxOf()) });
    expect(second.status).toBe(503);
    expect((await getIntake()).body.available).toBe(false);

    // The worker makes no Core call while paused.
    const before = mock.control.requests().length;
    await passAfter(60);
    expect(mock.control.requests()).toHaveLength(before);

    // Resume with the key still wrong: refused, stays paused.
    const refused = await adminPost('/admin/v1/delivery/resume');
    expect(refused.status).toBe(409);

    mock.control.setApiKey(DEFAULT_API_KEY);
    const resumed = await adminPost('/admin/v1/delivery/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body.paused).toBe(false);
    expect((await getIntake()).body.available).toBe(true);

    await passAfter(10);
    expect(mock.control.calls()).toHaveLength(1);
    const status = await getStatus(res.body.receiptId, res.body.statusToken);
    expect(status.body.status).toBe('received');
  });
});

describe('Core field-policy rejection', () => {
  it('answers 201 failed, raises a high alert and never retries', async () => {
    const token = await registerDevice();
    mock.control.setFieldPolicy([{ Key: 'what3words', Required: true }]);

    const res = await sender(token)();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');

    const alert = ctxOf().alerts.alerts.find((a) => a.code === ALERT_CODES.coreRejected);
    expect(alert?.severity).toBe('high');
    expect(alert?.reference).toBe(res.body.reference);

    expect(saveCalls()).toHaveLength(1);
    await passAfter(10);
    await passAfter(60);
    await passAfter(300);
    expect(saveCalls()).toHaveLength(1);
    expect(mock.control.calls()).toHaveLength(0);

    const status = await getStatus(res.body.receiptId, res.body.statusToken);
    expect(status.body.status).toBe('failed');
  });
});

describe('one open SOS per device', () => {
  it('answers 409 carrying the open receipt', async () => {
    const token = await registerDevice();
    const first = await sender(token)();
    expect(first.status).toBe(201);

    const second = await postSos(appOf(), { token, body: sosBody(ctxOf(), { nature: 'medical' }) });
    expect(second.status).toBe(409);
    expect(second.body.receiptId).toBe(first.body.receiptId);
    expect(second.body.statusToken).toBe(first.body.statusToken);
    expect(second.body.reference).toBe(first.body.reference);
    expect(second.body.status).toBe('received');
    expect(mock.control.calls()).toHaveLength(1);
  });
});

describe('demo intake', () => {
  it('answers 201 received and never sends a SaveCall request', async () => {
    const token = await registerDevice();
    const intake = await getIntake(DEMO_INTAKE_CODE);
    expect(intake.body.demo).toBe(true);

    const res = await postSos(appOf(), {
      token,
      body: sosBody(ctxOf(), { intakeCode: DEMO_INTAKE_CODE, nature: 'medical' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');

    await passAfter(60);
    expect(saveCalls()).toHaveLength(0);
    expect(mock.control.calls()).toHaveLength(0);
    expect(mock.control.requests()).toHaveLength(0);
  });
});
