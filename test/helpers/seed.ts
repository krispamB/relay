import { DAY } from '../../src/clock.js';
import type { AppContext } from '../../src/context.js';
import { randomToken } from '../../src/crypto.js';
import type { Device, Platform } from '../../src/db/types.js';
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
