import { describe, expect, it } from 'vitest';
import { AuthError, authErrors } from '../../src/auth/errors.js';

describe('AuthError.toBody', () => {
  it('has the contract envelope: code and message, nothing else by default', () => {
    const body = new AuthError(409, 'email_taken', 'Taken.').toBody();
    expect(body).toEqual({ error: { code: 'email_taken', message: 'Taken.' } });
  });

  it('adds retryAfterSeconds and fields only when set', () => {
    const body = new AuthError(400, 'validation_failed', 'Bad.', 60, [
      { field: 'phone', code: 'invalid_phone' },
    ]).toBody();
    expect(body).toEqual({
      error: {
        code: 'validation_failed',
        message: 'Bad.',
        retryAfterSeconds: 60,
        fields: [{ field: 'phone', code: 'invalid_phone' }],
      },
    });
  });

  it('is an Error carrying its status', () => {
    const err = new AuthError(401, 'invalid_token', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.message).toBe('x');
  });
});

describe('authErrors: one helper for every code in the contract', () => {
  const cases: [string, () => AuthError, number, string][] = [
    [
      'validationFailed',
      () => authErrors.validationFailed([{ field: 'email', code: 'required' }]),
      400,
      'validation_failed',
    ],
    ['malformedRequest', () => authErrors.malformedRequest(), 400, 'malformed_request'],
    ['payloadTooLarge', () => authErrors.payloadTooLarge(), 413, 'payload_too_large'],
    ['rateLimited', () => authErrors.rateLimited(30), 429, 'rate_limited'],
    ['internalError', () => authErrors.internalError(), 500, 'internal_error'],
    ['unavailable', () => authErrors.unavailable(), 503, 'unavailable'],
    ['emailTaken', () => authErrors.emailTaken(), 409, 'email_taken'],
    ['phoneTaken', () => authErrors.phoneTaken(), 409, 'phone_taken'],
    ['idempotencyKeyReused', () => authErrors.idempotencyKeyReused(), 422, 'idempotency_key_reused'],
    ['invalidRefreshToken', () => authErrors.invalidRefreshToken(), 401, 'invalid_refresh_token'],
    ['sessionRevoked', () => authErrors.sessionRevoked(), 401, 'session_revoked'],
    ['tokenExpired', () => authErrors.tokenExpired(), 401, 'token_expired'],
    ['invalidToken', () => authErrors.invalidToken(), 401, 'invalid_token'],
  ];

  it.each(cases)('%s', (_name, make, status, code) => {
    const err = make();
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    const body = err.toBody();
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('validationFailed carries the fields, and only it does', () => {
    const fields = [
      { field: 'email', code: 'invalid_email' },
      { field: 'device.platform', code: 'invalid_value' },
    ] as const;
    expect(authErrors.validationFailed([...fields]).toBody().error.fields).toEqual(fields);
    for (const [, make] of cases.filter(([n]) => n !== 'validationFailed')) {
      expect(make().toBody().error).not.toHaveProperty('fields');
    }
  });

  it('rateLimited always has an integer retryAfterSeconds of at least 1', () => {
    expect(authErrors.rateLimited(30).retryAfterSeconds).toBe(30);
    expect(authErrors.rateLimited(0.2).retryAfterSeconds).toBe(1);
    expect(authErrors.rateLimited(0).retryAfterSeconds).toBe(1);
    expect(authErrors.rateLimited(59.1).retryAfterSeconds).toBe(60);
    expect(authErrors.rateLimited(30).toBody().error.retryAfterSeconds).toBe(30);
  });

  it('unavailable has retryAfterSeconds only when known', () => {
    expect(authErrors.unavailable().toBody().error).not.toHaveProperty('retryAfterSeconds');
    expect(authErrors.unavailable(10).toBody().error.retryAfterSeconds).toBe(10);
    expect(authErrors.unavailable(0).toBody().error.retryAfterSeconds).toBe(1);
  });

  it('no other code carries retryAfterSeconds', () => {
    for (const [name, make] of cases.filter(([n]) => !['rateLimited', 'unavailable'].includes(n))) {
      expect(make().toBody().error, name).not.toHaveProperty('retryAfterSeconds');
    }
  });
});
