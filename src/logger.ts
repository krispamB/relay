import { type DestinationStream, type Logger, pino } from 'pino';

export type { Logger };

/** PRD §10.4. Secrets never reach the log, whatever object they arrive in. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-status-token"]',
  'req.headers["x-attestation"]',
  'req.headers["x-resgrid-apikey"]',
  'headers.authorization',
  'headers["x-status-token"]',
  'headers["x-attestation"]',
  'headers["X-Resgrid-ApiKey"]',
  'headers["x-resgrid-apikey"]',
  'apiKey',
  '*.apiKey',
  'deviceToken',
  'statusToken',
  'attestation',
  '*.attestation',
  'integrityToken',
  'attestationObject',
  // Auth contract §7. Top level, one and two levels down (pino has no recursive wildcard); headers named.
  'password',
  '*.password',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'fullName',
  '*.fullName',
  'email',
  '*.email',
  'phone',
  '*.phone',
  '*.*.password',
  '*.*.refreshToken',
  '*.*.accessToken',
  '*.*.fullName',
  '*.*.email',
  '*.*.phone',
  'req.headers["idempotency-key"]',
  'headers["idempotency-key"]',
];

/** Shared with tests so a buffered logger redacts exactly what production does. */
export const REDACT_OPTIONS = { paths: REDACT_PATHS, censor: '[redacted]' };

export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  const options = { level, redact: REDACT_OPTIONS };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
