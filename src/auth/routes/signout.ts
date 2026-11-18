/**
 * POST /v1/auth/signout (docs/auth-contract.md §4.3).
 *
 * The access token is checked for a valid signature only (`allowExpired`, no family lookup).
 * A revoked or missing access-token family must not fail the call: the contract answers 204
 * when the session is already revoked. The family that is revoked is the refresh token's, and
 * only when that token is still within its lifetime and belongs to the same user. An unknown,
 * expired, already-revoked or other-user refresh token changes nothing and still answers 204.
 * `findRefreshTokenOwner` ignores expiry, so the lifetime is checked on the row it names.
 */
import { Type } from '@sinclair/typebox';
import type { PublicApp } from '../../app.js';
import type { AppContext } from '../../context.js';
import { deriveAuthKeys } from '../keys.js';
import { authenticate } from '../requireUser.js';
import { findRefreshTokenOwner, revokeFamily } from '../sessions.js';
import { refreshTokenHash } from '../tokens.js';
import { validateSignoutBody } from '../validate.js';

const SignoutBody = Type.Object(
  { refreshToken: Type.String() },
  { additionalProperties: false, description: 'The refresh token whose family should be revoked.' },
);

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), code: Type.String() }))),
  }),
});

export async function signoutRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);

  app.post(
    '/v1/auth/signout',
    {
      schema: {
        operationId: 'signOut',
        summary: 'Revoke the refresh-token family for this session.',
        tags: ['auth'],
        security: [{ accessToken: [] }],
        body: SignoutBody,
        response: {
          204: Type.Null({ description: 'Revoked, already revoked, or nothing to revoke.' }),
          400: ErrorResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const access = await authenticate(ctx, keys, req, { allowExpired: true, checkFamily: false });
      const body = validateSignoutBody(req.body);

      const owner = await findRefreshTokenOwner(ctx.db, body.refreshToken);
      if (owner && owner.userId === access.userId) {
        const row = await ctx.db
          .selectFrom('refresh_tokens')
          .select('expires_at')
          .where('token_hash', '=', refreshTokenHash(body.refreshToken))
          .executeTakeFirst();
        // now >= expires_at is expired, the same boundary as an access token.
        if (row && ctx.clock.now().getTime() < row.expires_at.getTime()) {
          await revokeFamily(ctx.db, owner.familyId, ctx.clock.now());
          req.log.info({ userId: access.userId, familyId: owner.familyId }, 'sign-out');
        }
      }

      return reply.status(204).send(null);
    },
  );
}
