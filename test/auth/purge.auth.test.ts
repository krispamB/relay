/**
 * Auth retention inside the existing purge job (docs/auth-contract.md §8).
 *
 * Thresholds are strict: a row is removed only when it is older than the period, so a timestamp
 * exactly on the cutoff stays. Users are never deleted.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, SECOND } from '../../src/clock.js';
import { runPurgePass } from '../../src/jobs/purge.js';
import { closeTestDb, createTestContext, resetDb, type TestContext } from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const TOKEN_RETENTION = 7 * DAY;

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);
const ahead = (now: Date, ms: number) => new Date(now.getTime() + ms);

let seq = 0;

async function insertUser(ctx: TestContext, id: string) {
  seq += 1;
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone: `+234803${String(seq).padStart(7, '0')}`,
      password_hash: 'hash',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertFamily(
  ctx: TestContext,
  row: { id: string; userId: string; createdAt: Date; revokedAt?: Date | null },
) {
  await ctx.db
    .insertInto('token_families')
    .values({
      id: row.id,
      user_id: row.userId,
      install_id: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b',
      platform: 'android',
      app_version: '0.3.0',
      created_at: row.createdAt,
      revoked_at: row.revokedAt ?? null,
    })
    .execute();
}

async function insertToken(
  ctx: TestContext,
  row: { id: string; familyId: string; userId: string; expiresAt: Date },
) {
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('refresh_tokens')
    .values({
      id: row.id,
      family_id: row.familyId,
      user_id: row.userId,
      token_hash: `hash-${row.id}`,
      issued_at: now,
      expires_at: row.expiresAt,
      access_iat: now,
      access_exp: now,
    })
    .execute();
}

async function ids(ctx: TestContext, table: 'users' | 'token_families' | 'refresh_tokens') {
  return (await ctx.db.selectFrom(table).select('id').orderBy('id').execute()).map((r) => r.id);
}

describe('auth purge (contract §8)', () => {
  it('deletes refresh tokens only once expires_at is more than 7 days ago', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await insertUser(ctx, 'user-expiry');
    await insertFamily(ctx, { id: 'fam-old-token', userId: 'user-expiry', createdAt: ago(now, 100 * DAY) });
    await insertFamily(ctx, { id: 'fam-exact-token', userId: 'user-expiry', createdAt: ago(now, 100 * DAY) });
    await insertFamily(ctx, { id: 'fam-fresh-token', userId: 'user-expiry', createdAt: ago(now, 100 * DAY) });
    await insertToken(ctx, {
      id: 'tok-past',
      familyId: 'fam-old-token',
      userId: 'user-expiry',
      expiresAt: ago(now, TOKEN_RETENTION + SECOND),
    });
    await insertToken(ctx, {
      id: 'tok-exact',
      familyId: 'fam-exact-token',
      userId: 'user-expiry',
      expiresAt: ago(now, TOKEN_RETENTION),
    });
    await insertToken(ctx, {
      id: 'tok-inside',
      familyId: 'fam-fresh-token',
      userId: 'user-expiry',
      expiresAt: ago(now, TOKEN_RETENTION - SECOND),
    });

    const counts = await runPurgePass(ctx);
    expect(counts.refreshTokens).toBe(1);
    expect(await ids(ctx, 'refresh_tokens')).toEqual(['tok-exact', 'tok-inside']);
    // The family whose only token was removed is itself older than 7 days and goes with it.
    expect(await ids(ctx, 'token_families')).toEqual(['fam-exact-token', 'fam-fresh-token']);
    expect(await ids(ctx, 'users')).toEqual(['user-expiry']);
  });

  it('keeps a family that still holds an unexpired token, and drops one whose tokens are all gone', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await insertUser(ctx, 'user-live');
    await insertFamily(ctx, { id: 'fam-live', userId: 'user-live', createdAt: ago(now, 100 * DAY) });
    await insertFamily(ctx, {
      id: 'fam-empty-old',
      userId: 'user-live',
      createdAt: ago(now, TOKEN_RETENTION + SECOND),
    });
    await insertFamily(ctx, {
      id: 'fam-empty-exact',
      userId: 'user-live',
      createdAt: ago(now, TOKEN_RETENTION),
    });
    await insertFamily(ctx, {
      id: 'fam-empty-young',
      userId: 'user-live',
      createdAt: ago(now, TOKEN_RETENTION - SECOND),
    });
    await insertToken(ctx, {
      id: 'tok-expired',
      familyId: 'fam-live',
      userId: 'user-live',
      expiresAt: ago(now, TOKEN_RETENTION + SECOND),
    });
    await insertToken(ctx, {
      id: 'tok-live',
      familyId: 'fam-live',
      userId: 'user-live',
      expiresAt: ahead(now, 30 * DAY),
    });

    const counts = await runPurgePass(ctx);
    expect(counts.refreshTokens).toBe(1);
    expect(await ids(ctx, 'refresh_tokens')).toEqual(['tok-live']);
    expect(counts.tokenFamilies).toBe(1);
    expect(await ids(ctx, 'token_families')).toEqual(['fam-empty-exact', 'fam-empty-young', 'fam-live']);
    expect(await ids(ctx, 'users')).toEqual(['user-live']);
  });

  it('deletes every token of a family revoked more than 7 days ago, then the empty family', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await insertUser(ctx, 'user-revoked');
    await insertFamily(ctx, {
      id: 'fam-revoked-past',
      userId: 'user-revoked',
      createdAt: now,
      revokedAt: ago(now, TOKEN_RETENTION + SECOND),
    });
    await insertFamily(ctx, {
      id: 'fam-revoked-exact',
      userId: 'user-revoked',
      createdAt: ago(now, 10 * DAY),
      revokedAt: ago(now, TOKEN_RETENTION),
    });
    await insertFamily(ctx, {
      id: 'fam-revoked-inside',
      userId: 'user-revoked',
      createdAt: ago(now, 10 * DAY),
      revokedAt: ago(now, TOKEN_RETENTION - SECOND),
    });
    await insertToken(ctx, {
      id: 'tok-revoked-past',
      familyId: 'fam-revoked-past',
      userId: 'user-revoked',
      expiresAt: ahead(now, 80 * DAY),
    });
    await insertToken(ctx, {
      id: 'tok-revoked-exact',
      familyId: 'fam-revoked-exact',
      userId: 'user-revoked',
      expiresAt: ahead(now, 80 * DAY),
    });
    await insertToken(ctx, {
      id: 'tok-revoked-inside',
      familyId: 'fam-revoked-inside',
      userId: 'user-revoked',
      expiresAt: ahead(now, 80 * DAY),
    });

    const counts = await runPurgePass(ctx);
    expect(counts.refreshTokens).toBe(1);
    expect(await ids(ctx, 'refresh_tokens')).toEqual(['tok-revoked-exact', 'tok-revoked-inside']);
    expect(counts.tokenFamilies).toBe(1);
    expect(await ids(ctx, 'token_families')).toEqual(['fam-revoked-exact', 'fam-revoked-inside']);
    expect(await ids(ctx, 'users')).toEqual(['user-revoked']);
  });

  it('deletes an empty family revoked more than 7 days ago even when the family row itself is young', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await insertUser(ctx, 'user-empty-revoked');
    await insertFamily(ctx, {
      id: 'fam-empty-revoked',
      userId: 'user-empty-revoked',
      createdAt: now,
      revokedAt: ago(now, TOKEN_RETENTION + SECOND),
    });
    await insertFamily(ctx, {
      id: 'fam-empty-revoked-exact',
      userId: 'user-empty-revoked',
      createdAt: now,
      revokedAt: ago(now, TOKEN_RETENTION),
    });

    const counts = await runPurgePass(ctx);
    expect(counts.refreshTokens).toBe(0);
    expect(counts.tokenFamilies).toBe(1);
    expect(await ids(ctx, 'token_families')).toEqual(['fam-empty-revoked-exact']);
    expect(await ids(ctx, 'users')).toEqual(['user-empty-revoked']);
  });

  it('deletes sign-up idempotency rows and phone attempts only once they are older than 24 hours', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await insertUser(ctx, 'user-signup');
    await ctx.db
      .insertInto('signup_idempotency')
      .values([
        { key: 'key-past', body_hmac: 'h', user_id: 'user-signup', created_at: ago(now, DAY + SECOND) },
        { key: 'key-exact', body_hmac: 'h', user_id: 'user-signup', created_at: ago(now, DAY) },
        { key: 'key-inside', body_hmac: 'h', user_id: 'user-signup', created_at: ago(now, DAY - SECOND) },
      ])
      .execute();
    await ctx.db
      .insertInto('signup_phone_attempts')
      .values([
        { phone_hash: 'past', created_at: ago(now, DAY + SECOND) },
        { phone_hash: 'exact', created_at: ago(now, DAY) },
        { phone_hash: 'inside', created_at: ago(now, DAY - SECOND) },
      ])
      .execute();

    const counts = await runPurgePass(ctx);
    expect(counts.signupIdempotency).toBe(1);
    expect(counts.signupPhoneAttempts).toBe(1);
    expect(
      (await ctx.db.selectFrom('signup_idempotency').select('key').orderBy('key').execute()).map(
        (r) => r.key,
      ),
    ).toEqual(['key-exact', 'key-inside']);
    expect(
      (
        await ctx.db.selectFrom('signup_phone_attempts').select('phone_hash').orderBy('phone_hash').execute()
      ).map((r) => r.phone_hash),
    ).toEqual(['exact', 'inside']);
    expect(await ids(ctx, 'users')).toEqual(['user-signup']);
  });

  it('deletes sign-in attempts only once they are older than 1 hour', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await ctx.db
      .insertInto('signin_attempts')
      .values([
        { phone_hash: 'past', created_at: ago(now, HOUR + SECOND) },
        { phone_hash: 'exact', created_at: ago(now, HOUR) },
        { phone_hash: 'inside', created_at: ago(now, HOUR - SECOND) },
      ])
      .execute();

    const counts = await runPurgePass(ctx);
    expect(counts.signinAttempts).toBe(1);
    expect(
      (await ctx.db.selectFrom('signin_attempts').select('phone_hash').orderBy('phone_hash').execute()).map(
        (r) => r.phone_hash,
      ),
    ).toEqual(['exact', 'inside']);
  });
});
