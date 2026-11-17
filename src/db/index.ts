import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export function createDb(
  connectionString: string,
  max = 10,
  onIdleError: (code: string | undefined) => void = () => {},
): Db {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  // Without a listener, Postgres closing an idle connection (restart, failover) crashes the process.
  pool.on('error', (err) => onIdleError((err as { code?: string }).code));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Postgres unique-violation error code. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint === constraint;
}
