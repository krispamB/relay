import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('hashPassword / verifyPassword', () => {
  it('produces an Argon2id PHC string with the library defaults (19 MiB, 2 passes, 1 lane)', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('salts: the same password hashes differently each time, and both verify', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same password')).toBe(true);
    expect(await verifyPassword(b, 'same password')).toBe(true);
  });

  it('hashes the password exactly as given (no trimming, Unicode kept)', async () => {
    const hash = await hashPassword('  pässwörd 🔑  ');
    expect(await verifyPassword(hash, '  pässwörd 🔑  ')).toBe(true);
    expect(await verifyPassword(hash, 'pässwörd 🔑')).toBe(false);
  });

  it('a stored value that is not a valid hash verifies as false instead of throwing', async () => {
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('$argon2id$stub', 'x')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });
});
