/**
 * Real cryptographic fixtures for App Attest: a self-made root and intermediate CA, a P-256 leaf
 * carrying the App Attest nonce extension, CBOR attestation objects and signed assertions.
 * Nothing here is mocked: the verifier sees genuine certificates and signatures, just not Apple's.
 */
import './reflectShim.js';
import { createHash, createSign, KeyObject, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { Encoder } from 'cbor-x';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const subtle = webcrypto.subtle;
type KeyPair = webcrypto.CryptoKeyPair;
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
export const NONCE_OID = '1.2.840.113635.100.8.2';

export const cbor = new Encoder({ mapsAsObjects: false, useRecords: false });

export const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export interface Ca {
  cert: x509.X509Certificate;
  keys: KeyPair;
  pem: string;
}

let serial = 1;
const nextSerial = () => (serial++).toString(16).padStart(2, '0');

export async function makeCa(name: string, now: Date, issuer?: Ca): Promise<Ca> {
  const keys = (await subtle.generateKey(EC, true, ['sign', 'verify'])) as KeyPair;
  const extensions = [
    new x509.BasicConstraintsExtension(true, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
  ];
  const window = {
    notBefore: new Date(now.getTime() - 365 * DAY_MS),
    notAfter: new Date(now.getTime() + 365 * DAY_MS),
  };
  const cert = issuer
    ? await x509.X509CertificateGenerator.create({
        serialNumber: nextSerial(),
        subject: `CN=${name}`,
        issuer: issuer.cert.subject,
        publicKey: keys.publicKey,
        signingKey: issuer.keys.privateKey,
        signingAlgorithm: SIG,
        extensions,
        ...window,
      })
    : await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: nextSerial(),
        name: `CN=${name}`,
        keys,
        signingAlgorithm: SIG,
        extensions,
        ...window,
      });
  return { cert, keys, pem: cert.toString('pem') };
}

/** DER of SEQUENCE { [1] { OCTET STRING nonce } }, as Apple encodes it. */
export function nonceExtensionValue(nonce: Buffer): Buffer {
  const octet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
  const tagged = Buffer.concat([Buffer.from([0xa1, octet.length]), octet]);
  return Buffer.concat([Buffer.from([0x30, tagged.length]), tagged]);
}

export interface LeafKey {
  keys: KeyPair;
  privateKey: KeyObject;
  point: Buffer;
  keyId: Buffer;
  x: Buffer;
  y: Buffer;
}

export async function makeLeafKey(): Promise<LeafKey> {
  const keys = (await subtle.generateKey(EC, true, ['sign', 'verify'])) as KeyPair;
  const point = Buffer.from(await subtle.exportKey('raw', keys.publicKey));
  return {
    keys,
    privateKey: KeyObject.from(keys.privateKey),
    point,
    keyId: sha256(point),
    x: point.subarray(1, 33),
    y: point.subarray(33, 65),
  };
}

export async function makeLeafCert(
  key: LeafKey,
  issuer: Ca,
  now: Date,
  opts: { nonceExt?: Buffer | null; notAfter?: Date; ca?: boolean } = {},
): Promise<x509.X509Certificate> {
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(opts.ca ?? false, undefined, true),
  ];
  if (opts.nonceExt !== null && opts.nonceExt !== undefined) {
    extensions.push(new x509.Extension(NONCE_OID, false, opts.nonceExt));
  }
  return x509.X509CertificateGenerator.create({
    serialNumber: nextSerial(),
    subject: `CN=${key.keyId.toString('hex')}`,
    issuer: issuer.cert.subject,
    publicKey: key.keys.publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIG,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: opts.notAfter ?? new Date(now.getTime() + 2 * DAY_MS),
    extensions,
  });
}

export function coseKey(x: Buffer, y: Buffer): Buffer {
  return cbor.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

export interface AuthDataOpts {
  rpIdHash: Buffer;
  counter?: number;
  aaguid?: Buffer;
  credentialId: Buffer;
  cose: Buffer;
  extensions?: Map<string, unknown>;
}

export function attestationAuthData(o: AuthDataOpts): Buffer {
  const flags = 0x40 | (o.extensions ? 0x80 : 0) | 0x01;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(o.counter ?? 0);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(o.credentialId.length);
  return Buffer.concat([
    o.rpIdHash,
    Buffer.from([flags]),
    counter,
    o.aaguid ?? Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]),
    len,
    o.credentialId,
    o.cose,
    o.extensions ? cbor.encode(o.extensions) : Buffer.alloc(0),
  ]);
}

export function attestationObject(x5c: Buffer[], authData: Buffer, fmt = 'apple-appattest'): Buffer {
  return cbor.encode(
    new Map<string, unknown>([
      ['fmt', fmt],
      [
        'attStmt',
        new Map<string, unknown>([
          ['x5c', x5c],
          ['receipt', Buffer.from('fake-receipt')],
        ]),
      ],
      ['authData', authData],
    ]),
  );
}

export interface IosFixtureOpts {
  teamId?: string;
  bundleId?: string;
  nonce?: string;
  /** Which nonce the certificate's extension was computed for. Defaults to `nonce`. */
  certNonce?: string;
  counter?: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  /** Swap in a different COSE key (x, y). */
  coseOverride?: Buffer;
  extensions?: Map<string, unknown>;
  omitNonceExt?: boolean;
  issuer?: Ca;
  leafNotAfter?: Date;
}

export interface IosWorld {
  now: Date;
  root: Ca;
  intermediate: Ca;
  leafKey: LeafKey;
}

export async function makeIosWorld(now: Date): Promise<IosWorld> {
  const root = await makeCa('Test App Attestation Root CA', now);
  const intermediate = await makeCa('Test App Attestation CA 1', now, root);
  return { now, root, intermediate, leafKey: await makeLeafKey() };
}

export const TEAM_ID = 'ABCDE12345';
export const BUNDLE_ID = 'org.example.sos';

/** A complete attestation object for `world.leafKey`, with optional faults injected. */
export async function makeAttestation(world: IosWorld, o: IosFixtureOpts = {}): Promise<Buffer> {
  const nonce = o.nonce ?? 'server-nonce';
  const authData = attestationAuthData({
    rpIdHash: sha256(`${o.teamId ?? TEAM_ID}.${o.bundleId ?? BUNDLE_ID}`),
    counter: o.counter ?? 0,
    aaguid: o.aaguid,
    credentialId: o.credentialId ?? world.leafKey.keyId,
    cose: o.coseOverride ?? coseKey(world.leafKey.x, world.leafKey.y),
    extensions: o.extensions,
  });
  const certNonce = sha256(authData, sha256(Buffer.from(o.certNonce ?? nonce, 'utf8')));
  const issuer = o.issuer ?? world.intermediate;
  const leaf = await makeLeafCert(world.leafKey, issuer, world.now, {
    nonceExt: o.omitNonceExt ? null : nonceExtensionValue(certNonce),
    notAfter: o.leafNotAfter,
  });
  return attestationObject([Buffer.from(leaf.rawData), Buffer.from(issuer.cert.rawData)], authData);
}

/** A signed assertion: ECDSA-SHA256 over nonce = SHA-256(authenticatorData || clientDataHash). */
export function makeAssertion(
  key: KeyObject,
  clientDataHash: Buffer,
  o: { counter: number; teamId?: string; bundleId?: string; extensions?: Map<string, unknown> },
): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(o.counter);
  const authenticatorData = Buffer.concat([
    sha256(`${o.teamId ?? TEAM_ID}.${o.bundleId ?? BUNDLE_ID}`),
    Buffer.from([o.extensions ? 0x80 : 0x00]),
    counter,
    o.extensions ? cbor.encode(o.extensions) : Buffer.alloc(0),
  ]);
  const nonce = sha256(authenticatorData, clientDataHash);
  const signature = createSign('SHA256').update(nonce).sign(key);
  return cbor.encode(
    new Map<string, unknown>([
      ['signature', signature],
      ['authenticatorData', authenticatorData],
    ]),
  );
}

/** Apple's published sample from the "Attestation Object Validation Guide" (real Apple-signed data). */
export const APPLE_SAMPLE = {
  teamId: '1234567890',
  bundleId: 'com.example.myapp',
  challenge: 'example_server_challenge',
  keyId: 'zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=',
  /** Leaf is valid 2026-04-20T18:13:12Z to 2026-04-23T18:13:12Z. */
  validAt: '2026-04-21T12:00:00.000Z',
};
