import { Writable } from 'node:stream';
import { pino } from 'pino';
import type { PublicApp } from '../../src/app.js';
import type {
  AttestationService,
  RegistrationInput,
  RegistrationOutcome,
} from '../../src/attestation/types.js';
import type { Logger } from '../../src/logger.js';
import type { Labels, MetricName, Metrics } from '../../src/metrics.js';

type Script = (input: RegistrationInput) => RegistrationOutcome | Promise<RegistrationOutcome>;

/** A fake AttestationService whose registration outcome is set per test. Records every call. */
export class ScriptedAttestation implements AttestationService {
  readonly calls: RegistrationInput[] = [];
  constructor(private script: Script = () => ({ accepted: true, attested: true })) {}

  set(script: Script): void {
    this.script = script;
  }

  async verifyRegistration(input: RegistrationInput): Promise<RegistrationOutcome> {
    this.calls.push(input);
    return this.script(input);
  }

  async verifyRequest(): Promise<never> {
    throw new Error('verifyRequest is not used by registration');
  }
}

export const accept = (): RegistrationOutcome => ({ accepted: true, attested: true });
export const refuse = (reason = 'android_verdict_device_integrity'): RegistrationOutcome => ({
  accepted: false,
  reason,
});
export const iosKey = (keyId: string, counter = 0): RegistrationOutcome => ({
  accepted: true,
  attested: true,
  ios: { keyId, publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${keyId}\n-----END PUBLIC KEY-----\n`, counter },
});

/** A logger at trace level, with no redaction, that keeps every line it writes. */
export function capturingLogger(): { log: Logger; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { log: pino({ level: 'trace' }, stream), text: () => lines.join('') };
}

export class RecordingMetrics implements Metrics {
  readonly counters: { name: MetricName; labels: Labels | undefined }[] = [];
  inc(name: MetricName, labels?: Labels): void {
    this.counters.push({ name, labels });
  }
  observe(): void {}
  set(): void {}
}

export const ANDROID_ATTESTATION = { integrityToken: 'play-integrity-token-for-tests' };
export const IOS_ATTESTATION = {
  keyId: 'a2V5LWlkLWZvci10ZXN0cw==',
  attestationObject: 'b2JqZWN0LWZvci10ZXN0cw==',
};

export async function getNonce(app: PublicApp): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/v1/devices/nonce' });
  if (res.statusCode !== 200) throw new Error(`nonce: ${res.statusCode} ${res.body}`);
  return res.json().nonce;
}

export interface RegisterOptions {
  platform?: 'android' | 'ios';
  nonce?: string;
  token?: string;
  ip?: string;
  body?: Record<string, unknown>;
}

export async function register(app: PublicApp, opts: RegisterOptions = {}) {
  const platform = opts.platform ?? 'android';
  const nonce = opts.nonce ?? (await getNonce(app));
  const body = opts.body ?? {
    platform,
    nonce,
    attestation: platform === 'android' ? ANDROID_ATTESTATION : IOS_ATTESTATION,
  };
  const headers: Record<string, string> = { 'x-real-ip': opts.ip ?? '203.0.113.7' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.inject({ method: 'POST', url: '/v1/devices/register', headers, payload: body });
}
