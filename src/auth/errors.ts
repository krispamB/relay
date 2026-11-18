/**
 * The auth endpoints' own errors (docs/auth-contract.md §2). Same envelope as the relay's
 * `{ "error": { "code", "message", … } }`, with codes of their own and `fields` on a validation failure.
 * These are not the relay's `ApiError`: the SOS routes keep their codes.
 */

/** Field error codes of contract §4.1, used in `fields[].code`. */
export type FieldErrorCode =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'invalid_phone'
  | 'invalid_email'
  | 'invalid_value';

export interface FieldError {
  /** The request field name, `device.platform` for a nested one. */
  field: string;
  code: FieldErrorCode;
}

export type AuthErrorCode =
  | 'validation_failed'
  | 'malformed_request'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable'
  | 'email_taken'
  | 'phone_taken'
  | 'idempotency_key_reused'
  | 'invalid_refresh_token'
  | 'session_revoked'
  | 'token_expired'
  | 'invalid_token';

export interface AuthErrorBody {
  error: {
    code: AuthErrorCode;
    message: string;
    retryAfterSeconds?: number;
    fields?: FieldError[];
  };
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: AuthErrorCode,
    message: string,
    /** An integer of at least 1. Present on 429 and, when known, on 503. */
    public readonly retryAfterSeconds?: number,
    /** Only on 400 validation_failed. */
    public readonly fields?: FieldError[],
  ) {
    super(message);
    this.name = 'AuthError';
  }

  toBody(): AuthErrorBody {
    const error: AuthErrorBody['error'] = { code: this.code, message: this.message };
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    if (this.fields !== undefined) error.fields = this.fields;
    return { error };
  }
}

const atLeastOneSecond = (seconds: number): number => Math.max(1, Math.ceil(seconds));

export const authErrors = {
  validationFailed: (fields: FieldError[]) =>
    new AuthError(400, 'validation_failed', 'Some fields are invalid.', undefined, fields),
  malformedRequest: () => new AuthError(400, 'malformed_request', 'The request is not valid.'),
  payloadTooLarge: () => new AuthError(413, 'payload_too_large', 'The request body is too large.'),
  rateLimited: (retryAfterSeconds: number) =>
    new AuthError(429, 'rate_limited', 'Too many requests.', atLeastOneSecond(retryAfterSeconds)),
  internalError: () => new AuthError(500, 'internal_error', 'Something went wrong.'),
  unavailable: (retryAfterSeconds?: number) =>
    new AuthError(
      503,
      'unavailable',
      'This service is not available right now.',
      retryAfterSeconds === undefined ? undefined : atLeastOneSecond(retryAfterSeconds),
    ),
  emailTaken: () => new AuthError(409, 'email_taken', 'An account with this email already exists.'),
  phoneTaken: () => new AuthError(409, 'phone_taken', 'This phone number is already registered.'),
  idempotencyKeyReused: () =>
    new AuthError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different body.'),
  invalidRefreshToken: () => new AuthError(401, 'invalid_refresh_token', 'The refresh token is not valid.'),
  sessionRevoked: () => new AuthError(401, 'session_revoked', 'This session has ended.'),
  tokenExpired: () => new AuthError(401, 'token_expired', 'The access token has expired.'),
  invalidToken: () => new AuthError(401, 'invalid_token', 'The access token is not valid.'),
};
