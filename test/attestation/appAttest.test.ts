import { createHash, X509Certificate } from 'node:crypto';
import { Decoder } from 'cbor-x';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AAGUID_DEVELOPMENT,
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  AttestationFailure,
  decodeBase64Strict,
  parseTrustedRoot,
  verifyAssertion,
  verifyAttestation,
} from '../../src/attestation/appAttest.js';
import { APPLE_SAMPLE_ATTESTATION_OBJECT_B64 } from './appleSample.js';
import {
  APPLE_SAMPLE,
  BUNDLE_ID,
  cbor,
  coseKey,
  type IosWorld,
  makeAssertion,
  makeAttestation,
  makeCa,
  makeIosWorld,
  makeLeafKey,
  sha256,
  TEAM_ID,
} from './fixtures.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const NONCE = 'server-nonce';
const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AttestationFailure) return err.reason;
    throw err;
  }
  throw new Error('expected an AttestationFailure');
}

describe('Apple App Attest root', () => {
  it('embeds the real Apple App Attestation Root CA', () => {
    const root = new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    expect(root.subject).toContain('CN=Apple App Attestation Root CA');
    expect(root.fingerprint256).toBe(
      '1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32',
    );
    expect(root.ca).toBe(true);
  });

  it('refuses an unusable trusted root', () => {
    expect(() => parseTrustedRoot('not a certificate')).toThrow();
  });
});

describe("Apple's published sample (real Apple-signed data)", () => {
  const object = Buffer.from(APPLE_SAMPLE_ATTESTATION_OBJECT_B64, 'base64');
  const keyId = Buffer.from(APPLE_SAMPLE.keyId, 'base64');
  const params = {
    attestationObject: object,
    keyId,
    // The sample was produced with the raw challenge bytes as clientDataHash (see appleSample.ts).
    clientDataHash: Buffer.from(APPLE_SAMPLE.challenge, 'utf8'),
    teamId: APPLE_SAMPLE.teamId,
    bundleId: APPLE_SAMPLE.bundleId,
    env: 'production' as const,
    trustedRoot: parseTrustedRoot(APPLE_APP_ATTESTATION_ROOT_CA_PEM),
    now: new Date(APPLE_SAMPLE.validAt),
  };

  it('verifies against the real Apple root while the leaf is valid', () => {
    const v = verifyAttestation(params);
    expect(v.keyId.toString('base64')).toBe(APPLE_SAMPLE.keyId);
    expect(v.counter).toBe(0);
    expect(v.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(v.signals).toEqual({ validationCategory: 1, bundleVersion: '1' });
  });

  it('fails once the leaf has expired', () => {
    expect(reasonOf(() => verifyAttestation({ ...params, now: NOW }))).toBe('ios_chain_expired');
  });

  it('fails for a different challenge, app id or environment', () => {
    expect(
      reasonOf(() => verifyAttestation({ ...params, clientDataHash: sha256(APPLE_SAMPLE.challenge) })),
    ).toBe('ios_nonce_mismatch');
    expect(reasonOf(() => verifyAttestation({ ...params, bundleId: 'com.example.other' }))).toBe(
      'ios_app_id_mismatch',
    );
    expect(reasonOf(() => verifyAttestation({ ...params, env: 'development' }))).toBe('ios_aaguid_mismatch');
  });

  it('fails against a root that is not Apple', async () => {
    const other = await makeCa('Other Root', new Date(APPLE_SAMPLE.validAt));
    expect(reasonOf(() => verifyAttestation({ ...params, trustedRoot: parseTrustedRoot(other.pem) }))).toBe(
      'ios_chain_untrusted',
    );
  });
});

describe('App Attest attestation (registration), self-made chain', () => {
  let world: IosWorld;
  let trustedRoot: X509Certificate;

  beforeAll(async () => {
    world = await makeIosWorld(NOW);
    trustedRoot = parseTrustedRoot(world.root.pem);
  });

  const verify = (attestationObject: Buffer, over: Partial<Parameters<typeof verifyAttestation>[0]> = {}) =>
    verifyAttestation({
      attestationObject,
      keyId: world.leafKey.keyId,
      clientDataHash: sha256(Buffer.from(NONCE, 'utf8')),
      teamId: TEAM_ID,
      bundleId: BUNDLE_ID,
      env: 'production',
      trustedRoot,
      now: NOW,
      ...over,
    });

  it('accepts a valid attestation and returns the certified key', async () => {
    const v = verify(await makeAttestation(world));
    expect(v.keyId.equals(world.leafKey.keyId)).toBe(true);
    expect(v.counter).toBe(0);
    // The returned key is the leaf key: an assertion signed by the leaf key verifies against it.
    const h = sha256('binding');
    const a = makeAssertion(world.leafKey.privateKey, h, { counter: 1 });
    expect(
      verifyAssertion({
        assertion: a,
        clientDataHash: h,
        teamId: TEAM_ID,
        bundleId: BUNDLE_ID,
        publicKeyPem: v.publicKeyPem,
        previousCounter: 0,
      }).counter,
    ).toBe(1);
  });

  it('accepts the development aaguid when configured for development', async () => {
    const obj = await makeAttestation(world, { aaguid: AAGUID_DEVELOPMENT });
    expect(verify(obj, { env: 'development' }).counter).toBe(0);
  });

  it('reads iOS 27 extensions as signals', async () => {
    const ext = new Map<string, unknown>([
      ['apple_validation_category_01', Buffer.from([4, 0, 0, 0])],
      ['apple_bundle_version_01', '2.3'],
    ]);
    expect(verify(await makeAttestation(world, { extensions: ext })).signals).toEqual({
      validationCategory: 4,
      bundleVersion: '2.3',
    });
  });

  it('rejects the wrong nonce', async () => {
    const obj = await makeAttestation(world, { certNonce: 'another-nonce' });
    expect(reasonOf(() => verify(obj))).toBe('ios_nonce_mismatch');
  });

  it('rejects a nonce presented for a different registration', async () => {
    const obj = await makeAttestation(world);
    expect(reasonOf(() => verify(obj, { clientDataHash: sha256('other') }))).toBe('ios_nonce_mismatch');
  });

  it('rejects a leaf without the nonce extension', async () => {
    const obj = await makeAttestation(world, { omitNonceExt: true });
    expect(reasonOf(() => verify(obj))).toBe('ios_nonce_extension_missing');
  });

  it('rejects the wrong app id (team or bundle)', async () => {
    const obj = await makeAttestation(world, { bundleId: 'org.example.evil' });
    expect(reasonOf(() => verify(obj))).toBe('ios_app_id_mismatch');
    const obj2 = await makeAttestation(world, { teamId: 'ZZZZZ99999' });
    expect(reasonOf(() => verify(obj2))).toBe('ios_app_id_mismatch');
  });

  it('rejects a key id that is not the hash of the certified key', async () => {
    const obj = await makeAttestation(world);
    const other = await makeLeafKey();
    expect(reasonOf(() => verify(obj, { keyId: other.keyId }))).toBe('ios_key_id_mismatch');
    expect(reasonOf(() => verify(obj, { keyId: Buffer.alloc(16) }))).toBe('ios_key_id_malformed');
  });

  it('rejects a non-zero counter', async () => {
    const obj = await makeAttestation(world, { counter: 1 });
    expect(reasonOf(() => verify(obj))).toBe('ios_counter_not_zero');
  });

  it('rejects the wrong aaguid for the environment', async () => {
    const dev = await makeAttestation(world, { aaguid: AAGUID_DEVELOPMENT });
    expect(reasonOf(() => verify(dev))).toBe('ios_aaguid_mismatch');
    const prod = await makeAttestation(world);
    expect(reasonOf(() => verify(prod, { env: 'development' }))).toBe('ios_aaguid_mismatch');
  });

  it('rejects a credential id that differs from the key id', async () => {
    const obj = await makeAttestation(world, { credentialId: sha256('something else') });
    expect(reasonOf(() => verify(obj))).toBe('ios_credential_id_mismatch');
  });

  it('rejects a COSE key that is not the certified key', async () => {
    const other = await makeLeafKey();
    const obj = await makeAttestation(world, { coseOverride: coseKey(other.x, other.y) });
    expect(reasonOf(() => verify(obj))).toBe('ios_cose_key_mismatch');
  });

  it('rejects an untrusted chain', async () => {
    const rogueRoot = await makeCa('Rogue Root', NOW);
    const rogueIntermediate = await makeCa('Rogue CA', NOW, rogueRoot);
    const obj = await makeAttestation(world, { issuer: rogueIntermediate });
    expect(reasonOf(() => verify(obj))).toBe('ios_chain_untrusted');
    // A leaf signed directly by the trusted root but presented without an intermediate is too short.
    const objNoIntermediate = cbor.encode(
      new Map<string, unknown>([
        ['fmt', 'apple-appattest'],
        [
          'attStmt',
          new Map<string, unknown>([
            ['x5c', [Buffer.from(world.intermediate.cert.rawData)]],
            ['receipt', Buffer.alloc(1)],
          ]),
        ],
        ['authData', Buffer.alloc(100)],
      ]),
    );
    expect(reasonOf(() => verify(objNoIntermediate))).toBe('ios_chain_length');
  });

  it('rejects an expired leaf', async () => {
    const obj = await makeAttestation(world, { leafNotAfter: new Date(NOW.getTime() - 1000) });
    expect(reasonOf(() => verify(obj))).toBe('ios_chain_expired');
  });

  it('rejects the wrong attestation format', async () => {
    const good = await makeAttestation(world);
    const decoded = decoder.decode(good) as Map<string, unknown>;
    decoded.set('fmt', 'packed');
    expect(reasonOf(() => verify(cbor.encode(decoded)))).toBe('ios_attestation_wrong_format');
  });

  it('turns garbage and truncation into clean failures', async () => {
    const good = await makeAttestation(world);
    for (const bad of [
      Buffer.from('garbage'),
      good.subarray(0, good.length - 10),
      good.subarray(0, 50),
      cbor.encode('a string'),
      cbor.encode(new Map([['fmt', 'apple-appattest']])),
      cbor.encode(
        new Map<string, unknown>([
          ['fmt', 'apple-appattest'],
          [
            'attStmt',
            new Map<string, unknown>([
              ['x5c', [Buffer.from('not a cert'), Buffer.from('nor this')]],
              ['receipt', Buffer.alloc(1)],
            ]),
          ],
          ['authData', Buffer.alloc(10)],
        ]),
      ),
    ]) {
      expect(() => verify(bad)).toThrow(AttestationFailure);
    }
  });
});

describe('App Attest assertion (each SOS)', () => {
  let world: IosWorld;
  let pem: string;
  const h = createHash('sha256').update('idem-key\n{"intakeCode":"x"}').digest();

  beforeAll(async () => {
    world = await makeIosWorld(NOW);
    pem = verifyAttestation({
      attestationObject: await makeAttestation(world),
      keyId: world.leafKey.keyId,
      clientDataHash: sha256(Buffer.from(NONCE, 'utf8')),
      teamId: TEAM_ID,
      bundleId: BUNDLE_ID,
      env: 'production',
      trustedRoot: parseTrustedRoot(world.root.pem),
      now: NOW,
    }).publicKeyPem;
  });

  const check = (assertion: Buffer, over: Partial<Parameters<typeof verifyAssertion>[0]> = {}) =>
    verifyAssertion({
      assertion,
      clientDataHash: h,
      teamId: TEAM_ID,
      bundleId: BUNDLE_ID,
      publicKeyPem: pem,
      previousCounter: 4,
      ...over,
    });

  it('accepts a valid assertion and returns the new counter', () => {
    expect(check(makeAssertion(world.leafKey.privateKey, h, { counter: 5 })).counter).toBe(5);
  });

  it('accepts iOS 27 extensions after the header and reads them', () => {
    const ext = new Map<string, unknown>([['apple_validation_category_01', Buffer.from([2, 0, 0, 0])]]);
    expect(
      check(makeAssertion(world.leafKey.privateKey, h, { counter: 5, extensions: ext })).signals,
    ).toEqual({
      validationCategory: 2,
    });
  });

  it('rejects a binding hash for a different body', () => {
    const a = makeAssertion(world.leafKey.privateKey, h, { counter: 5 });
    const otherBody = createHash('sha256').update('idem-key\n{"intakeCode":"y"}').digest();
    expect(reasonOf(() => check(a, { clientDataHash: otherBody }))).toBe('ios_signature_invalid');
  });

  it('rejects a tampered signature', () => {
    const a = makeAssertion(world.leafKey.privateKey, h, { counter: 5 });
    const m = decoder.decode(a) as Map<string, Buffer>;
    const sig = Buffer.from(m.get('signature') as Buffer);
    sig[sig.length - 1] = (sig[sig.length - 1] as number) ^ 0x01;
    m.set('signature', sig);
    expect(reasonOf(() => check(cbor.encode(m)))).toBe('ios_signature_invalid');
  });

  it('rejects tampered authenticator data (e.g. a raised counter)', () => {
    const a = makeAssertion(world.leafKey.privateKey, h, { counter: 5 });
    const m = decoder.decode(a) as Map<string, Buffer>;
    const ad = Buffer.from(m.get('authenticatorData') as Buffer);
    ad.writeUInt32BE(500, 33);
    m.set('authenticatorData', ad);
    expect(reasonOf(() => check(cbor.encode(m)))).toBe('ios_signature_invalid');
  });

  it('rejects a signature from a different key', async () => {
    const other = await makeLeafKey();
    expect(reasonOf(() => check(makeAssertion(other.privateKey, h, { counter: 5 })))).toBe(
      'ios_signature_invalid',
    );
  });

  it('rejects a counter that does not increase', () => {
    expect(reasonOf(() => check(makeAssertion(world.leafKey.privateKey, h, { counter: 4 })))).toBe(
      'ios_counter_not_increasing',
    );
    expect(reasonOf(() => check(makeAssertion(world.leafKey.privateKey, h, { counter: 3 })))).toBe(
      'ios_counter_not_increasing',
    );
  });

  it('rejects the wrong app id', () => {
    expect(
      reasonOf(() =>
        check(makeAssertion(world.leafKey.privateKey, h, { counter: 5, bundleId: 'org.example.evil' })),
      ),
    ).toBe('ios_app_id_mismatch');
  });

  it('turns garbage into clean failures', () => {
    for (const bad of [
      Buffer.alloc(0),
      Buffer.from('garbage'),
      cbor.encode(new Map([['signature', Buffer.alloc(70)]])),
      cbor.encode(
        new Map<string, unknown>([
          ['signature', Buffer.alloc(70)],
          ['authenticatorData', Buffer.alloc(10)],
        ]),
      ),
      cbor.encode(
        new Map<string, unknown>([
          ['signature', 'not bytes'],
          ['authenticatorData', Buffer.alloc(37)],
        ]),
      ),
    ]) {
      expect(() => check(bad)).toThrow(AttestationFailure);
    }
    expect(
      reasonOf(() =>
        check(makeAssertion(world.leafKey.privateKey, h, { counter: 5 }), { publicKeyPem: 'x' }),
      ),
    ).toBe('ios_stored_key_invalid');
  });
});

describe('strict base64', () => {
  it('accepts standard base64 with or without padding and rejects everything else', () => {
    expect(decodeBase64Strict('AQID', 10)?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(decodeBase64Strict('AQI=', 10)?.equals(Buffer.from([1, 2]))).toBe(true);
    expect(decodeBase64Strict('AQI', 10)?.equals(Buffer.from([1, 2]))).toBe(true);
    for (const bad of ['', 'A', 'AQ-_', 'AQ I=', 'AQJ=', 'A===', '!!!!', 42, undefined]) {
      expect(decodeBase64Strict(bad, 10)).toBeUndefined();
    }
    expect(decodeBase64Strict('A'.repeat(100), 10)).toBeUndefined();
  });
});
