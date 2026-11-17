import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AttestationFailure } from '../../src/attestation/appAttest.js';
import {
  checkVerdict,
  createGoogleDecoder,
  type DecodeHttpClient,
  DecodeTimeoutError,
  isPlausibleToken,
  normaliseCertDigest,
  type VerdictBinding,
} from '../../src/attestation/playIntegrity.js';
import { CERT_B64URL, CERT_BYTES, CERT_COLON_HEX, NOW, PACKAGE, verdict } from './playFixtures.js';

const H = createHash('sha256').update('idem\n{"a":1}').digest();

const policy = { packageName: PACKAGE, certDigests: [normaliseCertDigest(CERT_COLON_HEX) as Buffer] };
const classic: VerdictBinding = { kind: 'classic', nonce: 'c2VydmVyLW5vbmNlLXZhbHVlLTMyLWJ5dGVz' };
const standard: VerdictBinding = { kind: 'standard', requestHashHex: H.toString('hex'), now: NOW };

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AttestationFailure) return err.reason;
    throw err;
  }
  throw new Error('expected an AttestationFailure');
}

describe('certificate digest normalisation', () => {
  it('treats colon hex, plain hex, base64url and base64 of the same digest as equal', () => {
    for (const form of [
      CERT_COLON_HEX,
      CERT_COLON_HEX.toLowerCase(),
      CERT_BYTES.toString('hex'),
      CERT_B64URL,
      CERT_BYTES.toString('base64'),
    ]) {
      expect(normaliseCertDigest(form)?.equals(CERT_BYTES)).toBe(true);
    }
  });

  it('rejects things that are not a SHA-256 digest', () => {
    for (const bad of [
      '',
      'abc',
      'AB:CD',
      CERT_BYTES.subarray(0, 20).toString('hex'),
      `${CERT_COLON_HEX}:00`,
      'x'.repeat(64),
    ]) {
      expect(normaliseCertDigest(bad)).toBeUndefined();
    }
  });
});

describe('classic verdict (registration)', () => {
  const classicVerdict = (o: Parameters<typeof verdict>[0] = {}) =>
    verdict({
      ...o,
      requestDetails: { nonce: classic.kind === 'classic' ? classic.nonce : '', ...o.requestDetails },
    });

  it('accepts a valid verdict', () => {
    expect(checkVerdict(classicVerdict(), policy, classic)).toEqual({
      versionCode: '42',
      appLicensingVerdict: 'LICENSED',
    });
  });

  it('ignores base64 padding differences on the nonce only', () => {
    expect(() =>
      checkVerdict(
        classicVerdict({ requestDetails: { nonce: 'c2VydmVyLW5vbmNlLXZhbHVlLTMyLWJ5dGVz==' } }),
        policy,
        classic,
      ),
    ).not.toThrow();
  });

  it('rejects the wrong nonce', () => {
    expect(
      reasonOf(() =>
        checkVerdict(
          classicVerdict({ requestDetails: { nonce: 'b3RoZXItbm9uY2UtdmFsdWU' } }),
          policy,
          classic,
        ),
      ),
    ).toBe('android_nonce_mismatch');
    expect(reasonOf(() => checkVerdict(verdict(), policy, classic))).toBe('android_nonce_mismatch');
  });

  it('rejects the wrong package (request or app)', () => {
    expect(
      reasonOf(() =>
        checkVerdict(classicVerdict({ requestDetails: { requestPackageName: 'org.evil' } }), policy, classic),
      ),
    ).toBe('android_request_package_mismatch');
    expect(
      reasonOf(() =>
        checkVerdict(classicVerdict({ appIntegrity: { packageName: 'org.evil' } }), policy, classic),
      ),
    ).toBe('android_package_mismatch');
  });

  it('rejects an app that is not Play-recognised', () => {
    for (const v of ['UNRECOGNIZED_VERSION', 'UNEVALUATED', undefined]) {
      expect(
        reasonOf(() =>
          checkVerdict(classicVerdict({ appIntegrity: { appRecognitionVerdict: v } }), policy, classic),
        ),
      ).toBe('android_app_not_play_recognized');
    }
  });

  it('rejects the wrong certificate digest', () => {
    const other = createHash('sha256').update('other cert').digest('base64url');
    expect(
      reasonOf(() =>
        checkVerdict(classicVerdict({ appIntegrity: { certificateSha256Digest: [other] } }), policy, classic),
      ),
    ).toBe('android_cert_digest_mismatch');
    // Every signer must be configured, not just one of them.
    expect(
      reasonOf(() =>
        checkVerdict(
          classicVerdict({ appIntegrity: { certificateSha256Digest: [CERT_B64URL, other] } }),
          policy,
          classic,
        ),
      ),
    ).toBe('android_cert_digest_mismatch');
    expect(
      reasonOf(() =>
        checkVerdict(classicVerdict({ appIntegrity: { certificateSha256Digest: [] } }), policy, classic),
      ),
    ).toBe('android_cert_digest_missing');
  });

  it('rejects a device without MEETS_DEVICE_INTEGRITY', () => {
    for (const labels of [[], ['MEETS_BASIC_INTEGRITY'], undefined, 'MEETS_DEVICE_INTEGRITY']) {
      expect(
        reasonOf(() =>
          checkVerdict(
            classicVerdict({ deviceIntegrity: { deviceRecognitionVerdict: labels } }),
            policy,
            classic,
          ),
        ),
      ).toBe('android_device_integrity');
    }
  });

  it('rejects Play Console testing responses', () => {
    expect(
      reasonOf(() =>
        checkVerdict(classicVerdict({ testingDetails: { isTestingResponse: true } }), policy, classic),
      ),
    ).toBe('android_testing_response');
  });

  it('turns garbage into clean failures', () => {
    for (const bad of [
      undefined,
      null,
      'string',
      [],
      {},
      { requestDetails: {} },
      { requestDetails: 1, appIntegrity: {}, deviceIntegrity: {} },
    ]) {
      expect(() => checkVerdict(bad, policy, classic)).toThrow(AttestationFailure);
    }
  });
});

describe('standard verdict (each SOS)', () => {
  const standardVerdict = (o: Parameters<typeof verdict>[0] = {}) =>
    verdict({ ...o, requestDetails: { requestHash: H.toString('hex'), ...o.requestDetails } });

  it('accepts a valid verdict', () => {
    expect(() => checkVerdict(standardVerdict(), policy, standard)).not.toThrow();
  });

  it('rejects a request hash for a different body, or in another encoding', () => {
    const other = createHash('sha256').update('idem\n{"a":2}').digest('hex');
    expect(
      reasonOf(() =>
        checkVerdict(standardVerdict({ requestDetails: { requestHash: other } }), policy, standard),
      ),
    ).toBe('android_request_hash_mismatch');
    expect(
      reasonOf(() =>
        checkVerdict(
          standardVerdict({ requestDetails: { requestHash: H.toString('hex').toUpperCase() } }),
          policy,
          standard,
        ),
      ),
    ).toBe('android_request_hash_mismatch');
    expect(
      reasonOf(() =>
        checkVerdict(
          standardVerdict({ requestDetails: { requestHash: H.toString('base64') } }),
          policy,
          standard,
        ),
      ),
    ).toBe('android_request_hash_mismatch');
  });

  it('rejects a stale token and accepts one just inside the window', () => {
    const at = (ms: number) => ({ requestDetails: { timestampMillis: String(NOW.getTime() - ms) } });
    expect(() => checkVerdict(standardVerdict(at(5 * 60_000)), policy, standard)).not.toThrow();
    expect(reasonOf(() => checkVerdict(standardVerdict(at(5 * 60_000 + 1)), policy, standard))).toBe(
      'android_token_stale',
    );
  });

  it('rejects a token from the future beyond clock skew', () => {
    const at = (ms: number) => ({ requestDetails: { timestampMillis: String(NOW.getTime() + ms) } });
    expect(() => checkVerdict(standardVerdict(at(30_000)), policy, standard)).not.toThrow();
    expect(reasonOf(() => checkVerdict(standardVerdict(at(61_000)), policy, standard))).toBe(
      'android_token_in_future',
    );
  });

  it('rejects a malformed timestamp', () => {
    for (const ts of [undefined, 'soon', '', '1.5', -1]) {
      expect(
        reasonOf(() =>
          checkVerdict(standardVerdict({ requestDetails: { timestampMillis: ts } }), policy, standard),
        ),
      ).toBe('android_timestamp_malformed');
    }
  });

  it('applies the same app and device checks as registration', () => {
    expect(
      reasonOf(() =>
        checkVerdict(
          standardVerdict({ appIntegrity: { appRecognitionVerdict: 'UNEVALUATED' } }),
          policy,
          standard,
        ),
      ),
    ).toBe('android_app_not_play_recognized');
    expect(
      reasonOf(() =>
        checkVerdict(
          standardVerdict({ appIntegrity: { certificateSha256Digest: ['AAAA'] } }),
          policy,
          standard,
        ),
      ),
    ).toBe('android_cert_digest_mismatch');
    expect(
      reasonOf(() =>
        checkVerdict(
          standardVerdict({ deviceIntegrity: { deviceRecognitionVerdict: undefined } }),
          policy,
          standard,
        ),
      ),
    ).toBe('android_device_integrity');
    expect(
      reasonOf(() =>
        checkVerdict(standardVerdict({ appIntegrity: { packageName: 'org.evil' } }), policy, standard),
      ),
    ).toBe('android_package_mismatch');
  });
});

describe('token shape', () => {
  it('accepts JWE-looking strings and refuses other things', () => {
    expect(isPlausibleToken('eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.abc.def.ghi.jkl')).toBe(true);
    for (const bad of [
      undefined,
      1,
      '',
      'short',
      'has spaces in it here',
      'x'.repeat(20_000),
      '{"json":true}',
    ]) {
      expect(isPlausibleToken(bad)).toBe(false);
    }
  });
});

describe('Google decoder', () => {
  it('posts the token to decodeIntegrityToken for the package and returns tokenPayloadExternal', async () => {
    const calls: Parameters<DecodeHttpClient['request']>[0][] = [];
    const client: DecodeHttpClient = {
      async request(opts) {
        calls.push(opts);
        return { data: { tokenPayloadExternal: { ok: 1 } } };
      },
    };
    const d = createGoogleDecoder('{}', { client: async () => client });
    await expect(d.decode(PACKAGE, 'tok')).resolves.toEqual({ ok: 1 });
    expect(calls[0]?.url).toBe(`https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.data).toEqual({ integrityToken: 'tok' });
    expect(calls[0]?.retry).toBe(false);
    expect(calls[0]?.timeout).toBe(3000);
  });

  it('gives up after the timeout and aborts the request', async () => {
    let aborted = false;
    const client: DecodeHttpClient = {
      request(opts) {
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      },
    };
    const d = createGoogleDecoder('{}', { client: async () => client, timeoutMs: 30 });
    await expect(d.decode(PACKAGE, 'tok')).rejects.toBeInstanceOf(DecodeTimeoutError);
    expect(aborted).toBe(true);
  });

  it('counts slow OAuth token fetching against the same timeout', async () => {
    const d = createGoogleDecoder('{}', { client: () => new Promise(() => {}), timeoutMs: 30 });
    await expect(d.decode(PACKAGE, 'tok')).rejects.toBeInstanceOf(DecodeTimeoutError);
  });

  it('builds a real Google client from service-account JSON without calling the network', () => {
    expect(() =>
      createGoogleDecoder(
        JSON.stringify({
          type: 'service_account',
          client_email: 'a@b.iam.gserviceaccount.com',
          private_key: 'x',
        }),
      ),
    ).not.toThrow();
    expect(() => createGoogleDecoder('not json')).toThrow();
  });
});
