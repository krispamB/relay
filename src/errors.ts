/** Public error shape. See sos-relay-PRD.md §7. */
export interface ErrorBody {
  error: { code: string; message: string; retryAfterSeconds?: number };
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
    /** Extra top-level fields merged into the body (used by the 409 response). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ErrorBody & Record<string, unknown> {
    const error: ErrorBody['error'] = { code: this.code, message: this.message };
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    return { error, ...(this.extra ?? {}) };
  }
}

export const errors = {
  badRequest: (code: string, message: string) => new ApiError(400, code, message),
  unauthorized: () => new ApiError(401, 'unauthorized', 'Device token is missing, invalid or expired.'),
  /** A 403 never says why (PRD §7). The reason goes to the log only. */
  forbidden: () => new ApiError(403, 'forbidden', 'This request is not allowed.'),
  notFound: () => new ApiError(404, 'not_found', 'Not found.'),
  gone: () => new ApiError(410, 'intake_disabled', 'This service is not available.'),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(429, 'rate_limited', 'Too many requests.', Math.max(1, Math.ceil(retryAfterSeconds))),
  unavailable: (retryAfterSeconds: number, code = 'unavailable') =>
    new ApiError(
      503,
      code,
      'This service cannot take an SOS right now.',
      Math.max(1, Math.ceil(retryAfterSeconds)),
    ),
};
