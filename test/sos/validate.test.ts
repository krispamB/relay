import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE, SECOND } from '../../src/clock.js';
import { DEFAULT_LIMITS } from '../../src/config.js';
import { ApiError } from '../../src/errors.js';
import { inlineTimeoutMs } from '../../src/sos/budget.js';
import { sosRules } from '../../src/sos/limits.js';
import { isoSeconds } from '../../src/sos/receipt.js';
import {
  locationIsFresh,
  parsePhoneE164,
  sanitizeText,
  textLength,
  validateContent,
  validateStatic,
} from '../../src/sos/validate.js';
import { getSubmission, ok, scriptedCore } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, testIntakes } from '../helpers/context.js';
import { ADDRESS, device, type Harness, harness, isoAgo, LAT, LON, PHONE, postSos } from './helpers.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.statusCode === 400 ? err.code : `HTTP ${err.statusCode}`;
    throw err;
  }
  return undefined;
}

const base = {
  intakeCode: 'TEST-DEPT',
  nature: 'fire',
  phone: PHONE,
  location: { lat: LAT, lon: LON, accuracyM: 10, capturedAt: ago(5000), source: 'gps' as const },
};

describe('sanitising (unit)', () => {
  it('strips control characters, collapses whitespace and trims, without HTML escaping', () => {
    expect(sanitizeText('  Ade\u0000\u0007 \t\n\r  Okafor\u007f\u009b  ')).toBe('Ade Okafor');
    expect(sanitizeText('a  b')).toBe('a b');
    expect(sanitizeText('<b>Fire & smoke</b>')).toBe('<b>Fire & smoke</b>');
    expect(sanitizeText('line1\nline2')).toBe('line1 line2');
  });

  it('counts code points, so an emoji counts once', () => {
    expect(textLength('🔥🔥')).toBe(2);
  });
});

describe('phone (unit)', () => {
  it('accepts a valid E.164 number and returns it in E.164', () => {
    expect(parsePhoneE164(PHONE)).toBe(PHONE);
    expect(parsePhoneE164('+14155552671')).toBe('+14155552671');
  });
  it.each(['08012345678', '+1234', '+23480123', '+999123456789', '+234 801 234 5678', ''])(
    'rejects %j',
    (p) => {
      expect(parsePhoneE164(p)).toBeUndefined();
    },
  );
});

describe('validateStatic (unit)', () => {
  it('rejects an invalid phone', () => {
    expect(codeOf(() => validateStatic({ ...base, phone: '+23480123' }))).toBe('phone_invalid');
  });

  it.each([
    ['lat over 90', { lat: 90.1, lon: 3 }],
    ['lat under -90', { lat: -91, lon: 3 }],
    ['lon over 180', { lat: 6, lon: 180.5 }],
    ['lon under -180', { lat: 6, lon: -181 }],
    ['0,0', { lat: 0, lon: 0 }],
  ])('a location with %s is a 400 without an address and dropped with one', (_n, coords) => {
    const loc = { ...base.location, ...coords };
    expect(codeOf(() => validateStatic({ ...base, location: loc }))).toBe('location_invalid');
    const v = validateStatic({ ...base, location: loc, address: ADDRESS });
    expect(v.location).toBeNull();
    expect(v.address).toBe(ADDRESS);
  });

  it('keeps lat 0 or lon 0 alone (only 0,0 is refused)', () => {
    expect(validateStatic({ ...base, location: { ...base.location, lat: 0, lon: 3 } }).location?.lat).toBe(0);
  });

  it('requires an address when there is no location, and an all-whitespace address counts as none', () => {
    const { location: _l, ...noLoc } = base;
    expect(codeOf(() => validateStatic(noLoc))).toBe('address_required');
    expect(codeOf(() => validateStatic({ ...noLoc, address: ' \t\u0000 ' }))).toBe('address_required');
    expect(validateStatic({ ...noLoc, address: ' x ' }).address).toBe('x');
  });

  it('applies length limits after sanitising', () => {
    const { location: _l, ...noLoc } = base;
    // 500 characters once the runs of spaces are collapsed.
    const padded = `${'a '.repeat(249)}a${'   '.repeat(100)}`;
    expect(sanitizeText(padded).length).toBe(499);
    expect(validateStatic({ ...noLoc, address: padded }).address).toHaveLength(499);
    expect(validateStatic({ ...noLoc, address: 'a'.repeat(500) }).address).toHaveLength(500);
    expect(codeOf(() => validateStatic({ ...noLoc, address: 'a'.repeat(501) }))).toBe('address_too_long');
    expect(codeOf(() => validateStatic({ ...base, name: 'n'.repeat(101) }))).toBe('name_too_long');
    expect(validateStatic({ ...base, name: ` ${'n'.repeat(100)} ` }).name).toHaveLength(100);
    expect(codeOf(() => validateStatic({ ...base, details: 'd'.repeat(1001) }))).toBe('details_too_long');
    expect(validateStatic({ ...base, details: '🔥'.repeat(1000) }).details).toBe('🔥'.repeat(1000));
  });

  it('drops an impossible accuracy on its own', () => {
    expect(
      validateStatic({ ...base, location: { ...base.location, accuracyM: -1 } }).location?.accuracyM,
    ).toBeNull();
  });
});

describe('validateContent (unit)', () => {
  const intake = testIntakes().get('TEST-DEPT')!;
  const policy = { requiredLocation: false };

  it('requires a nature of the intake and returns its label', () => {
    expect(validateContent(validateStatic(base), intake, NOW, policy).natureLabel).toBe('Fire');
    expect(
      codeOf(() => validateContent(validateStatic({ ...base, nature: 'flood' }), intake, NOW, policy)),
    ).toBe('nature_invalid');
  });

  it.each([
    ['older than 10 minutes', ago(10 * MINUTE + 1000)],
    ['in the future', ago(-5 * MINUTE)],
    ['beyond the skew allowance', ago(-31 * SECOND)],
  ])('a fix %s is a 400 without an address and dropped with one', (_n, capturedAt) => {
    const loc = { ...base.location, capturedAt };
    expect(
      codeOf(() => validateContent(validateStatic({ ...base, location: loc }), intake, NOW, policy)),
    ).toBe('location_invalid');
    const v = validateContent(
      validateStatic({ ...base, location: loc, address: ADDRESS }),
      intake,
      NOW,
      policy,
    );
    expect(v.location).toBeNull();
  });

  it('accepts a fix exactly 10 minutes old and one a few seconds ahead (clock skew)', () => {
    expect(locationIsFresh(new Date(ago(10 * MINUTE)), NOW)).toBe(true);
    expect(locationIsFresh(new Date(ago(-10 * SECOND)), NOW)).toBe(true);
  });

  it('with required_location, an SOS with no usable location is a 400 even with an address', () => {
    const req = { requiredLocation: true };
    const { location: _l, ...noLoc } = base;
    expect(
      codeOf(() => validateContent(validateStatic({ ...noLoc, address: ADDRESS }), intake, NOW, req)),
    ).toBe('location_required');
    const stale = { ...base, address: ADDRESS, location: { ...base.location, capturedAt: ago(20 * MINUTE) } };
    expect(codeOf(() => validateContent(validateStatic(stale), intake, NOW, req))).toBe('location_required');
    expect(validateContent(validateStatic(base), intake, NOW, req).location).not.toBeNull();
  });
});

describe('budget and limits (unit)', () => {
  it('gives the inline attempt what is left of 7.5 s, at most 6 s, and nothing when almost nothing is left', () => {
    expect(inlineTimeoutMs(0)).toBe(6000);
    expect(inlineTimeoutMs(1000)).toBe(6000);
    expect(inlineTimeoutMs(3000)).toBe(4200);
    expect(inlineTimeoutMs(6800)).toBeUndefined();
    expect(inlineTimeoutMs(9000)).toBeUndefined();
  });

  it('checks per-caller limits before the breaker', () => {
    const rules = sosRules(
      { deviceId: 'd', phoneHash: 'p', ip: 'i', intakeCode: 'c', demo: false },
      DEFAULT_LIMITS,
    );
    expect(rules.map((r) => [r.rule, r.max, r.windowMs])).toEqual([
      ['sos_per_device', 3, 86_400_000],
      ['sos_per_phone', 3, 86_400_000],
      ['sos_per_ip', 10, 3_600_000],
      ['intake_breaker', 30, 600_000],
    ]);
  });

  it('formats submittedAt to the second', () => {
    expect(isoSeconds(new Date('2026-11-17T14:03:22.456Z'))).toBe('2026-11-17T14:03:22Z');
  });
});

describe('validation through the API (PRD §7.4)', () => {
  let h: Harness | undefined;
  beforeEach(() => resetDb());
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });
  afterAll(() => closeTestDb());

  async function send(overrides: Record<string, unknown>, opts: Parameters<typeof postSos>[1] = {}) {
    h ??= await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    return d.send(overrides, opts);
  }

  it('stores sanitised text and the nature label', async () => {
    const res = await send({
      name: '  Ade\u0000\n  Okafor ',
      details: 'Smoke\t\tand   fire\u0007',
      address: ' 12\u001b Marina   Rd ',
    });
    expect(res.status).toBe(201);
    const row = await getSubmission(h!.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({
      name: 'Ade Okafor',
      details: 'Smoke and fire',
      address: '12 Marina Rd',
      nature_label: 'Fire',
    });
  });

  it.each([
    ['an unknown top-level field', { extra: 1 }],
    [
      'an unknown location field',
      { location: { lat: LAT, lon: LON, capturedAt: '2026-11-17T11:59:00Z', source: 'gps', alt: 3 } },
    ],
    [
      'a location source outside the list',
      { location: { lat: LAT, lon: LON, capturedAt: '2026-11-17T11:59:00Z', source: 'wifi' } },
    ],
    ['a missing phone', { phone: undefined }],
    ['a phone not in E.164', { phone: '08012345678' }],
    ['a number that is not valid', { phone: '+23480123' }],
    ['a wrong type', { name: 5 }],
    ['a null field', { details: null }],
    ['a malformed capturedAt', { location: { lat: LAT, lon: LON, capturedAt: 'yesterday', source: 'gps' } }],
    ['a nature not in the intake', { nature: 'flood' }],
    ['no location and no address', { location: undefined }],
    ['a name over 100 characters', { name: 'n'.repeat(101) }],
  ])('400 for %s', async (_n, overrides) => {
    const res = await send(overrides);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toEqual(expect.any(String));
    expect(await h!.ctx.db.selectFrom('submissions').select('id').execute()).toEqual([]);
  });

  it.each([
    ['missing', null],
    ['not a UUID', 'retry-1'],
  ])('400 when the Idempotency-Key is %s', async (_n, key) => {
    expect((await send({}, { key })).status).toBe(400);
  });

  it('400 for an empty or non-JSON body', async () => {
    h = await harness();
    const d = await device(h);
    expect((await postSos(h.app, { token: d.token, payload: '' })).status).toBe(400);
    expect((await postSos(h.app, { token: d.token, payload: '{"intakeCode":' })).status).toBe(400);
  });

  it('a stale location is dropped when an address is given', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const res = await send({
      address: ADDRESS,
      location: { lat: LAT, lon: LON, capturedAt: isoAgo(h.ctx, 11 * MINUTE), source: 'gps' },
    });
    expect(res.status).toBe(201);
    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({ lat: null, lon: null, location_captured_at: null, address: ADDRESS });
  });

  it('a stale location without an address is a 400', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const res = await send({
      location: { lat: LAT, lon: LON, capturedAt: isoAgo(h.ctx, 11 * MINUTE), source: 'gps' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('location_invalid');
  });

  it('honours required_location from the field policy', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    await h.ctx.db.updateTable('relay_state').set({ required_location: true }).where('id', '=', 1).execute();
    const res = await send({ location: undefined, address: ADDRESS });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('location_required');
    expect((await send({}, { key: randomUUID() })).status).toBe(201);
  });
});
