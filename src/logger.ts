import { type Logger, pino } from 'pino';

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
];

export function createLogger(level = 'info'): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
