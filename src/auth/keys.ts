import { createHmac, hkdfSync } from 'node:crypto';

/**
 * The keys derived from AUTH_TOKEN_SECRET. Each is used for one purpose only.
 * `signinPhone` is a fourth key, not `PHONE_HASH_SECRET`: sign-in attempt rows are an auth rate
 * limit, so they must not be keyed by the SOS phone-hash secret, and a distinct HKDF label means
 * this key says nothing about the other three.
 */
export interface AuthKeys {
  /** Signs and verifies access tokens (HS256). */
  access: Buffer;
  /** Derives a rotated refresh token from its parent (HMAC-SHA256). */
  refresh: Buffer;
  /** Keyed hash of a sign-up request body, for idempotent replays. */
  signupBody: Buffer;
  /** HMAC key for the per-phone sign-in rate limit. The number itself is never stored. */
  signinPhone: Buffer;
}

const SALT = 'sos-relay/auth/v1';
const KEY_BYTES = 32;

function derive(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, SALT, info, KEY_BYTES));
}

/**
 * HKDF-SHA256 over AUTH_TOKEN_SECRET with a distinct `info` label per key, so a key leaked or misused
 * in one role says nothing about the others. The length of the secret is checked by the config.
 */
export function deriveAuthKeys(secret: string): AuthKeys {
  if (secret === '') throw new Error('AUTH_TOKEN_SECRET is empty');
  return {
    access: derive(secret, 'access-token-signing'),
    refresh: derive(secret, 'refresh-token-derivation'),
    signupBody: derive(secret, 'signup-body-hashing'),
    signinPhone: derive(secret, 'signin-phone-hash'),
  };
}

/**
 * Hex HMAC of a phone number (as sent, trimmed) for `signin_attempts.phone_hash`. The `signin-phone:`
 * prefix keeps this input distinct from any other use of the key.
 */
export function signinPhoneHash(key: Buffer, phone: string): string {
  return createHmac('sha256', key).update(`signin-phone:${phone}`).digest('hex');
}
