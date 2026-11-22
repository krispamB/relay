/**
 * App → relay socket messages. Plan §5.2.
 * Shape and ranges only. Freshness (10 min, future, 0,0) stays in `src/sos/validate.ts`.
 */

export const CLOSE = {
  final: 1000,
  restart: 1012,
  unauthorized: 4001,
  revoked: 4003,
  notFound: 4004,
  idle: 4008,
  /** The user already has the maximum number of sockets open on this relay instance. */
  tooManySockets: 4029,
} as const;

/**
 * Codes of the non-fatal `{type:"error", code}` message. The socket stays open after each.
 * - `bad_message`: not JSON, not text, an unknown `type`, or the wrong fields for the type.
 * - `not_subscribed`: a `location` before any `subscribe`.
 * - `invalid_location`: 0,0, out of range, older than 10 minutes, or in the future.
 * - `rate_limited`: more than the per-socket message budget; the message was not acted on.
 * - `unavailable`: the relay could not reach its database; send the message again later.
 */
export type ServerErrorCode =
  | 'bad_message'
  | 'not_subscribed'
  | 'invalid_location'
  | 'rate_limited'
  | 'unavailable';

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; receiptId: string }
  | { type: 'location'; lat: number; lon: number; accuracyM?: number; capturedAt: string }
  | { type: 'ping' };

type ParsedClientMessage = { ok: true; message: ClientMessage } | { ok: false; code: 'bad_message' };

/** The largest message the relay reads. The socket's own frame limit is the same (a bigger one closes 1009). */
export const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_TOKEN_CHARS = 4096;
const MAX_RECEIPT_ID_CHARS = 64;

/** ISO-8601 / RFC 3339 date-time. A zone designator is required. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const BAD: ParsedClientMessage = { ok: false, code: 'bad_message' };

function bad(): ParsedClientMessage {
  return BAD;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(obj);
  if (present.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(obj, key));
}

function isRealCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  // `month` is 1-based, so day 0 of the next month index is the last day of this month.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME.test(value) &&
    isRealCalendarDate(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseLocation(obj: Record<string, unknown>): ParsedClientMessage {
  const hasAccuracy = Object.hasOwn(obj, 'accuracyM');
  const keys = hasAccuracy
    ? ['type', 'lat', 'lon', 'accuracyM', 'capturedAt']
    : ['type', 'lat', 'lon', 'capturedAt'];
  if (!exactKeys(obj, keys)) return bad();

  const lat = obj.lat;
  const lon = obj.lon;
  const capturedAt = obj.capturedAt;
  const accuracyM = obj.accuracyM;
  if (!inRange(lat, -90, 90) || !inRange(lon, -180, 180) || !isIsoDateTime(capturedAt)) return bad();
  if (hasAccuracy && !nonNegativeFinite(accuracyM)) return bad();

  const message: ClientMessage = { type: 'location', lat, lon, capturedAt };
  if (hasAccuracy && nonNegativeFinite(accuracyM)) message.accuracyM = accuracyM;
  return { ok: true, message };
}

export function parseClientMessage(raw: string): ParsedClientMessage {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return bad();

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return bad();
  }
  if (!isRecord(value) || typeof value.type !== 'string') return bad();

  switch (value.type) {
    case 'ping':
      return exactKeys(value, ['type']) ? { ok: true, message: { type: 'ping' } } : bad();
    case 'auth':
      if (!exactKeys(value, ['type', 'token']) || !boundedString(value.token, MAX_TOKEN_CHARS)) return bad();
      return { ok: true, message: { type: 'auth', token: value.token } };
    case 'subscribe':
      if (!exactKeys(value, ['type', 'receiptId']) || !boundedString(value.receiptId, MAX_RECEIPT_ID_CHARS)) {
        return bad();
      }
      return { ok: true, message: { type: 'subscribe', receiptId: value.receiptId } };
    case 'location':
      return parseLocation(value);
    default:
      return bad();
  }
}
