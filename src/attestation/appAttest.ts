/**
 * Apple App Attest, verified locally. PRD §7.2 (registration) and §7.4 (assertion per SOS).
 *
 * Steps follow Apple's "Validating apps that connect to your server" and the "Attestation Object
 * Validation Guide" (developer.apple.com/documentation/devicecheck), retrieved 2026-11-17.
 * Every check failure throws AttestationFailure; the service turns that into an outcome.
 */
import {
  createHash,
  createPublicKey,
  createVerify,
  type KeyObject,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { Decoder } from 'cbor-x';
import { getCertificateExtension, parseAppAttestNonceExtension } from './der.js';

/**
 * Apple App Attestation Root CA, from https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * (fetched over HTTPS on 2026-11-17).
 * Subject CN=Apple App Attestation Root CA, O=Apple Inc., ST=California; valid 2020-03-18 to 2045-03-15.
 * SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32.
 */
export const APPLE_APP_ATTESTATION_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

export const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';
export const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop', 'ascii');
export const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]);

/** Upper bounds on decoded sizes, so a hostile payload cannot make us do unbounded work. */
export const MAX_ATTESTATION_OBJECT_BYTES = 64 * 1024;
export const MAX_ASSERTION_BYTES = 4 * 1024;

const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export type AppAttestEnv = 'production' | 'development';

/** A verification step failed. `reason` is a short code for logs; it never contains payload data. */
export class AttestationFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AttestationFailure';
  }
}

function fail(reason: string): never {
  throw new AttestationFailure(reason);
}

const cbor = new Decoder({ mapsAsObjects: false, useRecords: false });

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function asBytes(v: unknown): Buffer | undefined {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return undefined;
}

function decodeCbor(buf: Buffer, reason: string): unknown {
  try {
    return cbor.decode(buf);
  } catch {
    return fail(reason);
  }
}

/** Standard base64 (RFC 4648 §4), padding optional. Rejects anything that does not round-trip. */
export function decodeBase64Strict(s: unknown, maxBytes: number): Buffer | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  if (s.length > Math.ceil((maxBytes * 4) / 3) + 4) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  const unpadded = s.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  if (s.length !== unpadded.length && s.length % 4 !== 0) return undefined;
  const buf = Buffer.from(unpadded, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== unpadded) return undefined;
  return buf;
}

/** App ID = "{teamId}.{bundleId}"; the RP ID in authenticator data is its SHA-256. */
export function appIdHash(teamId: string, bundleId: string): Buffer {
  return sha256(Buffer.from(`${teamId}.${bundleId}`, 'utf8'));
}

/** X9.62 uncompressed point (0x04 || X || Y) of a P-256 public key. */
function uncompressedP256(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    fail('ios_leaf_key_not_p256');
  }
  const jwk = key.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  if (x.length !== 32 || y.length !== 32) fail('ios_leaf_key_not_p256');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function certTimeOk(cert: X509Certificate, now: Date): boolean {
  const from = new Date(cert.validFrom).getTime();
  const to = new Date(cert.validTo).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const t = now.getTime();
  return t >= from && t <= to;
}

/** Parses a PEM root, failing closed if it is not a usable CA certificate. */
export function parseTrustedRoot(pem: string): X509Certificate {
  let root: X509Certificate;
  try {
    root = new X509Certificate(pem);
  } catch {
    throw new Error('App Attest trusted root is not a valid certificate');
  }
  if (!root.ca) throw new Error('App Attest trusted root is not a CA certificate');
  return root;
}

/** x5c[0] is the leaf; each certificate must be issued and signed by the next, the last by the trusted root. */
function verifyChain(x5c: Buffer[], root: X509Certificate, now: Date): X509Certificate {
  if (x5c.length < 2 || x5c.length > 4) fail('ios_chain_length');
  let certs: X509Certificate[];
  try {
    certs = x5c.map((der) => new X509Certificate(der));
  } catch {
    return fail('ios_chain_unparseable');
  }
  const leaf = certs[0] as X509Certificate;
  if (leaf.ca) fail('ios_leaf_is_ca');
  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i] as X509Certificate;
    const issuer = certs[i + 1] ?? root;
    if (i > 0 && !cert.ca) fail('ios_chain_intermediate_not_ca');
    if (!cert.checkIssued(issuer)) fail('ios_chain_untrusted');
    let signed = false;
    try {
      signed = cert.verify(issuer.publicKey);
    } catch {
      signed = false;
    }
    if (!signed) fail('ios_chain_untrusted');
    if (!certTimeOk(cert, now)) fail('ios_chain_expired');
  }
  if (!certTimeOk(root, now)) fail('ios_chain_expired');
  return leaf;
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  /** Only for attestations. */
  aaguid?: Buffer;
  credentialId?: Buffer;
  cosePublicKey?: unknown;
  extensions?: unknown;
}

function parseAttestationAuthData(buf: Buffer): AuthData {
  if (buf.length < 55) fail('ios_authdata_truncated');
  const flags = buf[32] as number;
  if ((flags & FLAG_AT) === 0) fail('ios_authdata_no_credential');
  const credLen = buf.readUInt16BE(53);
  if (credLen !== 32 || buf.length < 55 + credLen + 1) fail('ios_authdata_truncated');
  let rest: unknown[];
  try {
    rest = (cbor.decodeMultiple(buf.subarray(55 + credLen)) as unknown[] | undefined) ?? [];
  } catch {
    return fail('ios_authdata_malformed');
  }
  // COSE key, optionally followed by one extensions map. Apple's own published sample carries the
  // extensions map without setting the ED flag, so the flag is not required. authData is bound by the
  // nonce in the Apple-signed leaf, so this leniency cannot be used to smuggle content.
  if (rest.length < 1 || rest.length > 2) fail('ios_authdata_malformed');
  if (rest.length === 2 && !(rest[1] instanceof Map)) fail('ios_authdata_malformed');
  if (rest.length === 1 && (flags & FLAG_ED) !== 0) fail('ios_authdata_malformed');
  return {
    rpIdHash: buf.subarray(0, 32),
    flags,
    counter: buf.readUInt32BE(33),
    aaguid: buf.subarray(37, 53),
    credentialId: buf.subarray(55, 55 + credLen),
    cosePublicKey: rest[0],
    extensions: rest[1],
  };
}

/** The COSE EC2 key in authData must be the same P-256 key that the leaf certificate certifies. */
function checkCoseKey(cose: unknown, point: Buffer): void {
  if (!(cose instanceof Map)) fail('ios_cose_key_malformed');
  const x = asBytes(cose.get(-2));
  const y = asBytes(cose.get(-3));
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 || !x || !y)
    fail('ios_cose_key_malformed');
  if (!bytesEqual(Buffer.concat([Buffer.from([0x04]), x, y]), point)) fail('ios_cose_key_mismatch');
}

export interface AppAttestSignals {
  /** apple_validation_category_01 (iOS 27+), when present. Logged, not enforced (see report/contract). */
  validationCategory?: number;
  /** apple_bundle_version_01 (iOS 27+), when present. */
  bundleVersion?: string;
}

/** Best-effort read of the iOS 27 authenticator-data extensions. Never throws. */
export function readSignals(extensions: unknown): AppAttestSignals {
  const out: AppAttestSignals = {};
  if (!(extensions instanceof Map)) return out;
  const cat = extensions.get('apple_validation_category_01');
  const catBytes = asBytes(cat);
  if (typeof cat === 'number' && Number.isInteger(cat)) out.validationCategory = cat;
  else if (catBytes && catBytes.length === 4) out.validationCategory = catBytes.readUInt32LE(0);
  const ver = extensions.get('apple_bundle_version_01');
  if (typeof ver === 'string' && ver.length <= 64) out.bundleVersion = ver;
  return out;
}

export interface VerifyAttestationParams {
  attestationObject: Buffer;
  /** Raw key identifier bytes (the app sends them base64-encoded). */
  keyId: Buffer;
  /** SHA-256 of the client data. For registration, SHA-256(nonce as UTF-8). */
  clientDataHash: Buffer;
  teamId: string;
  bundleId: string;
  env: AppAttestEnv;
  trustedRoot: X509Certificate;
  now: Date;
}

export interface VerifiedAttestation {
  keyId: Buffer;
  publicKeyPem: string;
  counter: 0;
  signals: AppAttestSignals;
}

/** Attestation object validation (registration). Throws AttestationFailure on any failed step. */
export function verifyAttestation(p: VerifyAttestationParams): VerifiedAttestation {
  if (p.attestationObject.length > MAX_ATTESTATION_OBJECT_BYTES) fail('ios_attestation_too_large');
  if (p.keyId.length !== 32) fail('ios_key_id_malformed');

  // CBOR structure: { fmt: "apple-appattest", attStmt: { x5c: [bytes...], receipt: bytes }, authData: bytes }
  const obj = decodeCbor(p.attestationObject, 'ios_attestation_malformed');
  if (!(obj instanceof Map)) fail('ios_attestation_malformed');
  if (obj.get('fmt') !== 'apple-appattest') fail('ios_attestation_wrong_format');
  const attStmt = obj.get('attStmt');
  const authDataRaw = asBytes(obj.get('authData'));
  if (!(attStmt instanceof Map) || !authDataRaw) fail('ios_attestation_malformed');
  const x5cRaw = attStmt.get('x5c');
  if (!Array.isArray(x5cRaw) || !asBytes(attStmt.get('receipt'))) fail('ios_attestation_malformed');
  const x5c = x5cRaw.map(asBytes);
  if (x5c.some((c) => !c)) fail('ios_attestation_malformed');

  // Step 1: certificate chain to Apple's App Attestation Root CA.
  const leaf = verifyChain(x5c as Buffer[], p.trustedRoot, p.now);

  // Steps 2-4: nonce = SHA-256(authData || clientDataHash) must equal the leaf's nonce extension.
  const nonce = sha256(authDataRaw, p.clientDataHash);
  let certNonce: Buffer;
  try {
    const ext = getCertificateExtension(leaf.raw, APP_ATTEST_NONCE_OID);
    if (!ext) return fail('ios_nonce_extension_missing');
    certNonce = parseAppAttestNonceExtension(ext);
  } catch (err) {
    if (err instanceof AttestationFailure) throw err;
    return fail('ios_nonce_extension_malformed');
  }
  if (!bytesEqual(certNonce, nonce)) fail('ios_nonce_mismatch');

  // Step 5: key identifier = SHA-256 of the leaf public key (X9.62 uncompressed point).
  const point = uncompressedP256(leaf.publicKey);
  if (!bytesEqual(sha256(point), p.keyId)) fail('ios_key_id_mismatch');

  const auth = parseAttestationAuthData(authDataRaw);
  // Step 6: RP ID hash = SHA-256("{teamId}.{bundleId}").
  if (!bytesEqual(auth.rpIdHash, appIdHash(p.teamId, p.bundleId))) fail('ios_app_id_mismatch');
  // Step 7: counter is 0.
  if (auth.counter !== 0) fail('ios_counter_not_zero');
  // Step 8: aaguid matches the configured environment.
  const expectedAaguid = p.env === 'development' ? AAGUID_DEVELOPMENT : AAGUID_PRODUCTION;
  if (!auth.aaguid || !bytesEqual(auth.aaguid, expectedAaguid)) fail('ios_aaguid_mismatch');
  // Step 9: credentialId = key identifier.
  if (!auth.credentialId || !bytesEqual(auth.credentialId, p.keyId)) fail('ios_credential_id_mismatch');
  // Hardening beyond Apple's list: the COSE key in authData is the certified key.
  checkCoseKey(auth.cosePublicKey, point);

  return {
    keyId: Buffer.from(p.keyId),
    publicKeyPem: leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    counter: 0,
    // Steps 10-11 (iOS 27+ extensions): read and returned for logging; see readSignals.
    signals: readSignals(auth.extensions),
  };
}

export interface VerifyAssertionParams {
  assertion: Buffer;
  /** For an SOS, the 32-byte binding hash h itself (PRD §7.4). */
  clientDataHash: Buffer;
  teamId: string;
  bundleId: string;
  publicKeyPem: string;
  previousCounter: number;
}

export interface VerifiedAssertion {
  counter: number;
  signals: AppAttestSignals;
}

/** Assertion validation (each SOS). Throws AttestationFailure on any failed step. */
export function verifyAssertion(p: VerifyAssertionParams): VerifiedAssertion {
  if (p.assertion.length > MAX_ASSERTION_BYTES) fail('ios_assertion_too_large');
  const obj = decodeCbor(p.assertion, 'ios_assertion_malformed');
  if (!(obj instanceof Map)) fail('ios_assertion_malformed');
  const signature = asBytes(obj.get('signature'));
  const authData = asBytes(obj.get('authenticatorData'));
  if (!signature || !authData || authData.length < 37) fail('ios_assertion_malformed');

  let key: KeyObject;
  try {
    key = createPublicKey(p.publicKeyPem);
  } catch {
    return fail('ios_stored_key_invalid');
  }

  // Steps 1-3: nonce = SHA-256(authenticatorData || clientDataHash); signature is ECDSA-SHA256 over nonce.
  const nonce = sha256(authData, p.clientDataHash);
  let valid = false;
  try {
    valid = createVerify('SHA256').update(nonce).verify(key, signature);
  } catch {
    valid = false;
  }
  if (!valid) fail('ios_signature_invalid');

  // Step 4: RP ID.
  if (!bytesEqual(authData.subarray(0, 32), appIdHash(p.teamId, p.bundleId))) fail('ios_app_id_mismatch');
  // Step 5: counter strictly increases.
  const counter = authData.readUInt32BE(33);
  if (!(counter > p.previousCounter)) fail('ios_counter_not_increasing');
  // Step 6 (challenge in client data): the client data hash *is* h, which binds the body and Idempotency-Key.

  // Steps 7-8 (iOS 27+ extensions): best effort, logged only. The bytes are covered by the signature.
  // As with attestations, the ED flag is not relied on; any trailing bytes are tried as extensions.
  let signals: AppAttestSignals = {};
  if (authData.length > 37) {
    try {
      const items = (cbor.decodeMultiple(authData.subarray(37)) as unknown[] | undefined) ?? [];
      signals = readSignals(items[items.length - 1]);
    } catch {
      signals = {};
    }
  }
  return { counter, signals };
}
