/** GET /v1/me (docs/auth-contract.md §4.4). */
import { Type } from '@sinclair/typebox';
import type { PublicApp } from '../../app.js';
import type { AppContext } from '../../context.js';
import { authErrors } from '../errors.js';
import { deriveAuthKeys } from '../keys.js';
import { requireUser } from '../requireUser.js';
import { rfc3339 } from '../sessions.js';

const User = Type.Object(
  {
    id: Type.String(),
    fullName: Type.String(),
    phone: Type.String(),
    phoneVerified: Type.Literal(false, { description: 'Always false in the demo (contract §8).' }),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

const MeResponse = Type.Object({ user: User }, { additionalProperties: false });

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), code: Type.String() }))),
  }),
});

export async function meRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);

  app.get(
    '/v1/me',
    {
      schema: {
        operationId: 'getMe',
        summary: 'The signed-in user.',
        tags: ['auth'],
        security: [{ accessToken: [] }],
        response: {
          200: MeResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req) => {
      const auth = await requireUser(ctx, keys, req);
      const user = await ctx.db
        .selectFrom('users')
        .select(['id', 'full_name', 'phone', 'created_at'])
        .where('id', '=', auth.userId)
        .executeTakeFirst();
      // The family check already treats a deleted user as session_revoked. This covers a user row
      // that is gone while the family row is still visible.
      if (!user) throw authErrors.sessionRevoked();
      return {
        user: {
          id: user.id,
          fullName: user.full_name,
          phone: user.phone,
          phoneVerified: false as const,
          createdAt: rfc3339(user.created_at),
        },
      };
    },
  );
}
