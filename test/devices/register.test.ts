import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp, type PublicApp } from '../../src/app.js';
import { DAY, MINUTE, SECOND } from '../../src/clock.js';
import { DEFAULT_LIMITS } from '../../src/config.js';
import { ipHash, randomToken } from '../../src/crypto.js';
import { deviceTokenHash, requireDevice } from '../../src/devices/auth.js';
import { newBlockId } from '../../src/ids.js';
import { METRICS } from '../../src/metrics.js';
import { closeTestDb, createTestContext, resetDb, type TestContext, testConfig } from '../helpers/context.js';
import { seedDevice } from '../helpers/seed.js';
import {
  ANDROID_ATTESTATION,
  accept,
  capturingLogger,
  getNonce,
  IOS_ATTESTATION,
  iosKey,
  RecordingMetrics,
  refuse,
  register,
  ScriptedAttestation,
} from './fixtures.js';

const FORBIDDEN_BODY = { error: { code: 'forbidden', message: 'This request is not allowed.' } };

let ctx: TestContext;
let app: PublicApp;
let attestation: ScriptedAttestation;
let metrics: RecordingMetrics;
let logs: ReturnType<typeof capturingLogger>;

async function setup(limits: Partial<typeof DEFAULT_LIMITS> = {}): Promise<void> {
  await app?.close();
  attestation = new ScriptedAttestation(accept);
  metrics = new RecordingMetrics();
  logs = capturingLogger();
  ctx = createTestContext({
    attestation,
    metrics,
    log: logs.log,
    config: testConfig({ limits: { ...DEFAULT_LIMITS, requestsPerIpPerMinute: 0, ...limits } }),
  });
  app = await buildPublicApp(ctx);
}

function authAs(token: string): FastifyRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest;
}

async function deviceRow(id: string) {
  return ctx.db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function countDevices(): Promise<number> {
  const r = await ctx.db
    .selectFrom('devices')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

beforeEach(async () => {
  await resetDb();
  await setup();
});
afterEach(() => app.close());
afterAll(() => closeTestDb());

describe('GET /v1/devices/nonce', () => {
  it('issues a stored, unused, URL-safe nonce valid for 5 minutes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/devices/nonce' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'nonce']);
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(ctx.clock.now().getTime() + 5 * MINUTE).toISOString());
    const row = await ctx.db
      .selectFrom('nonces')
      .selectAll()
      .where('nonce', '=', body.nonce)
      .executeTakeFirstOrThrow();
    expect(row.used_at).toBeNull();
    expect(row.expires_at.toISOString()).toBe(body.expiresAt);
  });

  it('never repeats', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(await getNonce(app));
    expect(seen.size).toBe(20);
  });
});

describe('POST /v1/devices/register: new devices', () => {
  it('registers an Android device', async () => {
    const nonce = await getNonce(app);
    const res = await register(app, { nonce });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'deviceToken', 'expiresAt']);
    expect(body.deviceId).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(ctx.clock.now().getTime() + 30 * DAY).toISOString());

    expect(attestation.calls).toEqual([{ platform: 'android', nonce, attestation: ANDROID_ATTESTATION }]);

    const row = await deviceRow(body.deviceId);
    expect(row.platform).toBe('android');
    expect(row.token_hash).toBe(deviceTokenHash(body.deviceToken));
    expect(row.token_hash).not.toContain(body.deviceToken);
    expect(row.attested).toBe(true);
    expect(row.ios_key_id).toBeNull();
    expect(row.token_expires_at.toISOString()).toBe(body.expiresAt);

    const regs = await ctx.db.selectFrom('device_registrations').selectAll().execute();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.device_id).toBe(body.deviceId);
    expect(regs[0]!.ip_hash).toBe(ipHash(ctx.config.phoneHashSecret, '203.0.113.7'));

    const used = await ctx.db
      .selectFrom('nonces')
      .select('used_at')
      .where('nonce', '=', nonce)
      .executeTakeFirstOrThrow();
    expect(used.used_at).not.toBeNull();
  });

  it('registers an iOS device and stores its App Attest key', async () => {
    attestation.set(() => iosKey('S2V5MQ==', 0));
    const nonce = await getNonce(app);
    const res = await register(app, { platform: 'ios', nonce });
    expect(res.statusCode).toBe(201);
    expect(attestation.calls[0]).toEqual({ platform: 'ios', nonce, attestation: IOS_ATTESTATION });
    const row = await deviceRow(res.json().deviceId);
    expect(row.platform).toBe('ios');
    expect(row.ios_key_id).toBe('S2V5MQ==');
    expect(row.ios_public_key).toContain('BEGIN PUBLIC KEY');
    expect(Number(row.ios_counter)).toBe(0);
    expect(row.attested).toBe(true);
  });

  it('records attested = false when permissive mode lets an unattested device in', async () => {
    attestation.set(() => ({ accepted: true, attested: false }));
    const nonce = await getNonce(app);
    const res = await register(app, { body: { platform: 'ios', nonce } });
    expect(res.statusCode).toBe(201);
    expect(attestation.calls[0]!.attestation).toBeUndefined();
    const row = await deviceRow(res.json().deviceId);
    expect(row.attested).toBe(false);
    expect(row.ios_key_id).toBeNull();
  });

  it('issues a token that authenticates through requireDevice until it expires', async () => {
    const res = await register(app);
    const { deviceId, deviceToken } = res.json();
    expect((await requireDevice(ctx, authAs(deviceToken))).id).toBe(deviceId);
    ctx.clock.advance(30 * DAY - SECOND);
    expect((await requireDevice(ctx, authAs(deviceToken))).id).toBe(deviceId);
    ctx.clock.advance(SECOND);
    await expect(requireDevice(ctx, authAs(deviceToken))).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('POST /v1/devices/register: nonce', () => {
  it('refuses an unknown nonce without calling attestation', async () => {
    const res = await register(app, { nonce: randomToken(32) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_nonce');
    expect(attestation.calls).toHaveLength(0);
    expect(await countDevices()).toBe(0);
  });

  it('accepts a nonce just inside its 5 minutes and refuses it at expiry', async () => {
    const early = await getNonce(app);
    const late = await getNonce(app);
    ctx.clock.advance(5 * MINUTE - SECOND);
    expect((await register(app, { nonce: early })).statusCode).toBe(201);
    ctx.clock.advance(SECOND);
    const res = await register(app, { nonce: late });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_nonce');
  });

  it('refuses a nonce that was already used', async () => {
    const nonce = await getNonce(app);
    expect((await register(app, { nonce })).statusCode).toBe(201);
    const again = await register(app, { nonce });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_nonce');
    expect(await countDevices()).toBe(1);
  });

  it('lets exactly one of several concurrent registrations use a nonce', async () => {
    attestation.set(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return accept();
    });
    const nonce = await getNonce(app);
    const results = await Promise.all(Array.from({ length: 6 }, () => register(app, { nonce })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 400, 400, 400, 400, 400]);
    expect(attestation.calls).toHaveLength(1);
    expect(await countDevices()).toBe(1);
  });

  it('burns the nonce when attestation fails', async () => {
    attestation.set(() => refuse());
    const nonce = await getNonce(app);
    expect((await register(app, { nonce })).statusCode).toBe(403);
    attestation.set(accept);
    const retry = await register(app, { nonce });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.code).toBe('invalid_nonce');
  });
});

describe('POST /v1/devices/register: attestation', () => {
  it('answers a refusal with a 403 that says nothing, and logs the reason', async () => {
    attestation.set(() => refuse('android_verdict_not_play_recognized'));
    const res = await register(app);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_BODY);
    expect(res.body).not.toContain('play_recognized');
    expect(await countDevices()).toBe(0);
    expect(await ctx.db.selectFrom('device_registrations').selectAll().execute()).toHaveLength(0);
    expect(logs.text()).toContain('android_verdict_not_play_recognized');
  });
});

describe('POST /v1/devices/register: renewal', () => {
  it('keeps the device id, replaces the token and kills the old one at once', async () => {
    const first = (await register(app)).json();
    attestation.set(() => ({ accepted: true, attested: false }));
    const res = await register(app, { token: first.deviceToken });
    expect(res.statusCode).toBe(201);
    const second = res.json();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.deviceToken).not.toBe(first.deviceToken);

    await expect(requireDevice(ctx, authAs(first.deviceToken))).rejects.toMatchObject({ statusCode: 401 });
    expect((await requireDevice(ctx, authAs(second.deviceToken))).id).toBe(first.deviceId);

    const row = await deviceRow(first.deviceId);
    expect(row.attested).toBe(false);
    expect(await countDevices()).toBe(1);
    expect(await ctx.db.selectFrom('device_registrations').selectAll().execute()).toHaveLength(2);

    // The old token cannot renew either.
    const replay = await register(app, { token: first.deviceToken });
    expect(replay.json().deviceId).not.toBe(first.deviceId);
  });

  it('renews with an expired token while the device row still exists', async () => {
    const first = (await register(app)).json();
    ctx.clock.advance(45 * DAY);
    const res = await register(app, { token: first.deviceToken });
    expect(res.statusCode).toBe(201);
    expect(res.json().deviceId).toBe(first.deviceId);
    expect(res.json().expiresAt).toBe(new Date(ctx.clock.now().getTime() + 30 * DAY).toISOString());
  });

  it('replaces the iOS key, public key and counter on renewal', async () => {
    attestation.set(() => iosKey('T2xkS2V5', 0));
    const first = (await register(app, { platform: 'ios' })).json();
    await ctx.db.updateTable('devices').set({ ios_counter: 7 }).where('id', '=', first.deviceId).execute();
    attestation.set(() => iosKey('TmV3S2V5', 0));
    const res = await register(app, { platform: 'ios', token: first.deviceToken });
    expect(res.statusCode).toBe(201);
    const row = await deviceRow(first.deviceId);
    expect(row.ios_key_id).toBe('TmV3S2V5');
    expect(row.ios_public_key).toContain('TmV3S2V5');
    expect(Number(row.ios_counter)).toBe(0);
  });

  it('creates a new device when the bearer token is unknown', async () => {
    const existing = await seedDevice(ctx);
    const res = await register(app, { token: randomToken(32) });
    expect(res.statusCode).toBe(201);
    expect(res.json().deviceId).not.toBe(existing.device.id);
    expect(await countDevices()).toBe(2);
    expect((await requireDevice(ctx, authAs(existing.token))).id).toBe(existing.device.id);
  });

  it('refuses a renewal across platforms and leaves the device untouched', async () => {
    const android = await seedDevice(ctx, { platform: 'android' });
    attestation.set(() => iosKey('Q3Jvc3M=', 0));
    const res = await register(app, { platform: 'ios', token: android.token });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_BODY);
    expect(await countDevices()).toBe(1);
    expect((await requireDevice(ctx, authAs(android.token))).id).toBe(android.device.id);
    expect((await deviceRow(android.device.id)).platform).toBe('android');
    expect(logs.text()).toContain('renewal_platform_mismatch');
  });

  it('refuses a blocked device and keeps its identity', async () => {
    const seeded = await seedDevice(ctx);
    const now = ctx.clock.now();
    await ctx.db
      .insertInto('blocks')
      .values({
        id: newBlockId(now.getTime()),
        subject_type: 'device',
        subject: seeded.device.id,
        reason: 'hoax',
        source: 'manual',
        created_at: now,
        expires_at: new Date(now.getTime() + 30 * DAY),
      })
      .execute();
    const res = await register(app, { token: seeded.token });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_BODY);
    expect(attestation.calls).toHaveLength(0);
    expect((await deviceRow(seeded.device.id)).token_hash).toBe(deviceTokenHash(seeded.token));

    ctx.clock.advance(30 * DAY);
    const after = await register(app, { token: seeded.token });
    expect(after.statusCode).toBe(201);
    expect(after.json().deviceId).toBe(seeded.device.id);
  });

  it('gives only one of two concurrent renewals of one token the device', async () => {
    const first = (await register(app)).json();
    attestation.set(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return accept();
    });
    const [a, b] = await Promise.all([
      register(app, { token: first.deviceToken }),
      register(app, { token: first.deviceToken }),
    ]);
    const ok = [a, b].filter((r) => r.statusCode === 201);
    expect(ok).toHaveLength(1);
    expect([a, b].map((r) => r.statusCode).sort()).toEqual([201, 403]);
    expect((await requireDevice(ctx, authAs(ok[0]!.json().deviceToken))).id).toBe(first.deviceId);
    expect(await countDevices()).toBe(1);
  });
});

describe('POST /v1/devices/register: iOS key reuse', () => {
  it('refuses a key already registered to another device', async () => {
    attestation.set(() => iosKey('U2hhcmVk', 0));
    const owner = (await register(app, { platform: 'ios' })).json();
    const res = await register(app, { platform: 'ios', ip: '198.51.100.9' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_BODY);
    expect(await countDevices()).toBe(1);
    expect(logs.text()).toContain('ios_key_already_registered');

    // Also when the second device is a renewal of a different device.
    const other = await seedDevice(ctx, { platform: 'ios' });
    const renewal = await register(app, { platform: 'ios', token: other.token });
    expect(renewal.statusCode).toBe(403);
    expect((await deviceRow(other.device.id)).token_hash).toBe(deviceTokenHash(other.token));
    expect((await deviceRow(owner.deviceId)).ios_key_id).toBe('U2hhcmVk');
  });

  it('accepts the same device re-presenting its key without moving the counter back', async () => {
    attestation.set(() => iosKey('U2FtZQ==', 0));
    const first = (await register(app, { platform: 'ios' })).json();
    await ctx.db.updateTable('devices').set({ ios_counter: 12 }).where('id', '=', first.deviceId).execute();
    const res = await register(app, { platform: 'ios', token: first.deviceToken });
    expect(res.statusCode).toBe(201);
    expect(res.json().deviceId).toBe(first.deviceId);
    const row = await deviceRow(first.deviceId);
    expect(row.ios_key_id).toBe('U2FtZQ==');
    expect(Number(row.ios_counter)).toBe(12);
  });

  it('lets only one of two concurrent registrations claim one key', async () => {
    attestation.set(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return iosKey('UmFjZQ==', 0);
    });
    const results = await Promise.all([
      register(app, { platform: 'ios', ip: '198.51.100.1' }),
      register(app, { platform: 'ios', ip: '198.51.100.2' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
    expect(await countDevices()).toBe(1);
  });
});

describe('POST /v1/devices/register: registration limit', () => {
  it('allows the limit per IP per hour, then 429 with a real retry time, then recovers', async () => {
    await setup({ registrationsPerIpPerHour: 3 });
    const start = ctx.clock.now().getTime();
    expect((await register(app)).statusCode).toBe(201);
    ctx.clock.advance(10 * MINUTE);
    expect((await register(app)).statusCode).toBe(201);
    ctx.clock.advance(10 * MINUTE);
    expect((await register(app)).statusCode).toBe(201);
    ctx.clock.advance(10 * MINUTE);

    const nonce = await getNonce(app);
    const limited = await register(app, { nonce });
    expect(limited.statusCode).toBe(429);
    // The first registration leaves the window at start + 1 h; now is start + 30 min.
    expect(limited.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 30 * 60 },
    });
    expect(limited.headers['retry-after']).toBe('1800');
    expect(metrics.counters).toContainEqual({
      name: METRICS.rateLimited,
      labels: { rule: 'registrations_per_ip' },
    });
    expect(attestation.calls).toHaveLength(3);

    // Another address is not affected.
    expect((await register(app, { ip: '198.51.100.20' })).statusCode).toBe(201);

    // A renewal counts too.
    const seeded = await seedDevice(ctx);
    expect((await register(app, { token: seeded.token })).statusCode).toBe(429);

    ctx.clock.set(new Date(start + 60 * MINUTE - SECOND));
    const almost = await register(app, { nonce });
    expect(almost.statusCode).toBe(429);
    expect(almost.json().error.retryAfterSeconds).toBe(1);

    ctx.clock.advance(SECOND);
    const recovered = await register(app);
    expect(recovered.statusCode).toBe(201);
    expect((await register(app)).statusCode).toBe(429);
  });

  it('does not spend the nonce on a 429', async () => {
    await setup({ registrationsPerIpPerHour: 1 });
    expect((await register(app)).statusCode).toBe(201);
    const nonce = await getNonce(app);
    expect((await register(app, { nonce })).statusCode).toBe(429);
    await setup({ registrationsPerIpPerHour: 0 });
    expect((await register(app, { nonce })).statusCode).toBe(201);
  });

  it('is disabled by a limit of 0', async () => {
    await setup({ registrationsPerIpPerHour: 0 });
    for (let i = 0; i < 15; i++) expect((await register(app)).statusCode).toBe(201);
  });

  it('holds under concurrent registrations from one address', async () => {
    await setup({ registrationsPerIpPerHour: 2 });
    attestation.set(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return accept();
    });
    const nonces = await Promise.all(Array.from({ length: 5 }, () => getNonce(app)));
    const results = await Promise.all(nonces.map((nonce) => register(app, { nonce })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(3);
  });
});

describe('POST /v1/devices/register: request validation', () => {
  const cases: [string, (nonce: string) => Record<string, unknown>][] = [
    [
      'an unknown top-level field',
      (nonce) => ({ platform: 'android', nonce, attestation: ANDROID_ATTESTATION, x: 1 }),
    ],
    [
      'an unknown attestation field',
      (nonce) => ({ platform: 'android', nonce, attestation: { ...ANDROID_ATTESTATION, extra: 'x' } }),
    ],
    ['iOS fields on Android', (nonce) => ({ platform: 'android', nonce, attestation: IOS_ATTESTATION })],
    ['Android fields on iOS', (nonce) => ({ platform: 'ios', nonce, attestation: ANDROID_ATTESTATION })],
    [
      'an incomplete iOS attestation',
      (nonce) => ({ platform: 'ios', nonce, attestation: { keyId: 'a2V5' } }),
    ],
    ['an unknown platform', (nonce) => ({ platform: 'web', nonce })],
    ['a missing nonce', () => ({ platform: 'android', attestation: ANDROID_ATTESTATION })],
    ['a malformed nonce', () => ({ platform: 'android', nonce: 'short', attestation: ANDROID_ATTESTATION })],
    [
      'a number for a string',
      (nonce) => ({ platform: 'android', nonce, attestation: { integrityToken: 5 } }),
    ],
  ];

  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 and leaves the nonce unused`, async () => {
      const nonce = await getNonce(app);
      const res = await register(app, { body: body(nonce) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: { code: 'invalid_request', message: 'The request is not valid.' },
      });
      expect(attestation.calls).toHaveLength(0);
      expect((await register(app, { nonce })).statusCode).toBe(201);
    });
  }

  it('rejects malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"platform":',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an attestationObject larger than the app-wide 16 KiB body limit', async () => {
    attestation.set(() => iosKey('QmlnS2V5', 0));
    const nonce = await getNonce(app);
    const res = await register(app, {
      body: {
        platform: 'ios',
        nonce,
        attestation: { keyId: 'QmlnS2V5', attestationObject: 'A'.repeat(40_000) },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('logging and OpenAPI', () => {
  it('never logs the device token, the nonce or the attestation payload', async () => {
    const nonce1 = await getNonce(app);
    const first = (await register(app, { nonce: nonce1 })).json();
    const nonce2 = await getNonce(app);
    const second = (await register(app, { nonce: nonce2, token: first.deviceToken })).json();
    attestation.set(() => refuse());
    const nonce3 = await getNonce(app);
    await register(app, { nonce: nonce3, token: second.deviceToken });
    await register(app, { nonce: nonce3 });

    const text = logs.text();
    expect(text).toContain('device_registered');
    expect(text).toContain('device_renewed');
    for (const secret of [
      first.deviceToken,
      second.deviceToken,
      nonce1,
      nonce2,
      nonce3,
      ANDROID_ATTESTATION.integrityToken,
      deviceTokenHash(first.deviceToken),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('documents both routes in the OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.paths['/v1/devices/nonce'].get.operationId).toBe('getDeviceNonce');
    const post = doc.paths['/v1/devices/register'].post;
    expect(post.operationId).toBe('registerDevice');
    expect(Object.keys(post.responses).sort()).toEqual(['201', '400', '403', '429']);
  });
});
