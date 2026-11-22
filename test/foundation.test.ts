import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp, WindowLimiter } from '../src/app.js';
import { DAY } from '../src/clock.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { bindingHash, safeEqual, statusTokenFor } from '../src/crypto.js';
import { isUniqueViolation } from '../src/db/index.js';
import { newReceiptId, newReference, RECEIPT_ID_PATTERN, REFERENCE_ALPHABET } from '../src/ids.js';
import { parseIntakes } from '../src/intakes.js';
import { getState, pauseDelivery, recordCheck, resumeDelivery, unavailableReason } from '../src/state.js';
import { closeTestDb, createTestContext, markHealthy, resetDb } from './helpers/context.js';

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  RESGRID_API_BASE: 'https://core.example.org/',
  RESGRID_API_KEY: `rgk_AbCdEfGh_${'s'.repeat(43)}`,
  RESGRID_API_KEY_EXPIRES_ON: '2028-01-01',
  RESGRID_CALL_TYPE_NAME: 'Public SOS',
  RESGRID_PRIORITY_ID: '3',
  INTAKES_FILE: './intakes.json',
  ATTESTATION_MODE: 'permissive',
  STATUS_TOKEN_SECRET: 'a'.repeat(32),
  PHONE_HASH_SECRET: 'b'.repeat(32),
  ADMIN_TOKEN: 'c'.repeat(32),
  AUTH_TOKEN_SECRET: 'd'.repeat(32),
};

describe('config', () => {
  it('loads a valid environment with defaults', () => {
    const c = loadConfig(baseEnv);
    expect(c.resgrid.apiBase).toBe('https://core.example.org');
    expect(c.limits.sosPerUserPer24h).toBe(3);
    expect(c.sosNatureText).toBe('SOS – caller recording to follow');
    expect(c.host).toBe('::');
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({ ...baseEnv, RESGRID_API_KEY: 'nope', ADMIN_TOKEN: 'short', RESGRID_PRIORITY_ID: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems.length).toBe(3);
    }
  });

  it('refuses permissive mode in production without the override', () => {
    const prod = { ...baseEnv, NODE_ENV: 'production', CLIENT_IP_HEADER: 'x-real-ip' };
    expect(() => loadConfig(prod)).toThrow(/permissive/);
    expect(() => loadConfig({ ...prod, ALLOW_PERMISSIVE_IN_PRODUCTION: 'true' })).not.toThrow();
  });

  it('needs the client IP header in production, so callers never share one rate limit', () => {
    const prod = { ...baseEnv, NODE_ENV: 'production', ALLOW_PERMISSIVE_IN_PRODUCTION: 'true' };
    expect(() => loadConfig(prod)).toThrow(/CLIENT_IP_HEADER/);
    expect(() => loadConfig({ ...prod, CLIENT_IP_HEADER: 'X-Real-IP' })).not.toThrow();
    expect(() => loadConfig({ ...prod, ALLOW_SOCKET_IP_IN_PRODUCTION: 'true' })).not.toThrow();
  });

  it('always needs the auth token secret, of at least 32 bytes', () => {
    const { AUTH_TOKEN_SECRET: _omit, ...without } = baseEnv;
    expect(() => loadConfig(without)).toThrow(/AUTH_TOKEN_SECRET is required/);
    expect(() => loadConfig({ ...baseEnv, AUTH_TOKEN_SECRET: 'x'.repeat(31) })).toThrow(
      /AUTH_TOKEN_SECRET must be at least 32 bytes/,
    );
    expect(loadConfig(baseEnv).auth).toEqual({ tokenSecret: 'd'.repeat(32) });
  });

  it('has no AUTH_ENABLED switch any more: the value is ignored', () => {
    expect(loadConfig({ ...baseEnv, AUTH_ENABLED: 'false' }).auth).toEqual({ tokenSecret: 'd'.repeat(32) });
  });

  it('reads the per-user SOS limit and the SOS nature text', () => {
    const c = loadConfig({
      ...baseEnv,
      LIMIT_SOS_PER_USER_PER_24H: '5',
      SOS_NATURE_TEXT: '  SOS – listen to the recording  ',
    });
    expect(c.limits.sosPerUserPer24h).toBe(5);
    expect(c.sosNatureText).toBe('SOS – listen to the recording');
    expect(() => loadConfig({ ...baseEnv, SOS_NATURE_TEXT: 'x'.repeat(201) })).toThrow(/SOS_NATURE_TEXT/);
    expect(() => loadConfig({ ...baseEnv, SOS_NATURE_TEXT: 'SOS\u0007' })).toThrow(/SOS_NATURE_TEXT/);
  });

  it('needs platform settings in enforce mode', () => {
    expect(() => loadConfig({ ...baseEnv, ATTESTATION_MODE: 'enforce' })).toThrow(/enforce/);
    expect(() =>
      loadConfig({ ...baseEnv, ATTESTATION_MODE: 'enforce', IOS_TEAM_ID: 'T', IOS_BUNDLE_ID: 'b' }),
    ).not.toThrow();
  });
});

describe('intakes', () => {
  const ok = {
    code: 'DEPT-01',
    displayName: 'D',
    emergencyPhone: '112',
    natures: [{ id: 'fire', label: 'Fire' }],
  };
  it('parses and defaults enabled/demo', () => {
    const i = parseIntakes([ok]).get('DEPT-01');
    expect(i).toMatchObject({ enabled: true, demo: false });
  });
  it('rejects requireVerifiedPhone and a second real intake', () => {
    expect(() => parseIntakes([{ ...ok, requireVerifiedPhone: true }])).toThrow(/requireVerifiedPhone/);
    expect(() => parseIntakes([ok, { ...ok, code: 'DEPT-02' }])).toThrow(/one real/);
  });
});

describe('ids and crypto', () => {
  it('makes receipt ids and references in the documented shape', () => {
    expect(newReceiptId(Date.now())).toMatch(new RegExp(RECEIPT_ID_PATTERN));
    const ref = newReference();
    expect(ref).toMatch(/^SOS-.{4}$/);
    for (const ch of ref.slice(4)) expect(REFERENCE_ALPHABET).toContain(ch);
    expect(REFERENCE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it('derives a stable status token and compares safely', () => {
    const t = statusTokenFor('secret', 'sos_1');
    expect(statusTokenFor('secret', 'sos_1')).toBe(t);
    expect(statusTokenFor('secret', 'sos_2')).not.toBe(t);
    expect(safeEqual(t, t)).toBe(true);
    expect(safeEqual(t, `${t}x`)).toBe(false);
  });
  it('binds the hash to key and exact body bytes', () => {
    const a = bindingHash('k', Buffer.from('{"a":1}'));
    expect(a.length).toBe(32);
    expect(bindingHash('k', Buffer.from('{"a": 1}')).equals(a)).toBe(false);
    expect(bindingHash('k2', Buffer.from('{"a":1}')).equals(a)).toBe(false);
  });
});

describe('WindowLimiter', () => {
  it('allows max hits per window then reports the wait', () => {
    const l = new WindowLimiter(2, 60_000);
    expect(l.hit('a', 0)).toBe(0);
    expect(l.hit('a', 1000)).toBe(0);
    expect(l.hit('a', 2000)).toBe(58);
    expect(l.hit('b', 2000)).toBe(0);
    expect(l.hit('a', 60_000)).toBe(0);
  });
});

describe('database-backed foundation', () => {
  beforeEach(() => resetDb());
  afterAll(() => closeTestDb());

  it('tracks pause and availability', async () => {
    const ctx = createTestContext();
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBe('unverified');
    await markHealthy(ctx);
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBeUndefined();

    expect(await pauseDelivery(ctx.db, ctx.clock.now(), 'Core returned 401')).toBe(true);
    expect(await pauseDelivery(ctx.db, ctx.clock.now(), 'again')).toBe(false);
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBe('paused');
    await resumeDelivery(ctx.db);

    await recordCheck(ctx.db, ctx.clock.now(), {
      status: 'unhealthy',
      detail: 'what3words required',
      required: { location: true, address: false, name: false },
    });
    const s = await getState(ctx.db);
    expect(unavailableReason(s, ctx.clock.now())).toBe('unhealthy');
    expect(s.required_location).toBe(true);

    await recordCheck(ctx.db, ctx.clock.now(), {
      status: 'ok',
      required: { location: false, address: false, name: false },
    });
    ctx.clock.advance(DAY + 1);
    expect(unavailableReason(await getState(ctx.db), ctx.clock.now())).toBe('unverified');
  });

  it('enforces one open submission per user and one row per idempotency key', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await ctx.db
      .insertInto('users')
      .values({
        id: 'usr_1',
        full_name: 'Ade',
        phone: '+2348012345678',
        password_hash: '$argon2id$stub',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const row = (id: string, key: string, reference: string) => ({
      id,
      user_id: 'usr_1',
      idempotency_key: key,
      intake_code: 'TEST-DEPT',
      reference,
      status: 'queued' as const,
      nature_label: 'SOS – caller recording to follow',
      phone: '+2348012345678',
      phone_hash: 'ph',
      ip: '203.0.113.1',
      accepted_at: now,
      updated_at: now,
    });
    await ctx.db
      .insertInto('submissions')
      .values(row('sos_a', 'k1', 'SOS-AAAA'))
      .execute();
    const second = await ctx.db
      .insertInto('submissions')
      .values(row('sos_b', 'k2', 'SOS-BBBB'))
      .execute()
      .catch((e) => e);
    expect(isUniqueViolation(second, 'submissions_one_open_per_user_idx')).toBe(true);

    await ctx.db.updateTable('submissions').set({ status: 'closed' }).where('id', '=', 'sos_a').execute();
    await ctx.db
      .insertInto('submissions')
      .values(row('sos_b', 'k2', 'SOS-BBBB'))
      .execute();
    const dup = await ctx.db
      .insertInto('submissions')
      .values(row('sos_c', 'k1', 'SOS-CCCC'))
      .execute()
      .catch((e) => e);
    expect(isUniqueViolation(dup)).toBe(true);
  });

  it('serves health, the error shape and rejects bad JSON', async () => {
    const ctx = createTestContext();
    const app = await buildPublicApp(ctx);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const nf = await app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    const spec = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(spec.json().openapi).toMatch(/^3\./);
    await app.close();
  });
});
