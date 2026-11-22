/**
 * The caller of an SOS route: the signed-in user behind the access token (docs/live-sos-plan.md D2).
 *
 * The token is checked exactly as on `GET /v1/me` (src/auth/requireUser.ts), and its refusals keep the
 * auth contract's codes (`invalid_token`, `token_expired`, `session_revoked`, `rate_limited`) so the
 * app's refresh logic is the same everywhere. They are answered in the relay's error envelope, which
 * has the same `{ error: { code, message } }` shape.
 */
import type { FastifyRequest } from 'fastify';
import { AuthError, authErrors } from '../auth/errors.js';
import type { AuthKeys } from '../auth/keys.js';
import { requireUser } from '../auth/requireUser.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';

export interface Caller {
  userId: string;
  /** Becomes ContactName in Core. */
  fullName: string;
  /** E.164, from sign-up. The callback number, and the subject of the per-phone limit and blocks. */
  phone: string;
}

function toApiError(err: AuthError): ApiError {
  return new ApiError(err.status, err.code, err.message, err.retryAfterSeconds);
}

/** The user behind the bearer access token, or an ApiError 401 (or 429 for the per-user limit). */
export async function requireCaller(
  ctx: Pick<AppContext, 'db' | 'clock'>,
  keys: AuthKeys,
  req: FastifyRequest,
): Promise<Caller> {
  try {
    const auth = await requireUser(ctx, keys, req);
    const user = await ctx.db
      .selectFrom('users')
      .select(['id', 'full_name', 'phone'])
      .where('id', '=', auth.userId)
      .executeTakeFirst();
    // Deleting a user cascades its families away, so this is a race with the deletion.
    if (!user) throw authErrors.sessionRevoked();
    return { userId: user.id, fullName: user.full_name, phone: user.phone };
  } catch (err) {
    if (err instanceof AuthError) throw toApiError(err);
    throw err;
  }
}
