/**
 * Child process for pool-error-crash.test.ts. Builds the relay's db exactly as main.ts does, leaves a
 * connection idle in the pool, then has Postgres terminate that backend (what a Postgres restart,
 * failover or idle-session reaper does). Exits 0 if the process survives, which it should.
 */
import { sql } from 'kysely';
import pg from 'pg';
import { createDb } from '../../../src/db/index.js';

const url = process.env.DATABASE_URL as string;
const db = createDb(url);
const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
const pid = rows[0]!.pid;

console.log('terminating idle backend');
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query('select pg_terminate_backend($1)', [pid]);
await admin.end();

await new Promise((r) => setTimeout(r, 1500));
console.log('survived');
await db.destroy().catch(() => {});
process.exit(0);
