import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../crypto.js';

/** The claims of an access token. Times are whole seconds; see signAccessToken. */
export interface AccessClaims {
  /** User id. */
  sub: string;
  /** Token family id. */
  fam: string;
  /** Id of the refresh-token row issued with this access token. */
  jti: string;
  iat: Date;
  exp: Date;
}

export type AccessTokenCheck =
  | { kind: 'valid'; claims: AccessClaims }
  /** Good signature and well-formed, but `now` is at or past `exp`. */
  | { kind: 'expired'; claims: AccessClaims }
  | { kind: 'invalid' };

/** The only header this relay issues or accepts, byte for byte. */
const HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Longer than any token we sign; refuses huge input before doing any work. */
const MAX_TOKEN_LENGTH = 4096;
const INVALID: AccessTokenCheck = { kind: 'invalid' };

function seconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function hmac(key: Buffer, input: string): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

/**
 * A compact HS256 JWT. Deterministic: the header is fixed, the payload keys are always in the same
 * order, iat and exp are truncated to integer seconds, and there are no random claims. So the same
 * claims and key always give the same bytes, which is what lets a grace-window replay re-sign the
 * token it already issued.
 */
export function signAccessToken(key: Buffer, claims: AccessClaims): string {
  const payload = JSON.stringify({
    sub: claims.sub,
    fam: claims.fam,
    jti: claims.jti,
    iat: seconds(claims.iat),
    exp: seconds(claims.exp),
  });
  const input = `${HEADER}.${Buffer.from(payload).toString('base64url')}`;
  return `${input}.${hmac(key, input).toString('base64url')}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function isEpochSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function parseClaims(segment: string): AccessClaims | undefined {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { sub, fam, jti, iat, exp } = body as Record<string, unknown>;
  if (!isNonEmptyString(sub) || !isNonEmptyString(fam) || !isNonEmptyString(jti)) return undefined;
  if (!isEpochSeconds(iat) || !isEpochSeconds(exp) || exp < iat) return undefined;
  return { sub, fam, jti, iat: new Date(iat * 1000), exp: new Date(exp * 1000) };
}

/**
 * Checks an access token. Never throws. `invalid` covers anything not signed by `key` with exactly
 * our header (so `alg: none`, other algorithms and other `typ` values are refused before the
 * signature is even computed), bad encoding, bad JSON, and missing or ill-typed claims. `expired`
 * is only answered for a token whose signature is good.
 */
export function verifyAccessToken(key: Buffer, token: string, now: Date): AccessTokenCheck {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return INVALID;
    const parts = token.split('.');
    if (parts.length !== 3) return INVALID;
    const [header, payload, signature] = parts as [string, string, string];
    if (header !== HEADER) return INVALID;
    if (!SEGMENT.test(payload) || !SEGMENT.test(signature)) return INVALID;

    // Buffer's base64url decoder is lenient; insist on the one canonical spelling of the MAC.
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== 32 || given.toString('base64url') !== signature) return INVALID;
    const expected = hmac(key, `${header}.${payload}`);
    if (!timingSafeEqual(given, expected)) return INVALID;

    const claims = parseClaims(payload);
    if (!claims) return INVALID;
    return now.getTime() >= claims.exp.getTime() ? { kind: 'expired', claims } : { kind: 'valid', claims };
  } catch {
    return INVALID;
  }
}

const REFRESH_PREFIX = 'rt_';
const REFRESH_TOKEN = /^rt_[A-Za-z0-9_-]{43}$/;

/** A refresh token for a new family: `rt_` and 32 random bytes in base64url. */
export function newRefreshToken(): string {
  return `${REFRESH_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * The token a rotation of `parent` issues: `rt_` and HMAC-SHA256(key, parent). Deterministic, so a
 * grace-window replay of the parent finds the child again without the child being stored readably.
 */
export function deriveChildRefreshToken(key: Buffer, parent: string): string {
  return `${REFRESH_PREFIX}${hmac(key, parent).toString('base64url')}`;
}

/** Whether a string has the shape of a refresh token we issue. Cheap check before any lookup. */
export function isWellFormedRefreshToken(token: string): boolean {
  return typeof token === 'string' && REFRESH_TOKEN.test(token);
}

/** Refresh tokens are stored only as this hash. The prefix keeps it apart from device-token hashes. */
export function refreshTokenHash(token: string): string {
  return sha256Hex(`refresh:${token}`);
}
