/**
 * POST /v1/auth/signin (docs/auth-contract.md §6).
 *
 * Order: validate, per-IP limit (in memory, 20/hour), per-email limit (Postgres, 10/hour, so it holds
 * across instances and restarts), then the credential check. A 400 is not an attempt. A request a
 * limit refuses is not recorded, so retrying cannot stretch the lock-out. The email limit counts
 * every other validated attempt, success and failure alike, under an advisory lock per email hash.
 *
 * Unknown email and wrong password are the same 401. The unknown path still runs one Argon2id
 * verification against a dummy hash created once, when this route is first registered, so the two
 * paths cost the same. A password longer than SIGNIN_PASSWORD_MAX_CHARS skips that verification
 * (it cannot match an account, and hashing it would be a CPU sink); both the known and unknown
 * paths skip it, so the skip itself does not say whether the email exists.
 *
 * The per-email key is `signinEmail` from AUTH_TOKEN_SECRET (src/auth/keys.ts), not PHONE_HASH_SECRET.
 * Logs name the user id on success only. Never the email or the password.
 */
import { randomBytes } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { sql } from 'kysely';
import { clientIp, type PublicApp, WindowLimiter } from '../../app.js';
import { addMs, HOUR } from '../../clock.js';
import type { AppContext } from '../../context.js';
import type { User } from '../../db/types.js';
import { METRICS } from '../../metrics.js';
import { authErrors } from '../errors.js';
import { deriveAuthKeys, signinEmailHash } from '../keys.js';
import { hashPassword, verifyPassword } from '../password.js';
import { issueSession, rfc3339, type Session } from '../sessions.js';
import { characterLength, SIGNIN_PASSWORD_MAX_CHARS, type SigninInput, validateSignin } from '../validate.js';

/** Contract §6. */
export const SIGNIN_PER_IP_PER_HOUR = 20;
export const SIGNIN_PER_EMAIL_PER_HOUR = 10;

/** One Argon2id hash of a random password, shared by every registration of this route in the process. */
let dummyPasswordHash: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyPasswordHash;
}

interface UserBody {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  phoneVerified: boolean;
  createdAt: string;
}

const userBody = (u: User): UserBody => ({
  id: u.id,
  fullName: u.full_name,
  phone: u.phone,
  email: u.email,
  phoneVerified: false,
  createdAt: rfc3339(u.created_at),
});

/**
 * Counts this email's attempts in the last hour and records one, or returns the seconds until the
 * oldest counted attempt leaves the window. One transaction under an advisory lock, so concurrent
 * requests cannot both read "9" and both pass.
 */
async function emailAttemptRetrySeconds(ctx: AppContext, emailHash: string, now: Date): Promise<number> {
  const since = addMs(now, -HOUR);
  return ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`signin-email:${emailHash}`}))`.execute(trx);
    const recent = await trx
      .selectFrom('signin_attempts')
      .select('created_at')
      .where('email_hash', '=', emailHash)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .execute();
    if (recent.length >= SIGNIN_PER_EMAIL_PER_HOUR) {
      const leaving = recent[recent.length - SIGNIN_PER_EMAIL_PER_HOUR]!.created_at;
      return (leaving.getTime() + HOUR - now.getTime()) / 1000;
    }
    await trx.insertInto('signin_attempts').values({ email_hash: emailHash, created_at: now }).execute();
    return 0;
  });
}

/** The user when the password matches. Unknown email still pays for one verification, unless the cap applies. */
async function authenticatedUser(
  ctx: AppContext,
  email: string,
  password: string,
  dummy: string,
): Promise<User | undefined> {
  // Postgres text cannot hold NUL, so such an address cannot have an account: skip the lookup (it would
  // fail) but still pay for one verification, so the answer and its timing match any unknown email.
  const user = email.includes('\u0000')
    ? undefined
    : await ctx.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
  if (characterLength(password) > SIGNIN_PASSWORD_MAX_CHARS) return undefined;
  const ok = await verifyPassword(user?.password_hash ?? dummy, password);
  return user && ok ? user : undefined;
}

const SessionSchema = Type.Object({
  accessToken: Type.String(),
  accessTokenExpiresAt: Type.String({ format: 'date-time' }),
  refreshToken: Type.String(),
  refreshTokenExpiresAt: Type.String({ format: 'date-time' }),
});

const ErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), code: Type.String() }))),
  }),
});

/** Documentation only: the plugin's own validator compiler lets every body through. */
const SIGNIN_SCHEMA = {
  tags: ['auth'],
  summary: 'Sign in to an existing account',
  description:
    'Returns the user and a new session (a new token family). An unknown email and a wrong password are ' +
    'both 401 `invalid_credentials`. Limits: 20 per hour per client IP and 10 per hour per email address. ' +
    'Every validated attempt counts, whether or not the password matches.',
  body: Type.Object(
    {
      email: Type.String({ description: 'Trimmed and lower-cased by the server.' }),
      password: Type.String(),
      device: Type.Object(
        {
          platform: Type.Union([Type.Literal('ios'), Type.Literal('android')]),
          appVersion: Type.String({ maxLength: 32 }),
          installId: Type.String({ format: 'uuid' }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({
      user: Type.Object({
        id: Type.String(),
        fullName: Type.String(),
        phone: Type.String(),
        email: Type.String(),
        phoneVerified: Type.Boolean(),
        createdAt: Type.String({ format: 'date-time' }),
      }),
      session: SessionSchema,
    }),
    400: ErrorSchema,
    401: ErrorSchema,
    413: ErrorSchema,
    429: ErrorSchema,
  },
};

export async function signinRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
  const ipLimiter = new WindowLimiter(SIGNIN_PER_IP_PER_HOUR, HOUR);
  const dummy = await dummyHash();

  app.post('/v1/auth/signin', { schema: SIGNIN_SCHEMA }, async (req, reply) => {
    const input: SigninInput = validateSignin(req.body);
    const now = ctx.clock.now();

    const ip = clientIp(req, ctx.config.clientIpHeader);
    const ipRetry = ipLimiter.hit(ip, now.getTime());
    if (ipRetry > 0) {
      ctx.metrics.inc(METRICS.authSignins, { result: 'rate_limited' });
      req.log.info({ result: 'rate_limited' }, 'sign-in refused');
      throw authErrors.rateLimited(ipRetry);
    }

    const emailRetry = await emailAttemptRetrySeconds(
      ctx,
      signinEmailHash(keys.signinEmail, input.email),
      now,
    );
    if (emailRetry > 0) {
      // Contract §6: an attempt refused by a limit is not counted, by either limit.
      ipLimiter.refund(ip, now.getTime());
      ctx.metrics.inc(METRICS.authSignins, { result: 'rate_limited' });
      req.log.info({ result: 'rate_limited' }, 'sign-in refused');
      throw authErrors.rateLimited(emailRetry);
    }

    const user = await authenticatedUser(ctx, input.email, input.password, dummy);
    if (!user) {
      ctx.metrics.inc(METRICS.authSignins, { result: 'invalid_credentials' });
      req.log.info({ result: 'invalid_credentials' }, 'sign-in refused');
      throw authErrors.invalidCredentials();
    }

    // One transaction: a family is never left without its token, and a user deleted meanwhile fails cleanly.
    let session: Session;
    try {
      ({ session } = await ctx.db
        .transaction()
        .execute((trx) => issueSession(trx, keys, { userId: user.id, device: input.device, now })));
    } catch (err) {
      if ((err as { code?: unknown }).code !== '23503') throw err;
      ctx.metrics.inc(METRICS.authSignins, { result: 'invalid_credentials' });
      req.log.info({ result: 'invalid_credentials' }, 'sign-in refused: user deleted meanwhile');
      throw authErrors.invalidCredentials();
    }
    ctx.metrics.inc(METRICS.authSignins, { result: 'success' });
    req.log.info({ userId: user.id }, 'user signed in');
    const body: { user: UserBody; session: Session } = { user: userBody(user), session };
    return reply.status(200).send(body);
  });
}
