/**
 * POST /v1/auth/refresh (docs/auth-contract.md §3.2, §4.2, §5). The rotation rules live in
 * rotateRefreshToken (src/auth/sessions.ts); this route validates, rate-limits and maps the result.
 *
 * Rate limit, 30 per hour per refresh-token family: the family is only known from the token, so the
 * route looks the token's owner up first (one indexed read, no lock) and counts the request against
 * that family BEFORE rotating, so a limited request changes nothing. Every request for a known family
 * counts, whatever its outcome (rotation, grace replay, reuse, revoked, expired). A token with no family
 * (malformed or unknown) is not counted here: it is answered 401 without a write, and the relay's
 * per-IP limiter, a root onRequest hook that runs before this route, is what holds back guessing.
 *
 * Logs name the family and the result only, never a token.
 */
import { Type } from '@sinclair/typebox';
import { type PublicApp, WindowLimiter } from '../../app.js';
import { HOUR } from '../../clock.js';
import type { AppContext } from '../../context.js';
import { METRICS } from '../../metrics.js';
import { authErrors } from '../errors.js';
import { deriveAuthKeys } from '../keys.js';
import { findRefreshTokenOwner, type RotateResult, rotateRefreshToken } from '../sessions.js';
import { validateRefreshBody } from '../validate.js';

/** Contract §5. */
export const REFRESH_PER_FAMILY_PER_HOUR = 30;

const RefreshBody = Type.Object(
  { refreshToken: Type.String({ description: 'The refresh token of the current session, as-is.' }) },
  { additionalProperties: false },
);

const SessionSchema = Type.Object(
  {
    accessToken: Type.String({ description: 'Opaque to the app. Valid for 15 minutes.' }),
    accessTokenExpiresAt: Type.String({ format: 'date-time' }),
    refreshToken: Type.String({ description: 'Single use. Valid for 90 days from this response.' }),
    refreshTokenExpiresAt: Type.String({ format: 'date-time' }),
  },
  { description: 'The session object (auth contract §3.1).' },
);

const AuthErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), code: Type.String() }))),
    }),
  },
  { description: 'Auth error body (auth contract §2).' },
);

export async function refreshRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
  const perFamily = new WindowLimiter(REFRESH_PER_FAMILY_PER_HOUR, HOUR);

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        summary: 'Rotate a refresh token for a new session',
        description:
          'Consumes the refresh token and returns a new pair. The same token presented again within ' +
          '30 s returns the same pair; later, the whole session is revoked (auth contract §3.2). ' +
          'Limited to 30 per hour per session.',
        tags: ['auth'],
        body: RefreshBody,
        response: {
          200: Type.Object({ session: SessionSchema }),
          400: AuthErrorResponse,
          401: AuthErrorResponse,
          429: AuthErrorResponse,
        },
      },
    },
    async (req) => {
      const { refreshToken } = validateRefreshBody(req.body);

      const owner = await findRefreshTokenOwner(ctx.db, refreshToken);
      if (owner) {
        const retryAfterSeconds = perFamily.hit(owner.familyId, ctx.clock.now().getTime());
        if (retryAfterSeconds > 0) {
          ctx.metrics.inc(METRICS.rateLimited, { rule: 'refresh_per_family' });
          ctx.metrics.inc(METRICS.authRefreshes, { result: 'rate_limited' });
          req.log.warn({ familyId: owner.familyId, result: 'rate_limited' }, 'refresh refused: rate limit');
          throw authErrors.rateLimited(retryAfterSeconds);
        }
      }

      const result: RotateResult = await rotateRefreshToken(ctx, keys, refreshToken);
      ctx.metrics.inc(METRICS.authRefreshes, { result: result.kind });
      req.log.info({ familyId: owner?.familyId, result: result.kind }, 'refresh');

      switch (result.kind) {
        case 'rotated':
        case 'grace':
          return { session: result.session };
        case 'invalid':
          throw authErrors.invalidRefreshToken();
        case 'revoked':
        case 'reuse_detected':
          throw authErrors.sessionRevoked();
      }
    },
  );
}
