import { hkdfSync } from 'node:crypto';

/** The three keys derived from AUTH_TOKEN_SECRET. Each is used for one purpose only. */
export interface AuthKeys {
  /** Signs and verifies access tokens (HS256). */
  access: Buffer;
  /** Derives a rotated refresh token from its parent (HMAC-SHA256). */
  refresh: Buffer;
  /** Keyed hash of a sign-up request body, for idempotent replays. */
  signupBody: Buffer;
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
  };
}
