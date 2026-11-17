/**
 * Google Play Integrity. PRD §7.2 (classic request at registration) and §7.4 (standard request per SOS).
 *
 * Tokens are decoded by Google (developer.android.com/google/play/integrity/{classic,standard,verdicts};
 * REST shape from the playintegrity v1 discovery document, retrieved 2026-11-17):
 *   POST https://playintegrity.googleapis.com/v1/{packageName}:decodeIntegrityToken
 *   body { "integrityToken": "..." }, scope https://www.googleapis.com/auth/playintegrity
 *   response { "tokenPayloadExternal": { requestDetails, appIntegrity, deviceIntegrity, accountDetails, ... } }
 */
import { timingSafeEqual } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { AttestationFailure } from './appAttest.js';

export const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
export const DEFAULT_DECODE_TIMEOUT_MS = 3000;
/** Standard tokens older than this are refused (PRD §7.4). */
export const MAX_TOKEN_AGE_MS = 5 * 60_000;
/** Tolerated clock skew for a token timestamp in the future. */
export const MAX_TOKEN_FUTURE_MS = 60_000;
/** Integrity tokens are a JWE compact serialisation; refuse anything implausible before calling Google. */
export const MAX_TOKEN_CHARS = 16 * 1024;

/** Decodes a token through Google. Returns `tokenPayloadExternal`. Rejects on network/HTTP errors and timeouts. */
export interface IntegrityTokenDecoder {
  decode(packageName: string, integrityToken: string): Promise<unknown>;
}

/** The slice of an authenticated Google client the decoder needs. Injectable for tests. */
export interface DecodeHttpClient {
  request(opts: {
    url: string;
    method: 'POST';
    data: unknown;
    timeout: number;
    retry: boolean;
    signal: AbortSignal;
  }): Promise<{ data: unknown }>;
}

export class DecodeTimeoutError extends Error {
  constructor() {
    super('decodeIntegrityToken timed out');
    this.name = 'DecodeTimeoutError';
  }
}

/**
 * Builds the production decoder from the service-account JSON. The timeout covers the whole call,
 * including fetching the OAuth access token. No retries: the caller is on an emergency request's path.
 */
export function createGoogleDecoder(
  serviceAccountJson: string,
  opts: { timeoutMs?: number; client?: () => Promise<DecodeHttpClient> } = {},
): IntegrityTokenDecoder {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
  let getClient = opts.client;
  if (!getClient) {
    const auth = new GoogleAuth({
      credentials: JSON.parse(serviceAccountJson),
      scopes: [PLAY_INTEGRITY_SCOPE],
    });
    getClient = async () => (await auth.getClient()) as unknown as DecodeHttpClient;
  }
  const clientFactory = getClient;
  return {
    async decode(packageName, integrityToken) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DecodeTimeoutError());
        }, timeoutMs);
      });
      const call = (async () => {
        const client = await clientFactory();
        const res = await client.request({
          url: `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
          method: 'POST',
          data: { integrityToken },
          timeout: timeoutMs,
          retry: false,
          signal: controller.signal,
        });
        const data = res.data as { tokenPayloadExternal?: unknown } | null;
        return data?.tokenPayloadExternal;
      })();
      call.catch(() => {}); // a late rejection after the timeout must not become unhandled
      try {
        return await Promise.race([call, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function fail(reason: string): never {
  throw new AttestationFailure(reason);
}

/**
 * Normalises a SHA-256 certificate digest to its 32 raw bytes. Accepts hex with or without colons
 * (as shown in the Play Console) and base64 / base64url with or without padding (as Google returns it).
 * Returns undefined for anything else.
 */
export function normaliseCertDigest(input: string): Buffer | undefined {
  const s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s) || /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/.test(s)) {
    return Buffer.from(s.replace(/:/g, ''), 'hex');
  }
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const urlSafe = s.replace(/=$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const b = Buffer.from(urlSafe, 'base64url');
    // Round-trip check rejects non-canonical trailing bits.
    if (b.length === 32 && b.toString('base64url') === urlSafe) return b;
  }
  return undefined;
}

/** Cheap shape check before spending a Google call on it. */
export function isPlausibleToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length >= 16 &&
    token.length <= MAX_TOKEN_CHARS &&
    /^[A-Za-z0-9_\-.=]+$/.test(token)
  );
}

function strEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export interface VerdictPolicy {
  packageName: string;
  /** Allowed signing-certificate digests, already normalised to 32 bytes each. */
  certDigests: Buffer[];
}

export type VerdictBinding =
  | { kind: 'classic'; nonce: string }
  | { kind: 'standard'; requestHashHex: string; now: Date };

export interface VerdictSignals {
  versionCode?: string;
  appLicensingVerdict?: string;
}

/** Checks a decoded `tokenPayloadExternal`. Throws AttestationFailure on any failed check. */
export function checkVerdict(
  payload: unknown,
  policy: VerdictPolicy,
  binding: VerdictBinding,
): VerdictSignals {
  const p = obj(payload);
  if (!p) fail('android_payload_malformed');
  const req = obj(p.requestDetails);
  const app = obj(p.appIntegrity);
  const device = obj(p.deviceIntegrity);
  if (!req || !app || !device) fail('android_payload_malformed');

  // Test verdicts configured in the Play Console are not real attestations.
  const testing = obj(p.testingDetails);
  if (testing && testing.isTestingResponse === true) fail('android_testing_response');

  // Request details: package, binding, freshness.
  if (typeof req.requestPackageName !== 'string' || !strEqual(req.requestPackageName, policy.packageName)) {
    fail('android_request_package_mismatch');
  }
  if (binding.kind === 'classic') {
    // Google returns the nonce as the app supplied it (base64 web-safe, no wrap); ignore padding only.
    if (
      typeof req.nonce !== 'string' ||
      !strEqual(req.nonce.replace(/=+$/, ''), binding.nonce.replace(/=+$/, ''))
    ) {
      fail('android_nonce_mismatch');
    }
  } else {
    if (typeof req.requestHash !== 'string' || !strEqual(req.requestHash, binding.requestHashHex)) {
      fail('android_request_hash_mismatch');
    }
    const ts =
      typeof req.timestampMillis === 'string' && /^\d{1,16}$/.test(req.timestampMillis)
        ? Number(req.timestampMillis)
        : typeof req.timestampMillis === 'number' &&
            Number.isSafeInteger(req.timestampMillis) &&
            req.timestampMillis >= 0
          ? req.timestampMillis
          : Number.NaN;
    if (Number.isNaN(ts)) fail('android_timestamp_malformed');
    const age = binding.now.getTime() - ts;
    if (age > MAX_TOKEN_AGE_MS) fail('android_token_stale');
    if (age < -MAX_TOKEN_FUTURE_MS) fail('android_token_in_future');
  }

  // App integrity.
  if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') fail('android_app_not_play_recognized');
  if (typeof app.packageName !== 'string' || !strEqual(app.packageName, policy.packageName)) {
    fail('android_package_mismatch');
  }
  const digests = app.certificateSha256Digest;
  if (!Array.isArray(digests) || digests.length === 0) fail('android_cert_digest_missing');
  for (const d of digests) {
    const n = typeof d === 'string' ? normaliseCertDigest(d) : undefined;
    // Every signing certificate in the verdict must be one we configured.
    if (!n || !policy.certDigests.some((c) => c.length === n.length && timingSafeEqual(c, n))) {
      fail('android_cert_digest_mismatch');
    }
  }

  // Device integrity.
  const labels = device.deviceRecognitionVerdict;
  if (!Array.isArray(labels) || !labels.includes('MEETS_DEVICE_INTEGRITY')) fail('android_device_integrity');

  const account = obj(p.accountDetails);
  const signals: VerdictSignals = {};
  if (typeof app.versionCode === 'string') signals.versionCode = app.versionCode;
  if (typeof account?.appLicensingVerdict === 'string')
    signals.appLicensingVerdict = account.appLicensingVerdict;
  return signals;
}
