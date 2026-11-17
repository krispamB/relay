import { createHash } from 'node:crypto';

export const PACKAGE = 'org.example.sos';
export const NOW = new Date('2026-11-17T12:00:00.000Z');
/** A signing certificate digest, as the Play Console shows it (colon hex) and as Google returns it (base64url). */
export const CERT_BYTES = createHash('sha256').update('signing cert').digest();
export const CERT_COLON_HEX = [...CERT_BYTES]
  .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
  .join(':');
export const CERT_B64URL = CERT_BYTES.toString('base64url');

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
