/**
 * POST /v1/auth/signup (docs/auth-contract.md §4.1, §5; docs/auth-implementation-plan.md, slice 4).
 *
 * Order of work, and why:
 * 1. `Idempotency-Key` header. The contract lists only body fields for validation, so the header's
 *    errors are this route's own choice: a missing header is `400 validation_failed` with
 *    `{ field: 'Idempotency-Key', code: 'required' }`, a value that is not a UUID v4 is
 *    `{ field: 'Idempotency-Key', code: 'invalid_value' }`. The header is checked before the body, and
 *    its error is returned alone. The key is stored lower-cased, so its two spellings are one key.
 * 2. The body (validateSignup), then a keyed HMAC of the normalised input.
 * 3. Replay: the key was used within the last 24 h. Same HMAC: answer 201 with the stored user and a NEW
 *    session. Different HMAC: 422 idempotency_key_reused. Neither counts toward a rate limit. A row 24 h
 *    old or older is treated as absent (the purge deletes it later) and is upserted over.
 * 4. Rate limits (contract §5). Counted: every request that is not a replay and has a valid body, whatever
 *    it ends in, so a 409 counts (that is what slows enumeration of phone numbers). Not counted: a 400,
 *    a 422, a replay, and a request refused by a limit (it never adds a phone attempt, so a client that
 *    keeps retrying cannot stretch its own lock-out). The IP limit is checked first; a request it refuses
 *    is not recorded against the phone.
 * 5. Uniqueness pre-check (the phone), then the password is hashed OUTSIDE
 *    any transaction (it takes ~50 ms of CPU and a transaction holds a pooled connection), then one
 *    transaction: user, session, idempotency row.
 *
 * Races:
 * - Two requests with the same key and body both pass step 3, and both reach the transaction. The first to
 *   commit wins; the second fails on the unique phone of `users` (it waits for the first to finish) or on the
 *   idempotency key. Either way it re-reads the key and answers as a replay (or 422): never a 409.
 * - Two different sign-ups for one phone: the loser's unique violation becomes `phone_taken`.
 * - The phone limit is exact under concurrency: counting and recording run under an advisory lock per phone.
 *   A request that only turns out to be a replay or a 422 after it was counted (a same-key twin committed
 *   first) gives back both its per-IP hit and its phone attempt, so neither ever uses up an allowance.
 *
 * Logs: the user id only. No body field, header value or token is ever logged.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { sql } from 'kysely';
import { clientIp, type PublicApp, WindowLimiter } from '../../app.js';
import { addMs, DAY, HOUR } from '../../clock.js';
import type { AppContext } from '../../context.js';
import { phoneHash, safeEqual } from '../../crypto.js';
import { type Db, isUniqueViolation } from '../../db/index.js';
import type { User } from '../../db/types.js';
import { METRICS } from '../../metrics.js';
import { AuthError, authErrors } from '../errors.js';
import { type AuthKeys, deriveAuthKeys } from '../keys.js';
import { hashPassword } from '../password.js';
import { issueSession, rfc3339, type Session } from '../sessions.js';
import { type SignupInput, validateSignup } from '../validate.js';

/** Contract §5. */
const IP_LIMIT = 5;
const IP_WINDOW_MS = HOUR;
const PHONE_LIMIT = 3;
const PHONE_WINDOW_MS = DAY;
/** Contract §4.1: a key is remembered for 24 hours. */
const KEY_TTL_MS = DAY;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The §4.1 user object. */
interface UserBody {
  id: string;
  fullName: string;
  phone: string;
  phoneVerified: boolean;
  createdAt: string;
}

interface SignupResponse {
  user: UserBody;
  session: Session;
}

const userBody = (u: User): UserBody => ({
  id: u.id,
  fullName: u.full_name,
  phone: u.phone,
  phoneVerified: false,
  createdAt: rfc3339(u.created_at),
});

/** The key is a UUID v4, compared case-insensitively: stored lower-case. */
function readIdempotencyKey(header: unknown): string {
  if (header === undefined) {
    throw authErrors.validationFailed([{ field: 'Idempotency-Key', code: 'required' }]);
  }
  if (typeof header !== 'string' || !UUID_V4.test(header)) {
    throw authErrors.validationFailed([{ field: 'Idempotency-Key', code: 'invalid_value' }]);
  }
  return header.toLowerCase();
}

/**
 * HMAC-SHA256 of the normalised input as JSON in a fixed key order. It covers the password, so a retry
 * with a changed password is a different body; being keyed, it reveals nothing to a reader of the table.
 */
function bodyHmac(key: Buffer, input: SignupInput): string {
  const canonical = JSON.stringify({
    fullName: input.fullName,
    phone: input.phone,
    password: input.password,
    device: {
      platform: input.device.platform,
      appVersion: input.device.appVersion,
      installId: input.device.installId,
    },
  });
  return createHmac('sha256', key).update(canonical).digest('hex');
}

interface StoredKey {
  bodyHmac: string;
  user: User;
}

/** The key's row if it is under 24 h old. An older row counts as absent. */
async function findStoredKey(db: Db, key: string, now: Date): Promise<StoredKey | undefined> {
  const row = await db
    .selectFrom('signup_idempotency')
    .select(['body_hmac', 'user_id'])
    .where('key', '=', key)
    .where('created_at', '>', addMs(now, -KEY_TTL_MS))
    .executeTakeFirst();
  if (!row) return undefined;
  const user = await db.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirst();
  return user && { bodyHmac: row.body_hmac, user };
}

/** 201 for the stored user with a new session of its own, or 422 when the body differs. */
async function answerReplay(
  ctx: AppContext,
  keys: AuthKeys,
  stored: StoredKey,
  hmac: string,
  input: SignupInput,
): Promise<SignupResponse> {
  if (!safeEqual(stored.bodyHmac, hmac)) throw authErrors.idempotencyKeyReused();
  const { session } = await issueSession(ctx.db, keys, {
    userId: stored.user.id,
    device: input.device,
    now: ctx.clock.now(),
  });
  return { user: userBody(stored.user), session };
}

/**
 * Counts this phone's attempts in the last 24 h and records a new one, or throws 429. One transaction
 * under an advisory lock on the phone, so concurrent requests cannot both read "2" and both pass.
 */
async function recordPhoneAttempt(ctx: AppContext, phone: string, now: Date): Promise<string> {
  const hash = phoneHash(ctx.config.phoneHashSecret, phone);
  const since = addMs(now, -PHONE_WINDOW_MS);
  const outcome = await ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`signup-phone:${hash}`}))`.execute(trx);
    const recent = await trx
      .selectFrom('signup_phone_attempts')
      .select('created_at')
      .where('phone_hash', '=', hash)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .execute();
    if (recent.length >= PHONE_LIMIT) {
      // Allowed again once fewer than PHONE_LIMIT attempts remain: when this one leaves the window.
      const leaving = recent[recent.length - PHONE_LIMIT]!.created_at;
      return { retryAfterMs: leaving.getTime() + PHONE_WINDOW_MS - now.getTime(), id: '' };
    }
    const row = await trx
      .insertInto('signup_phone_attempts')
      .values({ phone_hash: hash, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { retryAfterMs: 0, id: row.id };
  });
  if (outcome.retryAfterMs > 0) throw authErrors.rateLimited(outcome.retryAfterMs / 1000);
  return outcome.id;
}

/** Contract §5: a replay does not count. Undoes an attempt recorded before the replay was known. */
async function refundPhoneAttempt(ctx: AppContext, attemptId: string): Promise<void> {
  await ctx.db.deleteFrom('signup_phone_attempts').where('id', '=', attemptId).execute();
}

/** The error for a phone number that already has an account. */
async function findTaken(db: Db, phone: string): Promise<AuthError | undefined> {
  const row = await db.selectFrom('users').select('id').where('phone', '=', phone).executeTakeFirst();
  return row ? authErrors.phoneTaken() : undefined;
}

/** Thrown inside the transaction when the key was taken meanwhile, to roll the new user back. */
class KeyInUse extends Error {}

async function createAccount(
  ctx: AppContext,
  keys: AuthKeys,
  input: SignupInput,
  idempotencyKey: string,
  hmac: string,
  passwordHash: string,
): Promise<SignupResponse> {
  const now = ctx.clock.now();
  return ctx.db.transaction().execute(async (trx) => {
    const id = randomUUID();
    const user = await trx
      .insertInto('users')
      .values({
        id,
        full_name: input.fullName,
        phone: input.phone,
        password_hash: passwordHash,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { session } = await issueSession(trx, keys, { userId: id, device: input.device, now });
    // A key under 24 h old is left alone (no row comes back); an older one is replaced.
    const stored = await trx
      .insertInto('signup_idempotency')
      .values({ key: idempotencyKey, body_hmac: hmac, user_id: id, created_at: now })
      .onConflict((oc) =>
        oc
          .column('key')
          .doUpdateSet({ body_hmac: hmac, user_id: id, created_at: now })
          .where('signup_idempotency.created_at', '<=', addMs(now, -KEY_TTL_MS)),
      )
      .returning('key')
      .executeTakeFirst();
    if (!stored) throw new KeyInUse();
    return { user: userBody(user), session };
  });
}

/** What a request that lost a race answers: the replay (or 422) of the winner, or the taken field. */
async function answerRace(
  ctx: AppContext,
  keys: AuthKeys,
  err: unknown,
  input: SignupInput,
  idempotencyKey: string,
  hmac: string,
): Promise<SignupResponse> {
  const phoneClash = isUniqueViolation(err, 'users_phone_key');
  if (!(err instanceof KeyInUse) && !phoneClash) throw err;

  // Same key: the other request is this one, retried in parallel.
  const stored = await findStoredKey(ctx.db, idempotencyKey, ctx.clock.now());
  if (stored) return answerReplay(ctx, keys, stored, hmac, input);

  const taken = await findTaken(ctx.db, input.phone);
  if (taken) throw taken;
  if (phoneClash) throw authErrors.phoneTaken();
  throw err;
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

/** Documentation only: the plugin's own validator compiler lets every body and header through. */
const SIGNUP_SCHEMA = {
  tags: ['auth'],
  summary: 'Create an account and sign in',
  description:
    'Creates an account and returns a session. Idempotent per `Idempotency-Key` for 24 hours: the same key ' +
    'and body answer 201 again with the same user and a new session; the same key with another body is 422. ' +
    'Limits: 5 per hour per client IP and 3 per day per phone; replays do not count. A missing or invalid ' +
    '`Idempotency-Key` is 400 `validation_failed` on the field `Idempotency-Key`.',
  headers: Type.Object({
    'idempotency-key': Type.String({
      format: 'uuid',
      description: 'A UUID v4 generated once per form submission and reused on every retry.',
    }),
  }),
  body: Type.Object(
    {
      fullName: Type.String({ minLength: 1, maxLength: 100 }),
      phone: Type.String({ pattern: '^\\+[1-9]\\d{6,14}$', description: 'E.164.' }),
      password: Type.String({ minLength: 8, maxLength: 128 }),
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
    201: Type.Object({
      user: Type.Object({
        id: Type.String(),
        fullName: Type.String(),
        phone: Type.String(),
        phoneVerified: Type.Boolean(),
        createdAt: Type.String({ format: 'date-time' }),
      }),
      session: SessionSchema,
    }),
    400: ErrorSchema,
    409: ErrorSchema,
    413: ErrorSchema,
    422: ErrorSchema,
    429: ErrorSchema,
  },
};

export async function signupRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
  const ipLimiter = new WindowLimiter(IP_LIMIT, IP_WINDOW_MS);

  app.post('/v1/auth/signup', { schema: SIGNUP_SCHEMA }, async (req, reply) => {
    const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
    const input = validateSignup(req.body);
    const hmac = bodyHmac(keys.signupBody, input);

    const stored = await findStoredKey(ctx.db, idempotencyKey, ctx.clock.now());
    if (stored) {
      const replay = await answerReplay(ctx, keys, stored, hmac, input);
      ctx.metrics.inc(METRICS.authSignups, { result: 'replay' });
      req.log.info({ userId: replay.user.id }, 'sign-up replayed');
      return reply.status(201).send(replay);
    }

    const ip = clientIp(req, ctx.config.clientIpHeader);
    const retryAfter = ipLimiter.hit(ip, ctx.clock.now().getTime());
    if (retryAfter > 0) throw authErrors.rateLimited(retryAfter);
    let attemptId: string;
    try {
      attemptId = await recordPhoneAttempt(ctx, input.phone, ctx.clock.now());
    } catch (err) {
      // Contract §5: a request refused by a limit does not count, so the per-IP hit is given back.
      ipLimiter.refund(ip, ctx.clock.now().getTime());
      throw err;
    }
    /**
     * Contract §5: a replay and a 422 do not count. When either only shows up after the request was
     * counted (a same-key twin committed meanwhile), give back the IP hit and the phone attempt.
     */
    const uncounted = async <T>(outcome: Promise<T>): Promise<T> => {
      const giveBack = async () => {
        ipLimiter.refund(ip, ctx.clock.now().getTime());
        await refundPhoneAttempt(ctx, attemptId);
      };
      try {
        const value = await outcome;
        await giveBack();
        return value;
      } catch (err) {
        if (err instanceof AuthError && err.code === 'idempotency_key_reused') await giveBack();
        throw err;
      }
    };

    const taken = await findTaken(ctx.db, input.phone);
    if (taken) {
      // A parallel request with this key may have committed since the lookup above: then the
      // clash is with our own account, and the answer is its replay, not a 409.
      const committed = await findStoredKey(ctx.db, idempotencyKey, ctx.clock.now());
      if (!committed) throw taken;
      const replay = await uncounted(answerReplay(ctx, keys, committed, hmac, input));
      ctx.metrics.inc(METRICS.authSignups, { result: 'replay' });
      req.log.info({ userId: replay.user.id }, 'sign-up replayed');
      return reply.status(201).send(replay);
    }

    const passwordHash = await hashPassword(input.password);
    let created: SignupResponse;
    let signupResult: 'created' | 'replay';
    try {
      created = await createAccount(ctx, keys, input, idempotencyKey, hmac, passwordHash);
      signupResult = 'created';
    } catch (err) {
      // A lost race answers as the winner's replay (or throws). It did not create this user.
      // phone_taken from here stays counted, like any 409.
      created = await uncounted(answerRace(ctx, keys, err, input, idempotencyKey, hmac));
      signupResult = 'replay';
    }
    ctx.metrics.inc(METRICS.authSignups, { result: signupResult });
    req.log.info({ userId: created.user.id }, 'user signed up');
    return reply.status(201).send(created);
  });
}
