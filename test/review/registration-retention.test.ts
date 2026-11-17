/**
 * Review reproduction: device_registrations rows (a keyed hash of the caller's IP address) are only
 * deleted when their device is deleted. A device that keeps renewing never expires, so every
 * registration IP hash it ever had is kept forever. PRD §10.5 promises 30 days.
 * Regression test: failed until the purge ages device_registrations out on their own created_at.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { DAY } from '../../src/clock.js';
import { runPurgePass } from '../../src/jobs/purge.js';
import { closeTestDb, createTestContext, resetDb } from '../helpers/context.js';
import { seedDevice } from '../helpers/seed.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

it('registration IP hashes older than 30 days are purged even for a device that is still active', async () => {
  const ctx = createTestContext();
  const { device } = await seedDevice(ctx);

  // Registered 90 days ago, renewed at 60 and 30 days ago, and again today (token still valid).
  for (const ago of [90, 60, 30, 0]) {
    await ctx.db
      .insertInto('device_registrations')
      .values({
        device_id: device.id,
        ip_hash: `iphash-${ago}`,
        created_at: new Date(ctx.clock.now().getTime() - ago * DAY),
      })
      .execute();
  }

  await runPurgePass(ctx);

  const left = await ctx.db
    .selectFrom('device_registrations')
    .select(['ip_hash', 'created_at'])
    .where('created_at', '<', new Date(ctx.clock.now().getTime() - 30 * DAY - 1))
    .execute();
  expect(left).toEqual([]);
});
