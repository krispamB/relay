import { describe, expect, it } from 'vitest';
import { deriveAuthKeys } from '../../src/auth/keys.js';

const SECRET = 'auth-token-secret-for-tests-0123456789ab';

describe('deriveAuthKeys', () => {
  it('derives three 32-byte keys', () => {
    const keys = deriveAuthKeys(SECRET);
    for (const key of [keys.access, keys.refresh, keys.signupBody]) {
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    }
  });

  it('gives each purpose its own key', () => {
    const { access, refresh, signupBody } = deriveAuthKeys(SECRET);
    expect(access.equals(refresh)).toBe(false);
    expect(access.equals(signupBody)).toBe(false);
    expect(refresh.equals(signupBody)).toBe(false);
  });

  it('never uses the secret itself as a key', () => {
    const keys = deriveAuthKeys(SECRET);
    const raw = Buffer.from(SECRET).subarray(0, 32);
    for (const key of [keys.access, keys.refresh, keys.signupBody]) expect(key.equals(raw)).toBe(false);
  });

  it('is deterministic for one secret and differs between secrets', () => {
    const a = deriveAuthKeys(SECRET);
    const b = deriveAuthKeys(SECRET);
    const c = deriveAuthKeys(`${SECRET}x`);
    expect(a.access.equals(b.access)).toBe(true);
    expect(a.refresh.equals(b.refresh)).toBe(true);
    expect(a.signupBody.equals(b.signupBody)).toBe(true);
    expect(a.access.equals(c.access)).toBe(false);
    expect(a.refresh.equals(c.refresh)).toBe(false);
    expect(a.signupBody.equals(c.signupBody)).toBe(false);
  });

  it('refuses an empty secret', () => {
    expect(() => deriveAuthKeys('')).toThrow();
  });
});
