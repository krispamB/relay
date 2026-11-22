/**
 * Session revocation is announced on SESSION_REVOKED_CHANNEL with the family id, inside the revoking
 * transaction (a trigger on token_families, migration 008), so the live socket of every relay
 * instance can close that session's sockets (docs/live-sos-plan.md D15). Against real Postgres.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { deriveAuthKeys } from '../../src/auth/keys.js';
import {
  GRACE_MS,
  issueSession,
  revokeFamily,
  rotateRefreshToken,
  SESSION_REVOKED_CHANNEL,
} from '../../src/auth/sessions.js';
import { closeTestDb, createTestContext, resetDb, type TestContext } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';

let listener: pg.Client;
let received: { channel: string; payload: string | undefined }[];
let ctx: TestContext;

beforeEach(async () => {
  await resetDb();
  ctx = createTestContext();
  received = [];
  listener = new pg.Client({ connectionString: inject('databaseUrl') });
  await listener.connect();
  listener.on('notification', (n) => received.push({ channel: n.channel, payload: n.payload }));
  await listener.query(`LISTEN ${SESSION_REVOKED_CHANNEL}`);
});
afterEach(async () => {
  await listener.end();
});
afterAll(() => closeTestDb());

async function settle(): Promise<void> {
  await listener.query('SELECT 1');
  await new Promise((r) => setTimeout(r, 50));
}

describe('session revocation notifications', () => {
  it('revokeFamily notifies the family id once, on commit only', async () => {
    const user = await seedUser(ctx);
    let beforeCommit: typeof received = [];
    await ctx.db.transaction().execute(async (trx) => {
      expect(await revokeFamily(trx, user.familyId, ctx.clock.now())).toBe(true);
      await settle();
      beforeCommit = [...received];
    });
    expect(beforeCommit).toEqual([]);
    await settle();
    expect(received).toEqual([{ channel: 'session_revoked', payload: user.familyId }]);

    // Already revoked: no second notification.
    expect(await revokeFamily(ctx.db, user.familyId, ctx.clock.now())).toBe(false);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('a rolled-back revocation sends nothing', async () => {
    const user = await seedUser(ctx);
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await revokeFamily(trx, user.familyId, ctx.clock.now());
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await settle();
    expect(received).toEqual([]);
  });

  it('refresh-token reuse detection notifies the revoked family', async () => {
    const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
    const user = await seedUser(ctx);
    const { familyId, session } = await issueSession(ctx.db, keys, {
      userId: user.user.id,
      device: { platform: 'ios', appVersion: '1', installId: '6f1c2a5e-3b1d-4c55-9a51-0d7b1e7f2a10' },
      now: ctx.clock.now(),
    });
    expect((await rotateRefreshToken(ctx, keys, session.refreshToken)).kind).toBe('rotated');
    ctx.clock.advance(GRACE_MS + 1000);
    expect((await rotateRefreshToken(ctx, keys, session.refreshToken)).kind).toBe('reuse_detected');
    await settle();
    expect(received).toEqual([{ channel: 'session_revoked', payload: familyId }]);
  });

  it('a revocation by any other path (plain SQL) notifies too', async () => {
    const user = await seedUser(ctx);
    await ctx.db
      .updateTable('token_families')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', user.familyId)
      .execute();
    await settle();
    expect(received).toEqual([{ channel: 'session_revoked', payload: user.familyId }]);
  });

  it('deleting a family, or its user, notifies; other updates do not', async () => {
    const a = await seedUser(ctx);
    const b = await seedUser(ctx);
    await ctx.db
      .updateTable('token_families')
      .set({ app_version: '9' })
      .where('id', '=', a.familyId)
      .execute();
    await settle();
    expect(received).toEqual([]);
    await ctx.db.deleteFrom('token_families').where('id', '=', a.familyId).execute();
    await ctx.db.deleteFrom('users').where('id', '=', b.user.id).execute();
    await settle();
    expect(received.map((r) => r.payload)).toEqual([a.familyId, b.familyId]);
  });
});
