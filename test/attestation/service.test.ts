import { Writable } from 'node:stream';
import { pino } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IntegrityTokenDecoder } from '../../src/attestation/playIntegrity.js';
import { createAttestationService } from '../../src/attestation/service.js';
import type { AttestationService, RegistrationInput, RequestInput } from '../../src/attestation/types.js';
import { FakeClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { bindingHash } from '../../src/crypto.js';
import { REDACT_PATHS } from '../../src/logger.js';
import { type Labels, METRICS, type MetricName, type Metrics } from '../../src/metrics.js';
import {
  BUNDLE_ID,
  type IosWorld,
  makeAssertion,
  makeAttestation,
  makeIosWorld,
  sha256,
  TEAM_ID,
} from './fixtures.js';
import { CERT_COLON_HEX, NOW, PACKAGE, verdict } from './playFixtures.js';

const NONCE = 'c2VydmVyLW5vbmNlLXZhbHVlLTMyLWJ5dGVz';
const IDEM = '5b0c3f2e-8a51-4f3c-9d7e-0a1b2c3d4e5f';
const BODY = Buffer.from('{"intakeCode":"demo","nature":"fire","phone":"+15550100"}');
const H = bindingHash(IDEM, BODY);
const ANDROID_TOKEN = 'eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.SECRET-TOKEN-MATERIAL.x.y.z';

class RecordingMetrics implements Metrics {
  counts: { name: MetricName; labels?: Labels }[] = [];
  inc(name: MetricName, labels?: Labels): void {
    this.counts.push({ name, labels });
  }
  observe(): void {}
  set(): void {}
}

function harness(
  cfgOver: Partial<Config['attestation']>,
  opts: { decoder?: IntegrityTokenDecoder; rootPem?: string } = {},
): { svc: AttestationService; logs: string[]; metrics: RecordingMetrics } {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: 'debug', redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
  const metrics = new RecordingMetrics();
  const cfg: Config['attestation'] = {
    mode: 'enforce',
    androidPackageName: PACKAGE,
    androidCertSha256: [CERT_COLON_HEX],
    googleServiceAccountJson: undefined,
    iosTeamId: TEAM_ID,
    iosBundleId: BUNDLE_ID,
    iosAppAttestEnv: 'production',
    ...cfgOver,
  };
  const svc = createAttestationService(cfg, {
    clock: new FakeClock(NOW),
    log,
    metrics,
    playDecoder: opts.decoder,
    appleRootPem: opts.rootPem,
  });
  return { svc, logs, metrics };
}

/** Stands in for Google: maps known tokens to verdicts, as decodeIntegrityToken would. */
function fakeGoogle(table: Record<string, unknown>): IntegrityTokenDecoder & { calls: number } {
  const d = {
    calls: 0,
    async decode(pkg: string, token: string) {
      d.calls++;
      if (pkg !== PACKAGE) throw new Error('wrong package');
      if (!(token in table)) {
        // Like a gaxios error: carries the request body, which must never reach the log.
        throw Object.assign(new Error(`400 bad token ${token}`), {
          response: { status: 400 },
          config: { data: token },
        });
      }
      return table[token];
    },
  };
  return d;
}

const classicOk = verdict({ requestDetails: { nonce: NONCE } });
const standardOk = verdict({ requestDetails: { requestHash: H.toString('hex') } });
const google = () =>
  fakeGoogle({
    [`${ANDROID_TOKEN}.classic`]: classicOk,
    [`${ANDROID_TOKEN}.standard`]: standardOk,
    [`${ANDROID_TOKEN}.bad`]: verdict({
      requestDetails: { nonce: NONCE },
      deviceIntegrity: { deviceRecognitionVerdict: [] },
    }),
  });

const androidRegister = (token: string | undefined): RegistrationInput => ({
  platform: 'android',
  nonce: NONCE,
  attestation: token === undefined ? undefined : { integrityToken: token },
});
const androidSos = (token: string | undefined, h = H): RequestInput => ({
  platform: 'android',
  attestation: token,
  bindingHash: h,
  device: { iosPublicKeyPem: null, iosCounter: 0 },
});

describe('attestation service', () => {
  let world: IosWorld;
  let iosObject: string;
  let keyIdB64: string;

  beforeAll(async () => {
    world = await makeIosWorld(NOW);
    iosObject = (await makeAttestation(world, { nonce: NONCE })).toString('base64');
    keyIdB64 = world.leafKey.keyId.toString('base64');
  });

  const iosRegister = (
    over: Partial<NonNullable<RegistrationInput['attestation']>> | null = {},
  ): RegistrationInput => ({
    platform: 'ios',
    nonce: NONCE,
    attestation: over === null ? undefined : { keyId: keyIdB64, attestationObject: iosObject, ...over },
  });
  const iosSos = (attestation: string | undefined, pem: string | null, counter = 0, h = H): RequestInput => ({
    platform: 'ios',
    attestation,
    bindingHash: h,
    device: { iosPublicKeyPem: pem, iosCounter: counter },
  });

  describe('enforce mode', () => {
    it('iOS: registers, then accepts an SOS assertion bound to the body, then refuses a replayed counter', async () => {
      const { svc, metrics } = harness({}, { rootPem: world.root.pem });
      const reg = await svc.verifyRegistration(iosRegister());
      expect(reg).toMatchObject({ accepted: true, attested: true, ios: { keyId: keyIdB64, counter: 0 } });
      const pem = reg.accepted ? (reg.ios?.publicKeyPem ?? null) : null;

      const assertion = makeAssertion(world.leafKey.privateKey, H, { counter: 1 }).toString('base64');
      expect(await svc.verifyRequest(iosSos(assertion, pem, 0))).toEqual({
        accepted: true,
        attested: true,
        iosCounter: 1,
      });
      expect(await svc.verifyRequest(iosSos(assertion, pem, 1))).toEqual({
        accepted: false,
        reason: 'ios_counter_not_increasing',
      });
      // Same assertion presented for a different body.
      const otherH = bindingHash(IDEM, Buffer.from('{"intakeCode":"demo","nature":"flood"}'));
      expect(await svc.verifyRequest(iosSos(assertion, pem, 0, otherH))).toEqual({
        accepted: false,
        reason: 'ios_signature_invalid',
      });
      expect(metrics.counts.map((c) => c.labels)).toEqual([
        { platform: 'ios', phase: 'register', result: 'ok' },
        { platform: 'ios', phase: 'request', result: 'ok' },
        { platform: 'ios', phase: 'request', result: 'failed' },
        { platform: 'ios', phase: 'request', result: 'failed' },
      ]);
      expect(metrics.counts.every((c) => c.name === METRICS.attestations)).toBe(true);
    });

    it('iOS: registration uses SHA-256 of the server nonce as clientDataHash', async () => {
      const { svc } = harness({}, { rootPem: world.root.pem });
      expect(await svc.verifyRegistration({ ...iosRegister(), nonce: 'a-different-nonce' })).toEqual({
        accepted: false,
        reason: 'ios_nonce_mismatch',
      });
    });

    it('iOS: refuses Apple-rooted verification of a self-made chain (default root is Apple)', async () => {
      const { svc } = harness({});
      expect(await svc.verifyRegistration(iosRegister())).toEqual({
        accepted: false,
        reason: 'ios_chain_untrusted',
      });
    });

    it('iOS: an SOS from a device with no registered key fails', async () => {
      const { svc } = harness({}, { rootPem: world.root.pem });
      const assertion = makeAssertion(world.leafKey.privateKey, H, { counter: 1 }).toString('base64');
      expect(await svc.verifyRequest(iosSos(assertion, null))).toEqual({
        accepted: false,
        reason: 'ios_no_registered_key',
      });
    });

    it('Android: accepts a classic registration and a standard SOS token', async () => {
      const g = google();
      const { svc } = harness({}, { decoder: g });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.classic`))).toEqual({
        accepted: true,
        attested: true,
      });
      expect(await svc.verifyRequest(androidSos(`${ANDROID_TOKEN}.standard`))).toEqual({
        accepted: true,
        attested: true,
      });
      // A registration token is not an SOS token, and vice versa.
      expect(await svc.verifyRequest(androidSos(`${ANDROID_TOKEN}.classic`))).toEqual({
        accepted: false,
        reason: 'android_request_hash_mismatch',
      });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.standard`))).toEqual({
        accepted: false,
        reason: 'android_nonce_mismatch',
      });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.bad`))).toEqual({
        accepted: false,
        reason: 'android_device_integrity',
      });
    });

    it('Android: a Google error or timeout is a failure, and the token never reaches the log', async () => {
      const { svc, logs } = harness({}, { decoder: google() });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.unknown`))).toEqual({
        accepted: false,
        reason: 'android_decode_http_400',
      });
      const slow: IntegrityTokenDecoder = {
        decode: async () => {
          const { DecodeTimeoutError } = await import('../../src/attestation/playIntegrity.js');
          throw new DecodeTimeoutError();
        },
      };
      const t = harness({}, { decoder: slow });
      expect(await t.svc.verifyRequest(androidSos(`${ANDROID_TOKEN}.standard`))).toEqual({
        accepted: false,
        reason: 'android_decode_timeout',
      });
      expect(logs.join('')).not.toContain('SECRET-TOKEN-MATERIAL');
      expect(logs.join('')).toContain('android_decode_http_400');
    });

    it('never logs the iOS attestation object or assertion', async () => {
      const { svc, logs } = harness({}, { rootPem: world.root.pem });
      await svc.verifyRegistration(iosRegister());
      await svc.verifyRegistration(iosRegister({ keyId: Buffer.alloc(32, 7).toString('base64') }));
      const assertion = makeAssertion(world.leafKey.privateKey, H, { counter: 1 }).toString('base64');
      await svc.verifyRequest(iosSos(assertion, null));
      const all = logs.join('');
      expect(all).not.toContain(iosObject.slice(0, 40));
      expect(all).not.toContain(assertion.slice(0, 40));
      expect(all).not.toContain(keyIdB64);
    });

    it('missing attestation is refused on both platforms and both phases', async () => {
      const { svc, metrics } = harness({}, { rootPem: world.root.pem, decoder: google() });
      expect(await svc.verifyRegistration(androidRegister(undefined))).toMatchObject({ accepted: false });
      expect(await svc.verifyRegistration(iosRegister(null))).toMatchObject({ accepted: false });
      expect(await svc.verifyRequest(androidSos(undefined))).toMatchObject({ accepted: false });
      expect(await svc.verifyRequest(iosSos(undefined, 'pem'))).toMatchObject({ accepted: false });
      expect(metrics.counts.map((c) => c.labels?.result)).toEqual([
        'missing',
        'missing',
        'missing',
        'missing',
      ]);
    });

    it('a platform without configuration cannot attest', async () => {
      const g = google();
      const { svc } = harness(
        { androidPackageName: undefined, iosTeamId: undefined },
        { decoder: g, rootPem: world.root.pem },
      );
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.classic`))).toEqual({
        accepted: false,
        reason: 'android_not_configured',
      });
      expect(await svc.verifyRegistration(iosRegister())).toEqual({
        accepted: false,
        reason: 'ios_not_configured',
      });
      expect(g.calls).toBe(0);
    });

    it('Android without a service account (and no injected decoder) cannot attest', async () => {
      const { svc } = harness({ googleServiceAccountJson: undefined });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.classic`))).toEqual({
        accepted: false,
        reason: 'android_not_configured',
      });
    });

    it('a malformed configured certificate digest disables Android rather than weakening it', async () => {
      const { svc, logs } = harness(
        { androidCertSha256: [CERT_COLON_HEX, 'not-a-digest'] },
        { decoder: google() },
      );
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.classic`))).toEqual({
        accepted: false,
        reason: 'android_not_configured',
      });
      expect(logs.join('')).toContain('ANDROID_CERT_SHA256');
    });

    it('turns malformed input into clean failures, never exceptions', async () => {
      const { svc } = harness({}, { rootPem: world.root.pem, decoder: google() });
      const weird = [
        iosRegister({ attestationObject: 'not base64 !!' }),
        iosRegister({ attestationObject: Buffer.from('garbage').toString('base64') }),
        iosRegister({ attestationObject: iosObject.slice(0, 200) }),
        iosRegister({ keyId: 'short' }),
        iosRegister({ keyId: 12 as unknown as string }),
        iosRegister({ attestationObject: undefined }),
        iosRegister({ keyId: undefined }),
        { platform: 'ios', nonce: NONCE, attestation: 'oops' } as unknown as RegistrationInput,
        androidRegister(''),
        androidRegister('{"not":"a token"}'),
        {
          platform: 'android',
          nonce: NONCE,
          attestation: { integrityToken: 42 },
        } as unknown as RegistrationInput,
        { platform: 'windows', nonce: NONCE, attestation: {} } as unknown as RegistrationInput,
        { platform: 'ios', nonce: undefined, attestation: {} } as unknown as RegistrationInput,
      ];
      for (const input of weird) {
        const out = await svc.verifyRegistration(input);
        expect(out.accepted).toBe(false);
      }
      const pem = 'not a pem';
      const weirdSos: RequestInput[] = [
        iosSos('not base64 !!', pem),
        iosSos(Buffer.from('garbage').toString('base64'), pem),
        iosSos(makeAssertion(world.leafKey.privateKey, H, { counter: 1 }).toString('base64'), pem),
        iosSos('AAAA', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', Number.NaN),
        androidSos(`${ANDROID_TOKEN}.standard`, Buffer.alloc(5)),
        androidSos(`${ANDROID_TOKEN}.standard`, 'h' as unknown as Buffer),
        {
          platform: 'ios',
          attestation: 'AAAA',
          bindingHash: H,
          device: undefined,
        } as unknown as RequestInput,
      ];
      for (const input of weirdSos) {
        const out = await svc.verifyRequest(input);
        expect(out.accepted).toBe(false);
      }
    });
  });

  describe('permissive mode', () => {
    it('accepts and marks attested when verification succeeds', async () => {
      const { svc } = harness({ mode: 'permissive' }, { rootPem: world.root.pem, decoder: google() });
      expect(await svc.verifyRegistration(iosRegister())).toMatchObject({ accepted: true, attested: true });
      expect(await svc.verifyRequest(androidSos(`${ANDROID_TOKEN}.standard`))).toEqual({
        accepted: true,
        attested: true,
      });
    });

    it('accepts but marks unattested when verification fails, and logs why', async () => {
      const { svc, logs, metrics } = harness({ mode: 'permissive' }, { decoder: google() });
      // Default (Apple) root: the self-made chain does not verify.
      expect(await svc.verifyRegistration(iosRegister())).toEqual({ accepted: true, attested: false });
      expect(await svc.verifyRegistration(androidRegister(`${ANDROID_TOKEN}.bad`))).toEqual({
        accepted: true,
        attested: false,
      });
      expect(await svc.verifyRequest(iosSos('garbage!!', null))).toEqual({ accepted: true, attested: false });
      const all = logs.join('');
      expect(all).toContain('ios_chain_untrusted');
      expect(all).toContain('android_device_integrity');
      expect(metrics.counts.map((c) => c.labels?.result)).toEqual(['failed', 'failed', 'failed']);
    });

    it('accepts with no attestation at all, on both platforms and phases', async () => {
      const { svc, metrics } = harness(
        { mode: 'permissive' },
        { rootPem: world.root.pem, decoder: google() },
      );
      expect(await svc.verifyRegistration(androidRegister(undefined))).toEqual({
        accepted: true,
        attested: false,
      });
      expect(await svc.verifyRegistration(iosRegister(null))).toEqual({ accepted: true, attested: false });
      expect(await svc.verifyRequest(androidSos(undefined))).toEqual({ accepted: true, attested: false });
      expect(await svc.verifyRequest(iosSos(undefined, null))).toEqual({ accepted: true, attested: false });
      expect(metrics.counts.map((c) => c.labels?.result)).toEqual([
        'missing',
        'missing',
        'missing',
        'missing',
      ]);
    });

    it('accepts unattested when the platform is not configured', async () => {
      const { svc } = harness({ mode: 'permissive', iosTeamId: undefined, androidPackageName: undefined });
      expect(await svc.verifyRegistration(iosRegister())).toEqual({ accepted: true, attested: false });
      expect(await svc.verifyRequest(androidSos(`${ANDROID_TOKEN}.standard`))).toEqual({
        accepted: true,
        attested: false,
      });
    });
  });

  it('binds an SOS to the Idempotency-Key as well as the body', async () => {
    const { svc } = harness({}, { rootPem: world.root.pem });
    const reg = await svc.verifyRegistration(iosRegister());
    const pem = reg.accepted ? (reg.ios?.publicKeyPem ?? null) : null;
    const assertion = makeAssertion(world.leafKey.privateKey, H, { counter: 1 }).toString('base64');
    const otherKey = bindingHash('11111111-2222-4333-8444-555555555555', BODY);
    expect(await svc.verifyRequest(iosSos(assertion, pem, 0, otherKey))).toMatchObject({ accepted: false });
    expect(sha256(IDEM, '\n', BODY).equals(H)).toBe(true);
  });
});
