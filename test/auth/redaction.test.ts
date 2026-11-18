import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';

/** A logger using createLogger's own options, writing into a buffer instead of stdout. */
function bufferedLogger() {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { log: createLogger('info', dest), text: () => chunks.join('') };
}

const PASSWORD = 'pw-secret-value-9f3c';
const REFRESH = 'rt_secret-refresh-value';
const ACCESS = 'atk-secret-access-value';
const FULL_NAME = 'Ada Secretname';
const EMAIL = 'secret.user@example.com';
const PHONE = '+2348039990001';
const AUTHORIZATION = 'Bearer secret-auth-header';
const IDEMPOTENCY_KEY = '11111111-2222-4333-8444-555555555555';

describe('auth log redaction (contract §7)', () => {
  it('keeps password, tokens, name, email, phone and the idempotency key out of the log', () => {
    const { log, text } = bufferedLogger();
    log.info({ password: PASSWORD, userId: 'user-kept' }, 'top-level password');
    log.info(
      { body: { password: PASSWORD, email: EMAIL, fullName: FULL_NAME, phone: PHONE } },
      'nested body',
    );
    log.info({ session: { refreshToken: REFRESH, accessToken: ACCESS } }, 'nested session');
    log.info(
      {
        refreshToken: REFRESH,
        accessToken: ACCESS,
        fullName: FULL_NAME,
        email: EMAIL,
        phone: PHONE,
      },
      'top-level identity',
    );
    log.info(
      { req: { headers: { authorization: AUTHORIZATION, 'idempotency-key': IDEMPOTENCY_KEY } } },
      'request headers',
    );
    log.info({ headers: { 'idempotency-key': IDEMPOTENCY_KEY, authorization: AUTHORIZATION } }, 'headers');

    const out = text();
    for (const secret of [
      PASSWORD,
      REFRESH,
      ACCESS,
      FULL_NAME,
      EMAIL,
      PHONE,
      AUTHORIZATION,
      IDEMPOTENCY_KEY,
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('user-kept');
    expect(out).toContain('[redacted]');
  });
});

describe('auth log redaction, two levels down', () => {
  it('redacts the auth fields inside req.body and err.response.session', () => {
    const { log, text } = bufferedLogger();
    log.info(
      { req: { body: { password: PASSWORD, email: EMAIL, fullName: FULL_NAME, phone: PHONE } } },
      'deep body',
    );
    log.info({ err: { response: { refreshToken: REFRESH, accessToken: ACCESS } } }, 'deep session');
    const out = text();
    for (const secret of [PASSWORD, EMAIL, FULL_NAME, PHONE, REFRESH, ACCESS])
      expect(out).not.toContain(secret);
  });
});
