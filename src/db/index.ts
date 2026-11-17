import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Postgres unique-violation error code. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint === constraint;
}
