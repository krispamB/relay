import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import {
  type AccessClaims,
  deriveChildRefreshToken,
  isWellFormedRefreshToken,
  newRefreshToken,
  refreshTokenHash,
  signAccessToken,
  verifyAccessToken,
} from '../../src/auth/tokens.js';

const keys = deriveAuthKeys('auth-token-secret-for-tests-0123456789ab');
const other = deriveAuthKeys('another-secret-for-tests-0123456789abcdef');

const iat = new Date('2026-11-18T12:00:00Z');
const exp = new Date('2026-11-18T12:15:00Z');
const claims: AccessClaims = { sub: 'user-1', fam: 'family-1', jti: 'token-1', iat, exp };

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const HEADER = b64('{"alg":"HS256","typ":"JWT"}');

/** Builds a token with any header and payload, correctly signed with `key`. */
function forge(header: string, payload: string, key: Buffer = keys.access): string {
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

function payload(over: Record<string, unknown> = {}): string {
  return b64(
    JSON.stringify({
      sub: 'user-1',
      fam: 'family-1',
      jti: 'token-1',
      iat: 1795003200,
      exp: 1795004100,
      ...over,
    }),
  );
}

describe('signAccessToken', () => {
  it('produces a compact HS256 JWT with the fixed header and integer-second claims', () => {
    const token = signAccessToken(keys.access, claims);
    const [h, p, s] = token.split('.');
    expect(Buffer.from(h!, 'base64url').toString()).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(Buffer.from(p!, 'base64url').toString()).toBe(
      `{"sub":"user-1","fam":"family-1","jti":"token-1","iat":${iat.getTime() / 1000},"exp":${exp.getTime() / 1000}}`,
    );
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is byte-identical when re-signed with the same inputs', () => {
    const a = signAccessToken(keys.access, claims);
    const b = signAccessToken(keys.access, { ...claims, iat: new Date(iat), exp: new Date(exp) });
    expect(b).toBe(a);
  });

  it('truncates sub-second times to whole seconds', () => {
    const token = signAccessToken(keys.access, {
      ...claims,
      iat: new Date(iat.getTime() + 999),
      exp: new Date(exp.getTime() + 1),
    });
    expect(token).toBe(signAccessToken(keys.access, claims));
  });

  it('differs when any claim or the key differs', () => {
    const base = signAccessToken(keys.access, claims);
    expect(signAccessToken(other.access, claims)).not.toBe(base);
    expect(signAccessToken(keys.access, { ...claims, sub: 'user-2' })).not.toBe(base);
    expect(signAccessToken(keys.access, { ...claims, fam: 'family-2' })).not.toBe(base);
    expect(signAccessToken(keys.access, { ...claims, jti: 'token-2' })).not.toBe(base);
    expect(signAccessToken(keys.access, { ...claims, exp: new Date(exp.getTime() + 1000) })).not.toBe(base);
  });
});

describe('verifyAccessToken', () => {
  const token = signAccessToken(keys.access, claims);

  it('accepts a token it signed, before exp', () => {
    const r = verifyAccessToken(keys.access, token, new Date(exp.getTime() - 1));
    expect(r).toEqual({ kind: 'valid', claims });
  });

  it('answers expired, with the claims, at and after exp', () => {
    expect(verifyAccessToken(keys.access, token, exp)).toEqual({ kind: 'expired', claims });
    expect(verifyAccessToken(keys.access, token, new Date('2027-01-01T00:00:00Z'))).toEqual({
      kind: 'expired',
      claims,
    });
  });

  it('answers invalid, not expired, for an expired token with a bad signature', () => {
    const forged = signAccessToken(other.access, claims);
    expect(verifyAccessToken(keys.access, forged, new Date('2027-01-01T00:00:00Z'))).toEqual({
      kind: 'invalid',
    });
  });

  it('refuses a token signed with another key, including the other auth keys', () => {
    for (const key of [other.access, keys.refresh, keys.signupBody]) {
      expect(verifyAccessToken(keys.access, signAccessToken(key, claims), iat)).toEqual({ kind: 'invalid' });
    }
  });

  it('refuses a tampered payload or signature', () => {
    const [h, p, s] = token.split('.') as [string, string, string];
    const tamperedPayload = b64(Buffer.from(p, 'base64url').toString().replace('user-1', 'user-2'));
    expect(verifyAccessToken(keys.access, `${h}.${tamperedPayload}.${s}`, iat).kind).toBe('invalid');
    const flipped = `${s.slice(0, -2)}${s.at(-2) === 'A' ? 'B' : 'A'}${s.at(-1)}`;
    expect(verifyAccessToken(keys.access, `${h}.${p}.${flipped}`, iat).kind).toBe('invalid');
    expect(verifyAccessToken(keys.access, `${h}.${p}.`, iat).kind).toBe('invalid');
    expect(verifyAccessToken(keys.access, `${h}.${p}.${s.slice(0, -1)}`, iat).kind).toBe('invalid');
    expect(verifyAccessToken(keys.access, `${h}.${p}.${s}A`, iat).kind).toBe('invalid');
  });

  it('refuses a non-canonical encoding of the signature', () => {
    const [h, p, s] = token.split('.') as [string, string, string];
    // The last base64url character of a 32-byte value carries 2 unused bits; Buffer ignores them.
    const last = s.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
    const alias = `${s.slice(0, -1)}${sibling}`;
    expect(Buffer.from(alias, 'base64url').equals(Buffer.from(s, 'base64url'))).toBe(true);
    expect(verifyAccessToken(keys.access, `${h}.${p}.${alias}`, iat).kind).toBe('invalid');
    expect(verifyAccessToken(keys.access, `${h}.${p}.${s}=`, iat).kind).toBe('invalid');
  });

  it('refuses alg none, other algorithms, a wrong typ or extra header fields, even when signed', () => {
    const headers = [
      '{"alg":"none","typ":"JWT"}',
      '{"alg":"HS512","typ":"JWT"}',
      '{"alg":"RS256","typ":"JWT"}',
      '{"alg":"hs256","typ":"JWT"}',
      '{"alg":"HS256","typ":"at+jwt"}',
      '{"alg":"HS256"}',
      '{"typ":"JWT","alg":"HS256"}',
      '{"alg":"HS256","typ":"JWT","kid":"x"}',
    ];
    for (const header of headers) {
      expect(verifyAccessToken(keys.access, forge(b64(header), payload()), iat), header).toEqual({
        kind: 'invalid',
      });
    }
    // alg none with an empty signature.
    const none = `${b64('{"alg":"none","typ":"JWT"}')}.${payload()}.`;
    expect(verifyAccessToken(keys.access, none, iat)).toEqual({ kind: 'invalid' });
  });

  it('refuses malformed input without throwing', () => {
    const inputs: unknown[] = [
      '',
      'abc',
      'a.b',
      'a.b.c.d',
      '..',
      `${HEADER}..`,
      `${HEADER}.${payload()}`,
      `${HEADER}.${payload()}.sig.extra`,
      `${HEADER}.pay load.${'A'.repeat(43)}`,
      `${HEADER}.${payload()}+.${'A'.repeat(43)}`,
      ` ${signAccessToken(keys.access, claims)}`,
      `${signAccessToken(keys.access, claims)} `,
      `Bearer ${signAccessToken(keys.access, claims)}`,
      'x'.repeat(10_000),
      undefined,
      null,
      42,
      {},
    ];
    for (const input of inputs) {
      expect(verifyAccessToken(keys.access, input as string, iat), String(input)).toEqual({
        kind: 'invalid',
      });
    }
  });

  it('refuses a correctly signed payload that is not JSON or not an object', () => {
    for (const body of ['not json', '{"sub":', '[]', 'null', '42', '"text"']) {
      expect(verifyAccessToken(keys.access, forge(HEADER, b64(body)), iat), body).toEqual({
        kind: 'invalid',
      });
    }
  });

  it('refuses a correctly signed payload with missing or ill-typed claims', () => {
    const cases: Record<string, unknown>[] = [
      { sub: undefined },
      { fam: undefined },
      { jti: undefined },
      { iat: undefined },
      { exp: undefined },
      { sub: '' },
      { fam: '' },
      { jti: '' },
      { sub: 42 },
      { fam: null },
      { jti: ['x'] },
      { iat: '1795003200' },
      { exp: '1795004100' },
      { iat: 1795003200.5 },
      { exp: 1795004100.5 },
      { exp: Number.MAX_SAFE_INTEGER + 2 },
      { iat: -1 },
      { exp: null },
      { exp: 1795003199 }, // exp before iat
    ];
    for (const over of cases) {
      const t = forge(HEADER, payload(over));
      expect(verifyAccessToken(keys.access, t, iat), JSON.stringify(over)).toEqual({ kind: 'invalid' });
    }
  });

  it('accepts the hand-forged reference payload, so the cases above fail for their own reason', () => {
    const r = verifyAccessToken(keys.access, forge(HEADER, payload()), iat);
    expect(r).toEqual({ kind: 'valid', claims });
  });
});

describe('refresh tokens', () => {
  it('newRefreshToken is rt_ and 32 random bytes in base64url', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slice(3), 'base64url').length).toBe(32);
    expect(a).not.toBe(b);
    expect(isWellFormedRefreshToken(a)).toBe(true);
  });

  it('deriveChildRefreshToken is rt_ and the HMAC of the parent, deterministic per key', () => {
    const parent = newRefreshToken();
    const child = deriveChildRefreshToken(keys.refresh, parent);
    expect(child).toBe(`rt_${createHmac('sha256', keys.refresh).update(parent).digest('base64url')}`);
    expect(deriveChildRefreshToken(keys.refresh, parent)).toBe(child);
    expect(deriveChildRefreshToken(other.refresh, parent)).not.toBe(child);
    expect(deriveChildRefreshToken(keys.refresh, newRefreshToken())).not.toBe(child);
    expect(isWellFormedRefreshToken(child)).toBe(true);
  });

  it('refreshTokenHash is a domain-separated hex SHA-256', () => {
    const token = newRefreshToken();
    const hash = refreshTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(refreshTokenHash(token));
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toBe(createHash('sha256').update(`device:${token}`).digest('hex'));
  });

  it('isWellFormedRefreshToken refuses anything that is not rt_ and 43 base64url characters', () => {
    const good = newRefreshToken();
    for (const bad of [
      '',
      'rt_',
      good.slice(3),
      `${good}A`,
      good.slice(0, -1),
      `RT_${good.slice(3)}`,
      `rt_${'+'.repeat(43)}`,
      `rt_${'A'.repeat(42)}=`,
      ` ${good}`,
      undefined,
      42,
    ]) {
      expect(isWellFormedRefreshToken(bad as string), String(bad)).toBe(false);
    }
  });
});
