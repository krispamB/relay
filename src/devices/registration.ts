/**
 * Device registration and renewal (PRD §7.2, §9.1, §9.2).
 *
 * Order of checks: registration limit (429) → nonce consumed (400) → renewal token, platform and
 * block (403) → attestation (403) → iOS key reuse (403) → write. The nonce is burned as soon as it
 * is consumed, whatever happens after: see consumeNonce and the report for why.
 */
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { isBlocked } from '../abuse/blocks.js';
import type { RegistrationInput } from '../attestation/types.js';
import { addMs, DAY, HOUR } from '../clock.js';
import type { AppContext } from '../context.js';
import { ipHash, randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import type { Device, Platform } from '../db/types.js';
import { errors } from '../errors.js';
import { newDeviceId } from '../ids.js';
import { METRICS } from '../metrics.js';
import { deviceTokenHash, findDeviceByToken } from './auth.js';
import { consumeNonce } from './nonces.js';

export const DEVICE_TOKEN_TTL_MS = 30 * DAY;
export const REGISTRATION_WINDOW_MS = HOUR;

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface RegistrationRequest {
  platform: Platform;
  nonce: string;
  attestation: RegistrationInput['attestation'];
  /** The `Authorization: Bearer` token, if the app sent one (renewal). */
  bearerToken: string | undefined;
  /** Client address from clientIp(). Only its keyed hash is stored. */
  ip: string;
}

export interface RegistrationResult {
  deviceId: string;
  deviceToken: string;
  expiresAt: Date;
  renewed: boolean;
}

/**
 * Milliseconds until another registration from this IP hash is allowed; 0 when allowed now.
 * The window holds `limit` registrations; the oldest of the newest `limit` is the one whose
 * expiry frees a slot.
 */
export async function registrationRetryAfterMs(
  db: Db,
  ipHashValue: string,
  now: Date,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await db
    .selectFrom('device_registrations')
    .select('created_at')
    .where('ip_hash', '=', ipHashValue)
    .where('created_at', '>', new Date(now.getTime() - REGISTRATION_WINDOW_MS))
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  if (rows.length < limit) return 0;
  const oldest = rows[rows.length - 1]!.created_at;
  return Math.max(1, oldest.getTime() + REGISTRATION_WINDOW_MS - now.getTime());
}

export async function registerDevice(
  ctx: AppContext,
  log: Log,
  req: RegistrationRequest,
): Promise<RegistrationResult> {
  const now = ctx.clock.now();
  const ipH = ipHash(ctx.config.phoneHashSecret, req.ip);
  const limit = ctx.config.limits.registrationsPerIpPerHour;

  /** A 403 never says why (PRD §7): the reason goes to the log only. */
  const refused = (reason: string, fields: Record<string, unknown> = {}) => {
    log.warn(
      { event: 'device_registration_refused', reason, platform: req.platform, ...fields },
      'device registration refused',
    );
    return errors.forbidden();
  };

  const checkLimit = async (db: Db): Promise<void> => {
    const retryMs = await registrationRetryAfterMs(db, ipH, now, limit);
    if (retryMs > 0) {
      ctx.metrics.inc(METRICS.rateLimited, { rule: 'registrations_per_ip' });
      log.info({ event: 'device_registration_rate_limited' }, 'device registration rate limited');
      throw errors.rateLimited(retryMs / 1000);
    }
  };

  // Cheap early rejection, before the nonce is spent or Google is called. Re-checked under a lock below.
  await checkLimit(ctx.db);

  if (!(await consumeNonce(ctx.db, req.nonce, now))) {
    log.info({ event: 'device_registration_bad_nonce' }, 'device registration nonce invalid');
    throw errors.badRequest('invalid_nonce', 'The nonce is unknown, expired or already used.');
  }

  let renewing: Device | undefined;
  if (req.bearerToken !== undefined) {
    const existing = await findDeviceByToken(ctx, req.bearerToken);
    if (!existing) {
      // Same as sending no token (PRD §7.2): a device purged by retention must still be able to come back.
      log.info({ event: 'device_renewal_token_unknown' }, 'renewal token unknown; registering a new device');
    } else if (existing.platform !== req.platform) {
      throw refused('renewal_platform_mismatch', {
        deviceId: existing.id,
        devicePlatform: existing.platform,
      });
    } else if (await isBlocked(ctx.db, 'device', existing.id, now)) {
      throw refused('device_blocked', { deviceId: existing.id });
    } else {
      renewing = existing;
    }
  }

  const outcome = await ctx.attestation.verifyRegistration({
    platform: req.platform,
    nonce: req.nonce,
    attestation: req.attestation,
  });
  if (!outcome.accepted) {
    throw refused('attestation_refused', { attestationReason: outcome.reason, deviceId: renewing?.id });
  }

  const deviceToken = randomToken(32);
  const tokenHash = deviceTokenHash(deviceToken);
  const expiresAt = addMs(now, DEVICE_TOKEN_TTL_MS);
  const ios = outcome.ios;

  const deviceId = await ctx.db.transaction().execute(async (trx) => {
    // Lock order is always IP then key, so two registrations cannot deadlock.
    if (limit > 0) {
      await advisoryLock(trx, `device_registration:ip:${ipH}`);
      await checkLimit(trx);
    }

    let iosCounter = ios?.counter ?? 0;
    if (ios) {
      await advisoryLock(trx, `device_registration:ios_key:${ios.keyId}`);
      const holders = await trx
        .selectFrom('devices')
        .select(['id', 'ios_counter'])
        .where('ios_key_id', '=', ios.keyId)
        .execute();
      const other = holders.find((h) => h.id !== renewing?.id);
      if (other) throw refused('ios_key_already_registered', { deviceId: renewing?.id, keyHolder: other.id });
      const self = holders.find((h) => h.id === renewing?.id);
      if (self) {
        // Not expected (a renewal attests a new key). Accept, but never move the counter backwards,
        // or assertions already seen would verify again.
        iosCounter = Math.max(iosCounter, Number(self.ios_counter));
        log.warn(
          { event: 'device_renewal_same_ios_key', deviceId: self.id },
          'renewal re-presented its iOS key',
        );
      }
    }

    const material = {
      token_hash: tokenHash,
      token_expires_at: expiresAt,
      attested: outcome.attested,
      ios_key_id: ios?.keyId ?? null,
      ios_public_key: ios?.publicKeyPem ?? null,
      ios_counter: iosCounter,
      updated_at: now,
    };

    let id: string;
    if (renewing) {
      // Conditional on the token we looked up: a concurrent renewal or a purge in between loses here.
      const updated = await trx
        .updateTable('devices')
        .set(material)
        .where('id', '=', renewing.id)
        .where('token_hash', '=', renewing.token_hash)
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw refused('renewal_superseded', { deviceId: renewing.id });
      id = renewing.id;
    } else {
      id = newDeviceId(now.getTime());
      await trx
        .insertInto('devices')
        .values({ id, platform: req.platform, created_at: now, ...material })
        .execute();
    }

    await trx
      .insertInto('device_registrations')
      .values({ device_id: id, ip_hash: ipH, created_at: now })
      .execute();
    return id;
  });

  log.info(
    {
      event: renewing ? 'device_renewed' : 'device_registered',
      deviceId,
      platform: req.platform,
      attested: outcome.attested,
    },
    renewing ? 'device renewed' : 'device registered',
  );
  return { deviceId, deviceToken, expiresAt, renewed: renewing !== undefined };
}

/** Transaction-scoped advisory lock; released at commit or rollback. */
async function advisoryLock(trx: Db, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}
