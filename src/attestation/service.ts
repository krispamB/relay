/**
 * The attestation service: runs the platform verifiers and applies ATTESTATION_MODE (PRD §10.1).
 * Never throws to the caller; never logs tokens or attestation payloads.
 */
import type { X509Certificate } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { sha256 } from '../crypto.js';
import type { Logger } from '../logger.js';
import { METRICS, type Metrics } from '../metrics.js';
import {
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  type AppAttestSignals,
  AttestationFailure,
  decodeBase64Strict,
  MAX_ASSERTION_BYTES,
  MAX_ATTESTATION_OBJECT_BYTES,
  parseTrustedRoot,
  verifyAssertion,
  verifyAttestation,
} from './appAttest.js';
import {
  checkVerdict,
  createGoogleDecoder,
  DecodeTimeoutError,
  type IntegrityTokenDecoder,
  isPlausibleToken,
  normaliseCertDigest,
  type VerdictBinding,
  type VerdictPolicy,
} from './playIntegrity.js';
import type {
  AttestationService,
  RegistrationInput,
  RegistrationOutcome,
  RequestInput,
  RequestOutcome,
} from './types.js';

export interface AttestationDeps {
  clock: Clock;
  log: Logger;
  metrics: Metrics;
  /** Replaces the Google decodeIntegrityToken call (tests). Default: built from GOOGLE_SERVICE_ACCOUNT_JSON. */
  playDecoder?: IntegrityTokenDecoder;
  /** Replaces Apple's App Attestation Root CA (tests). PEM. */
  appleRootPem?: string;
}

type Phase = 'register' | 'request';
type Check<T> =
  | { ok: true; value: T; signals?: Record<string, unknown> }
  | { ok: false; missing: boolean; reason: string };

const missing = (reason: string) => ({ ok: false as const, missing: true, reason });

interface IosSetup {
  teamId: string;
  bundleId: string;
  env: 'production' | 'development';
  root: X509Certificate;
}

interface AndroidSetup {
  policy: VerdictPolicy;
  decoder: IntegrityTokenDecoder;
}

export function createAttestationService(
  cfg: Config['attestation'],
  deps: AttestationDeps,
): AttestationService {
  const { clock, log, metrics } = deps;
  const ios = setupIos(cfg, deps);
  const android = setupAndroid(cfg, deps);

  async function run<T>(platform: unknown, phase: Phase, fn: () => Promise<Check<T>>): Promise<Check<T>> {
    let result: Check<T>;
    try {
      result = await fn();
    } catch (err) {
      result = { ok: false, missing: false, reason: reasonFor(err, platform) };
    }
    const plat = platform === 'ios' || platform === 'android' ? platform : 'unknown';
    const outcome = result.ok ? 'ok' : result.missing ? 'missing' : 'failed';
    metrics.inc(METRICS.attestations, { platform: plat, phase, result: outcome });
    // Only codes and small enumerated signals are logged; never the token or payload.
    const fields = {
      attestationPlatform: plat,
      attestationPhase: phase,
      attestationResult: outcome,
      attestationMode: cfg.mode,
      ...(result.ok ? { attestationSignals: result.signals } : { attestationReason: result.reason }),
    };
    if (result.ok) log.info(fields, 'attestation verified');
    else log.warn(fields, 'attestation not verified');
    return result;
  }

  return {
    async verifyRegistration(input: RegistrationInput): Promise<RegistrationOutcome> {
      const r = await run(input?.platform, 'register', () => registration(input));
      if (r.ok) return { accepted: true, attested: true, ...(r.value ? { ios: r.value } : {}) };
      return cfg.mode === 'permissive'
        ? { accepted: true, attested: false }
        : { accepted: false, reason: r.reason };
    },

    async verifyRequest(input: RequestInput): Promise<RequestOutcome> {
      const r = await run(input?.platform, 'request', () => request(input));
      if (r.ok)
        return { accepted: true, attested: true, ...(r.value !== undefined ? { iosCounter: r.value } : {}) };
      return cfg.mode === 'permissive'
        ? { accepted: true, attested: false }
        : { accepted: false, reason: r.reason };
    },
  };

  async function registration(
    input: RegistrationInput,
  ): Promise<Check<{ keyId: string; publicKeyPem: string; counter: number } | undefined>> {
    const att = input.attestation;
    if (typeof input.nonce !== 'string' || input.nonce.length === 0) return fail('nonce_missing');
    if (input.platform === 'android') {
      if (att === undefined || att === null || att.integrityToken === undefined)
        return missing('android_token_missing');
      if (!android) return fail('android_not_configured');
      const signals = await decodeAndCheck(android, att.integrityToken, {
        kind: 'classic',
        nonce: input.nonce,
      });
      return { ok: true, value: undefined, signals: { ...signals } };
    }
    if (input.platform === 'ios') {
      if (
        att === undefined ||
        att === null ||
        (att.attestationObject === undefined && att.keyId === undefined)
      ) {
        return missing('ios_attestation_missing');
      }
      if (!ios) return fail('ios_not_configured');
      const keyId = decodeBase64Strict(att.keyId, 64);
      if (!keyId) return fail('ios_key_id_malformed');
      const object = decodeBase64Strict(att.attestationObject, MAX_ATTESTATION_OBJECT_BYTES);
      if (!object) return fail('ios_attestation_malformed');
      const v = verifyAttestation({
        attestationObject: object,
        keyId,
        clientDataHash: sha256Utf8(input.nonce),
        teamId: ios.teamId,
        bundleId: ios.bundleId,
        env: ios.env,
        trustedRoot: ios.root,
        now: clock.now(),
      });
      return {
        ok: true,
        value: { keyId: v.keyId.toString('base64'), publicKeyPem: v.publicKeyPem, counter: v.counter },
        signals: signalFields(v.signals),
      };
    }
    return fail('platform_unknown');
  }

  async function request(input: RequestInput): Promise<Check<number | undefined>> {
    if (!Buffer.isBuffer(input.bindingHash) || input.bindingHash.length !== 32)
      return fail('binding_hash_invalid');
    if (input.platform === 'android') {
      if (input.attestation === undefined || input.attestation === null || input.attestation === '') {
        return missing('android_token_missing');
      }
      if (!android) return fail('android_not_configured');
      const signals = await decodeAndCheck(android, input.attestation, {
        kind: 'standard',
        requestHashHex: input.bindingHash.toString('hex'),
        now: clock.now(),
      });
      return { ok: true, value: undefined, signals: { ...signals } };
    }
    if (input.platform === 'ios') {
      if (input.attestation === undefined || input.attestation === null || input.attestation === '') {
        return missing('ios_assertion_missing');
      }
      if (!ios) return fail('ios_not_configured');
      const pem = input.device?.iosPublicKeyPem;
      if (typeof pem !== 'string' || pem.length === 0) return fail('ios_no_registered_key');
      const counter = input.device.iosCounter;
      if (!Number.isSafeInteger(counter) || counter < 0) return fail('ios_stored_counter_invalid');
      const assertion = decodeBase64Strict(input.attestation, MAX_ASSERTION_BYTES);
      if (!assertion) return fail('ios_assertion_malformed');
      const v = verifyAssertion({
        assertion,
        clientDataHash: input.bindingHash,
        teamId: ios.teamId,
        bundleId: ios.bundleId,
        publicKeyPem: pem,
        previousCounter: counter,
      });
      return { ok: true, value: v.counter, signals: signalFields(v.signals) };
    }
    return fail('platform_unknown');
  }

  async function decodeAndCheck(setup: AndroidSetup, token: unknown, binding: VerdictBinding) {
    if (!isPlausibleToken(token)) throw new AttestationFailure('android_token_malformed');
    let payload: unknown;
    try {
      payload = await setup.decoder.decode(setup.policy.packageName, token);
    } catch (err) {
      // Never log the error object: Google client errors carry the request body, i.e. the token.
      throw new AttestationFailure(
        err instanceof DecodeTimeoutError ? 'android_decode_timeout' : decodeReason(err),
      );
    }
    return checkVerdict(payload, setup.policy, binding);
  }

  function setupIos(c: Config['attestation'], d: AttestationDeps): IosSetup | undefined {
    if (!c.iosTeamId || !c.iosBundleId) return undefined;
    try {
      return {
        teamId: c.iosTeamId,
        bundleId: c.iosBundleId,
        env: c.iosAppAttestEnv,
        root: parseTrustedRoot(d.appleRootPem ?? APPLE_APP_ATTESTATION_ROOT_CA_PEM),
      };
    } catch (err) {
      d.log.error({ err: (err as Error).message }, 'App Attest root unusable: iOS cannot attest');
      return undefined;
    }
  }

  function setupAndroid(c: Config['attestation'], d: AttestationDeps): AndroidSetup | undefined {
    if (!c.androidPackageName || c.androidCertSha256.length === 0) return undefined;
    const digests = c.androidCertSha256.map(normaliseCertDigest);
    if (digests.some((x) => x === undefined)) {
      d.log.error('ANDROID_CERT_SHA256 has an entry that is not a SHA-256 digest: Android cannot attest');
      return undefined;
    }
    let decoder = d.playDecoder;
    if (!decoder) {
      if (!c.googleServiceAccountJson) return undefined;
      try {
        decoder = createGoogleDecoder(c.googleServiceAccountJson);
      } catch {
        d.log.error('GOOGLE_SERVICE_ACCOUNT_JSON is unusable: Android cannot attest');
        return undefined;
      }
    }
    return { policy: { packageName: c.androidPackageName, certDigests: digests as Buffer[] }, decoder };
  }
}

function fail(reason: string) {
  return { ok: false as const, missing: false, reason };
}

/** Registration client data is the server nonce: clientDataHash = SHA-256(nonce as UTF-8). */
function sha256Utf8(s: string): Buffer {
  return sha256(Buffer.from(s, 'utf8'));
}

function signalFields(s: AppAttestSignals): Record<string, unknown> {
  return { ...s };
}

function reasonFor(err: unknown, platform: unknown): string {
  if (err instanceof AttestationFailure) return err.reason;
  return `${platform === 'ios' || platform === 'android' ? platform : 'unknown'}_internal_error`;
}

function decodeReason(err: unknown): string {
  const status = (err as { status?: unknown; response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? `android_decode_http_${status}` : 'android_decode_failed';
}
