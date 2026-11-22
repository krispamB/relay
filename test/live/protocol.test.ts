import { describe, expect, it } from 'vitest';
import { CLOSE, parseClientMessage } from '../../src/live/protocol.js';

const location = {
  type: 'location',
  lat: 4.9247,
  lon: 6.2676,
  accuracyM: 12,
  capturedAt: '2026-11-22T09:14:05Z',
};

function raw(value: unknown): string {
  return JSON.stringify(value);
}

describe('CLOSE', () => {
  it('uses the socket close codes from the live plan', () => {
    expect(CLOSE).toEqual({
      final: 1000,
      restart: 1012,
      unauthorized: 4001,
      revoked: 4003,
      notFound: 4004,
      idle: 4008,
    });
  });
});

describe('parseClientMessage', () => {
  it('accepts auth, subscribe, location and ping', () => {
    expect(parseClientMessage(raw({ type: 'auth', token: 'tok' }))).toEqual({
      ok: true,
      message: { type: 'auth', token: 'tok' },
    });
    expect(parseClientMessage(raw({ type: 'subscribe', receiptId: 'sos_01J' }))).toEqual({
      ok: true,
      message: { type: 'subscribe', receiptId: 'sos_01J' },
    });
    expect(parseClientMessage(raw(location))).toEqual({ ok: true, message: location });
    const { accuracyM: _accuracy, ...withoutAccuracy } = location;
    expect(parseClientMessage(raw(withoutAccuracy))).toEqual({ ok: true, message: withoutAccuracy });
    expect(parseClientMessage(raw({ type: 'ping' }))).toEqual({ ok: true, message: { type: 'ping' } });
  });

  it('accepts the edges of the coordinate ranges, a zero accuracy, and an offset timestamp', () => {
    const message = {
      type: 'location',
      lat: -90,
      lon: 180,
      accuracyM: 0,
      capturedAt: '2026-11-22T09:14:05.123+01:00',
    };
    expect(parseClientMessage(raw(message))).toEqual({ ok: true, message });
    expect(
      parseClientMessage(raw({ type: 'location', lat: 90, lon: -180, capturedAt: '2026-11-22T09:14:05Z' })),
    ).toEqual({
      ok: true,
      message: { type: 'location', lat: 90, lon: -180, capturedAt: '2026-11-22T09:14:05Z' },
    });
  });

  it('does not apply SOS freshness rules', () => {
    const staleOrigin = { type: 'location', lat: 0, lon: 0, capturedAt: '2020-01-01T00:00:00Z' };
    expect(parseClientMessage(raw(staleOrigin))).toEqual({ ok: true, message: staleOrigin });
  });

  it('rejects non-JSON, non-objects, unknown types, bad fields and extra fields', () => {
    const bad = { ok: false, code: 'bad_message' };
    expect(parseClientMessage('not json')).toEqual(bad);
    expect(parseClientMessage('null')).toEqual(bad);
    expect(parseClientMessage('[]')).toEqual(bad);
    expect(parseClientMessage('42')).toEqual(bad);
    expect(parseClientMessage('"ping"')).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'pong' }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'ping', extra: true }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'auth' }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'auth', token: 1 }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'subscribe', receiptId: 1 }))).toEqual(bad);
    expect(
      parseClientMessage(raw({ type: 'location', lat: '4', lon: 6, capturedAt: '2026-11-22T09:14:05Z' })),
    ).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, note: 'x' }))).toEqual(bad);
  });

  it('rejects coordinates outside range, non-finite numbers and a negative accuracy', () => {
    const bad = { ok: false, code: 'bad_message' };
    expect(parseClientMessage(raw({ ...location, lat: 90.0001 }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, lat: -90.0001 }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, lon: 180.0001 }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, lon: -180.0001 }))).toEqual(bad);
    expect(
      parseClientMessage('{"type":"location","lat":1e309,"lon":0,"capturedAt":"2026-11-22T09:14:05Z"}'),
    ).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, accuracyM: -0.1 }))).toEqual(bad);
  });

  it('rejects a capturedAt that is not an ISO-8601 date-time', () => {
    const bad = { ok: false, code: 'bad_message' };
    expect(parseClientMessage(raw({ ...location, capturedAt: '2026-11-22' }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, capturedAt: '2026-11-22T09:14:05' }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, capturedAt: 'yesterday' }))).toEqual(bad);
    expect(parseClientMessage(raw({ ...location, capturedAt: '2026-02-31T00:00:00Z' }))).toEqual(bad);
  });

  it('rejects an empty or over-long token or receipt id', () => {
    const bad = { ok: false, code: 'bad_message' };
    expect(parseClientMessage(raw({ type: 'auth', token: '' }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'auth', token: 'a'.repeat(4096) })).ok).toBe(true);
    expect(parseClientMessage(raw({ type: 'auth', token: 'a'.repeat(4097) }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'subscribe', receiptId: '' }))).toEqual(bad);
    expect(parseClientMessage(raw({ type: 'subscribe', receiptId: 'r'.repeat(64) })).ok).toBe(true);
    expect(parseClientMessage(raw({ type: 'subscribe', receiptId: 'r'.repeat(65) }))).toEqual(bad);
  });

  it('rejects raw input over 8 KB', () => {
    const ping = '{"type":"ping"}';
    const atLimit = `${' '.repeat(8192 - ping.length)}${ping}`;
    expect(Buffer.byteLength(atLimit)).toBe(8192);
    expect(parseClientMessage(atLimit)).toEqual({ ok: true, message: { type: 'ping' } });
    expect(parseClientMessage(` ${atLimit}`)).toEqual({ ok: false, code: 'bad_message' });
  });
});
