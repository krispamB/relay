import type { FastifyRequest } from 'fastify';
import { bearerToken } from '../auth/requireUser.js';
import type { AppContext } from '../context.js';
import { sha256Hex } from '../crypto.js';
import type { Device } from '../db/types.js';
import { errors } from '../errors.js';

/** Device tokens are stored only as this hash (PRD §7.2). */
export function deviceTokenHash(token: string): string {
  return sha256Hex(`device:${token}`);
}

export { bearerToken };

/** Finds the device for a token, whether or not the token has expired. Used by renewal. */
export async function findDeviceByToken(ctx: AppContext, token: string): Promise<Device | undefined> {
  return ctx.db
    .selectFrom('devices')
    .selectAll()
    .where('token_hash', '=', deviceTokenHash(token))
    .executeTakeFirst();
}

/** Returns the device for a valid, unexpired bearer token, else throws 401. */
export async function requireDevice(ctx: AppContext, req: FastifyRequest): Promise<Device> {
  const token = bearerToken(req);
  if (!token) throw errors.unauthorized();
  const device = await findDeviceByToken(ctx, token);
  if (!device || device.token_expires_at.getTime() <= ctx.clock.now().getTime()) throw errors.unauthorized();
  return device;
}
