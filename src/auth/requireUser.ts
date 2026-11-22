/**
 * Access-token authentication for the routes that are not sign-up or refresh
 * (docs/auth-contract.md §4.3, §4.4, §5, §8).
 *
 * Sign-out passes `checkFamily: false`. It must answer 204 when the access token's family is
 * already revoked or missing (the contract's "already revoked" case), and the family it revokes
 * is the refresh token's, which need not be `claims.fam`. So sign-out never reads family state.
 * Every other caller leaves the default, and a deleted user is `session_revoked`: deleting the
 * user cascades the family away, which this lookup reports as missing.
 */
import type { FastifyRequest } from 'fastify';
import { WindowLimiter } from '../app.js';
import { MINUTE } from '../clock.js';
import type { AppContext } from '../context.js';
import { authErrors } from './errors.js';
import type { AuthKeys } from './keys.js';
import { verifyAccessToken } from './tokens.js';

/** The token of an `Authorization: Bearer <token>` header (scheme matched exactly), or undefined. */
export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token === '' ? undefined : token;
}

/** Contract §5: everything except sign-up and refresh, keyed by user. */
const USER_REQUESTS_PER_MINUTE = 120;

/**
 * One bucket per app context, shared by every route that authenticates. Keyed by the context
 * object so a test's context cannot spend another test's budget; the process has one context.
 */
const limiters = new WeakMap<object, WindowLimiter>();

function limiterFor(ctx: object): WindowLimiter {
  const existing = limiters.get(ctx);
  if (existing) return existing;
  const created = new WindowLimiter(USER_REQUESTS_PER_MINUTE, MINUTE);
  limiters.set(ctx, created);
  return created;
}

/** Claims of an access token this relay has accepted. */
export interface AuthenticatedAccess {
  userId: string;
  familyId: string;
  jti: string;
  /** The token's `exp`. The live socket closes when it passes without a re-auth. */
  expiresAt: Date;
}

export interface AuthenticateOptions {
  /** Sign-out accepts an expired access token. Every other route refuses it with `token_expired`. */
  allowExpired: boolean;
  /**
   * When false, do not look up the family. Sign-out sets this; see the file comment.
   * Default true.
   */
  checkFamily?: boolean;
}

type AuthContext = Pick<AppContext, 'db' | 'clock'>;

/**
 * Verifies one access token: signature, expiry and (unless `checkFamily` is false) a live family of
 * the same user. Throws AuthError (`invalid_token`, `token_expired`, `session_revoked`). No rate
 * limit: `authenticate` adds the per-user limit for HTTP requests; the live socket calls this
 * directly, on the upgrade, on every in-band `auth` and on every message as a revocation backstop.
 */
export async function verifyAccess(
  ctx: AuthContext,
  keys: AuthKeys,
  token: string | undefined,
  options: AuthenticateOptions,
): Promise<AuthenticatedAccess> {
  if (!token) throw authErrors.invalidToken();

  const check = verifyAccessToken(keys.access, token, ctx.clock.now());
  if (check.kind === 'invalid') throw authErrors.invalidToken();
  if (check.kind === 'expired' && !options.allowExpired) throw authErrors.tokenExpired();
  const { claims } = check;

  if (options.checkFamily !== false) {
    // One indexed read: familyState's missing/revoked answer, plus the owner check. A family that
    // exists but belongs to someone else is not that user's session.
    const family = await ctx.db
      .selectFrom('token_families')
      .select(['user_id', 'revoked_at'])
      .where('id', '=', claims.fam)
      .executeTakeFirst();
    if (!family) throw authErrors.sessionRevoked();
    if (family.user_id !== claims.sub) throw authErrors.invalidToken();
    if (family.revoked_at) throw authErrors.sessionRevoked();
  }

  return { userId: claims.sub, familyId: claims.fam, jti: claims.jti, expiresAt: claims.exp };
}

/**
 * Verifies the bearer access token. Throws AuthError. The per-user limit is applied only after
 * the token (and, when checked, the family) has been accepted, so a rejected request does not
 * spend the user's budget.
 */
export async function authenticate(
  ctx: AuthContext,
  keys: AuthKeys,
  req: FastifyRequest,
  options: AuthenticateOptions,
): Promise<AuthenticatedAccess> {
  const access = await verifyAccess(ctx, keys, bearerToken(req), options);

  // Without the family check the token may be old or revoked (sign-out): it gets a bucket of its
  // own family, so it can never spend the budget of the user's live session.
  const bucket = options.checkFamily === false ? `family:${access.familyId}` : `user:${access.userId}`;
  const retryAfterSeconds = limiterFor(ctx).hit(bucket, ctx.clock.now().getTime());
  if (retryAfterSeconds > 0) {
    req.log.warn({ userId: access.userId }, 'authenticated request refused: rate limit');
    throw authErrors.rateLimited(retryAfterSeconds);
  }

  return access;
}

/** `authenticate` with an unexpired access token and a live family. */
export function requireUser(
  ctx: AuthContext,
  keys: AuthKeys,
  req: FastifyRequest,
): Promise<AuthenticatedAccess> {
  return authenticate(ctx, keys, req, { allowExpired: false });
}
