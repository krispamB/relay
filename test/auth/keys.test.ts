import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveAuthKeys, signinEmailHash } from '../../src/auth/keys.js';

const SECRET = 'auth-token-secret-for-tests-0123456789ab';
const NAMES = ['access', 'refresh', 'signupBody', 'signinEmail'] as const;

describe('deriveAuthKeys', () => {
  it('derives four 32-byte keys', () => {
    const keys = deriveAuthKeys(SECRET);
    for (const name of NAMES) {
      expect(Buffer.isBuffer(keys[name])).toBe(true);
      expect(keys[name].length).toBe(32);
    }
  });

  it('gives each purpose its own key', () => {
    const keys = deriveAuthKeys(SECRET);
    const bufs = NAMES.map((name) => keys[name]);
    for (let i = 0; i < bufs.length; i++) {
      for (let j = i + 1; j < bufs.length; j++) expect(bufs[i]!.equals(bufs[j]!)).toBe(false);
    }
  });

  it('never uses the secret itself as a key', () => {
    const keys = deriveAuthKeys(SECRET);
    const raw = Buffer.from(SECRET).subarray(0, 32);
    for (const name of NAMES) expect(keys[name].equals(raw)).toBe(false);
  });

  it('is deterministic for one secret and differs between secrets', () => {
    const a = deriveAuthKeys(SECRET);
    const b = deriveAuthKeys(SECRET);
    const c = deriveAuthKeys(`${SECRET}x`);
    for (const name of NAMES) {
      expect(a[name].equals(b[name])).toBe(true);
      expect(a[name].equals(c[name])).toBe(false);
    }
  });

  it('hashes a sign-in email with the signinEmail key and a distinct prefix', () => {
    const keys = deriveAuthKeys(SECRET);
    const email = 'ada@example.com';
    const hash = signinEmailHash(keys.signinEmail, email);
    const expected = createHmac('sha256', keys.signinEmail).update(`signin-email:${email}`).digest('hex');
    const underAnotherKey = createHmac('sha256', keys.signupBody)
      .update(`signin-email:${email}`)
      .digest('hex');
    expect(hash).toBe(expected);
    expect(hash).not.toBe(underAnotherKey);
    expect(hash).not.toContain('ada@');
  });

  it('refuses an empty secret', () => {
    expect(() => deriveAuthKeys('')).toThrow();
  });
});
