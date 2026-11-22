import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/db/index.js';
import { closeTestDb, resetDb, testDb } from '../helpers/context.js';

const now = new Date('2026-11-18T12:00:00Z');
const later = new Date('2027-02-16T12:00:00Z');

async function insertUser(id: string, phone = `+23480${id.padStart(8, '0')}`) {
  await testDb()
    .insertInto('users')
    .values({
      id,
      full_name: 'Ada Okafor',
      phone,
      password_hash: '$argon2id$stub',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertFamily(id: string, userId: string, platform: string = 'android') {
  await sql`INSERT INTO token_families (id, user_id, install_id, platform, app_version, created_at)
    VALUES (${id}, ${userId}, 'install-1', ${platform}, '0.3.0', ${now})`.execute(testDb());
}

async function insertToken(id: string, familyId: string, userId: string, tokenHash: string) {
  await testDb()
    .insertInto('refresh_tokens')
    .values({
      id,
      family_id: familyId,
      user_id: userId,
      token_hash: tokenHash,
      issued_at: now,
      expires_at: later,
      access_iat: now,
      access_exp: now,
    })
    .execute();
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e) => e,
  );
}

async function count(table: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(testDb());
  return Number(r.rows[0]?.n);
}

describe('auth schema (migration 004)', () => {
  beforeEach(() => resetDb());
  afterAll(() => closeTestDb());

  it('creates every auth table', async () => {
    const r = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('users', 'token_families', 'refresh_tokens', 'signup_idempotency', 'signup_phone_attempts')`.execute(
      testDb(),
    );
    expect(r.rows.map((x) => x.table_name).sort()).toEqual([
      'refresh_tokens',
      'signup_idempotency',
      'signup_phone_attempts',
      'token_families',
      'users',
    ]);
  });

  it('refuses a second user with the same phone', async () => {
    await insertUser('1', '+2348031234567');
    const samePhone = await failure(insertUser('3', '+2348031234567'));
    expect(isUniqueViolation(samePhone)).toBe(true);
  });

  it('keeps no email for a user (migration 006)', async () => {
    const r = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'`.execute(testDb());
    expect(r.rows.map((x) => x.column_name)).not.toContain('email');
  });

  it('drops the device model: no devices, device_registrations or nonces table (migration 006)', async () => {
    const r = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('devices', 'device_registrations', 'nonces')`.execute(
      testDb(),
    );
    expect(r.rows).toEqual([]);
  });

  it('counts sign-in attempts by phone hash, not email hash (migration 006)', async () => {
    const r = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'signin_attempts'`.execute(testDb());
    const columns = r.rows.map((x) => x.column_name);
    expect(columns).toContain('phone_hash');
    expect(columns).not.toContain('email_hash');
  });

  it('refuses a platform other than ios or android', async () => {
    await insertUser('1');
    const err = (await failure(insertFamily('f1', '1', 'windows'))) as { code?: string };
    expect(err.code).toBe('23514');
    await insertFamily('f2', '1', 'ios');
  });

  it('refuses a duplicate refresh token hash', async () => {
    await insertUser('1');
    await insertFamily('f1', '1');
    await insertToken('t1', 'f1', '1', 'hash-a');
    const dup = await failure(insertToken('t2', 'f1', '1', 'hash-a'));
    expect(isUniqueViolation(dup)).toBe(true);
    await insertToken('t2', 'f1', '1', 'hash-b');
  });

  it('refuses a family or token for a user that does not exist', async () => {
    const err = (await failure(insertFamily('f1', 'nobody'))) as { code?: string };
    expect(err.code).toBe('23503');
    await insertUser('1');
    await insertFamily('f1', '1');
    const tokenErr = (await failure(insertToken('t1', 'missing-family', '1', 'h'))) as { code?: string };
    expect(tokenErr.code).toBe('23503');
  });

  it('deletes families and refresh tokens with their user', async () => {
    await insertUser('1');
    await insertFamily('f1', '1');
    await insertToken('t1', 'f1', '1', 'hash-a');
    await insertToken('t2', 'f1', '1', 'hash-b');
    await testDb().deleteFrom('users').where('id', '=', '1').execute();
    expect(await count('token_families')).toBe(0);
    expect(await count('refresh_tokens')).toBe(0);
  });

  it('deletes refresh tokens with their family', async () => {
    await insertUser('1');
    await insertFamily('f1', '1');
    await insertToken('t1', 'f1', '1', 'hash-a');
    await sql`DELETE FROM token_families WHERE id = 'f1'`.execute(testDb());
    expect(await count('refresh_tokens')).toBe(0);
    expect(await count('users')).toBe(1);
  });

  it('keeps one idempotency row per key', async () => {
    await insertUser('1');
    const row = { key: 'k1', body_hmac: 'hmac', user_id: '1', created_at: now };
    await testDb().insertInto('signup_idempotency').values(row).execute();
    const dup = await failure(testDb().insertInto('signup_idempotency').values(row).execute());
    expect(isUniqueViolation(dup)).toBe(true);
  });

  it('records phone attempts, several per phone hash', async () => {
    const db = testDb();
    await db.insertInto('signup_phone_attempts').values({ phone_hash: 'p', created_at: now }).execute();
    await db.insertInto('signup_phone_attempts').values({ phone_hash: 'p', created_at: later }).execute();
    expect(await count('signup_phone_attempts')).toBe(2);
  });

  it('indexes the lookups and purges the plan relies on', async () => {
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`.execute(testDb());
    const names = new Set(r.rows.map((x) => x.indexname));
    for (const name of [
      'token_families_user_idx',
      'token_families_revoked_idx',
      'refresh_tokens_family_idx',
      'refresh_tokens_user_idx',
      'refresh_tokens_expires_at_idx',
      'signup_idempotency_created_idx',
      'signup_idempotency_user_idx',
      'signup_phone_attempts_idx',
      'signup_phone_attempts_created_idx',
      'signin_attempts_idx',
      'signin_attempts_created_idx',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
