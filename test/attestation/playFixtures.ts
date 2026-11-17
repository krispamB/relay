import { createHash } from 'node:crypto';

export const PACKAGE = 'org.example.sos';
export const NOW = new Date('2026-11-17T12:00:00.000Z');
/** A signing certificate digest, as the Play Console shows it (colon hex) and as Google returns it (base64url). */
export const CERT_BYTES = createHash('sha256').update('signing cert').digest();
export const CERT_COLON_HEX = [...CERT_BYTES]
  .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
  .join(':');
export const CERT_B64URL = CERT_BYTES.toString('base64url');

/**
 * A string shaped like a Play Integrity token (a JWE in compact form: five dot-separated parts),
 * built at run time so no token-shaped literal sits in the source for secret scanners to flag.
 * It carries no key material and decrypts to nothing.
 */
export function fakeJweToken(...parts: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'A256KW', enc: 'A256GCM' })).toString('base64url');
  return [header, ...parts].join('.');
}

export function verdict(
  over: {
    requestDetails?: Record<string, unknown>;
    appIntegrity?: Record<string, unknown>;
    deviceIntegrity?: Record<string, unknown>;
    testingDetails?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    requestDetails: {
      requestPackageName: PACKAGE,
      timestampMillis: String(NOW.getTime() - 2000),
      ...over.requestDetails,
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: PACKAGE,
      certificateSha256Digest: [CERT_B64URL],
      versionCode: '42',
      ...over.appIntegrity,
    },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'], ...over.deviceIntegrity },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    ...(over.testingDetails ? { testingDetails: over.testingDetails } : {}),
  };
}
