import { randomUUID } from 'node:crypto';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { DAY, MINUTE } from '../../src/clock.js';
import type { AppContext } from '../../src/context.js';
import { randomToken } from '../../src/crypto.js';
import type { Device, Platform, User } from '../../src/db/types.js';
import { deviceTokenHash } from '../../src/devices/auth.js';
import { newDeviceId } from '../../src/ids.js';

/** Inserts a registered device and returns it with its bearer token. */
export async function seedDevice(
  ctx: Pick<AppContext, 'db' | 'clock'>,
  opts: { platform?: Platform; expiresInMs?: number; attested?: boolean } = {},
): Promise<{ device: Device; token: string; authHeader: { authorization: string } }> {
  const now = ctx.clock.now();
  const token = randomToken();
  const device = await ctx.db
    .insertInto('devices')
    .values({
      id: newDeviceId(now.getTime()),
      platform: opts.platform ?? 'android',
      token_hash: deviceTokenHash(token),
      token_expires_at: new Date(now.getTime() + (opts.expiresInMs ?? 30 * DAY)),
      attested: opts.attested ?? false,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { device, token, authHeader: { authorization: `Bearer ${token}` } };
}

let phoneSeq = 0;

/** A valid Nigerian mobile number no other seeded user has (within one test process). */
export function uniquePhone(): string {
  phoneSeq += 1;
  return `+2348039${String(phoneSeq % 1_000_000).padStart(6, '0')}`;
}

export interface SeededUser {
  user: User;
  familyId: string;
  /** A fresh access token, valid for 15 minutes from the context clock's current time. */
  token: () => string;
}

/**
 * Inserts a user and a live token family. `token()` signs a new access token at the clock's current
 * time each call, so a test may move the clock by hours and still send as this user.
 */
export async function seedUser(
  ctx: Pick<AppContext, 'db' | 'clock' | 'config'>,
  opts: { phone?: string; fullName?: string } = {},
): Promise<SeededUser> {
  const now = ctx.clock.now();
  const user = await ctx.db
    .insertInto('users')
    .values({
      id: randomUUID(),
      full_name: opts.fullName ?? 'Adaeze Okonkwo-Bello',
      phone: opts.phone ?? uniquePhone(),
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const familyId = randomUUID();
  await ctx.db
    .insertInto('token_families')
    .values({
      id: familyId,
      user_id: user.id,
      install_id: randomUUID(),
      platform: 'android',
      app_version: '0.3.0',
      created_at: now,
    })
    .execute();
  const key = deriveAuthKeys(ctx.config.auth.tokenSecret).access;
  const token = () => {
    const iat = ctx.clock.now();
    return signAccessToken(key, {
      sub: user.id,
      fam: familyId,
      jti: randomUUID(),
      iat,
      exp: new Date(iat.getTime() + 15 * MINUTE),
    });
  };
  return { user, familyId, token };
}
