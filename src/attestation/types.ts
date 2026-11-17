/** Attestation contract. See sos-relay-PRD.md §7.2, §7.4, §10.1. */
import type { Platform } from '../db/types.js';

export interface RegistrationInput {
  platform: Platform;
  /** The server nonce, already checked as issued, unexpired and unused by the route. */
  nonce: string;
  /** android: { integrityToken }, ios: { keyId, attestationObject }. May be undefined in permissive mode. */
  attestation: { integrityToken?: string; keyId?: string; attestationObject?: string } | undefined;
}

export type RegistrationOutcome =
  | {
      accepted: true;
      /** False only in permissive mode, when verification failed or nothing was sent. */
      attested: boolean;
      ios?: { keyId: string; publicKeyPem: string; counter: number };
    }
  | { accepted: false; reason: string };

export interface RequestInput {
  platform: Platform;
  /** Value of the X-Attestation header (base64), if any. */
  attestation: string | undefined;
  /** h = SHA-256(Idempotency-Key + "\n" + raw body). 32 bytes. */
  bindingHash: Buffer;
  device: { iosPublicKeyPem: string | null; iosCounter: number };
}

export type RequestOutcome =
  | {
      accepted: true;
      attested: boolean;
      /** iOS only, when verified: the new counter to store. */
      iosCounter?: number;
    }
  | { accepted: false; reason: string };

/**
 * Applies the attestation mode itself: in "enforce" a failure is { accepted: false };
 * in "permissive" a failure or a missing attestation is { accepted: true, attested: false }.
 * The reason is for logs only and is never shown to the caller.
 */
export interface AttestationService {
  verifyRegistration(input: RegistrationInput): Promise<RegistrationOutcome>;
  verifyRequest(input: RequestInput): Promise<RequestOutcome>;
}
