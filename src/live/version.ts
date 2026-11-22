/**
 * The live version of a submission (docs/live-sos-plan.md §5.3, §5.4; docs/live-sos-seams.md Seam 2).
 *
 * Every change the live snapshot shows (status, recording, units) bumps `submissions.live_version`
 * and notifies LIVE_CHANNEL with the submission id, in the transaction that commits the change.
 * Postgres delivers a NOTIFY sent inside a transaction only when it commits, and drops it on
 * rollback, so a listener never hears of a change that did not happen. The payload is the id only:
 * every instance reads the snapshot from the database.
 */
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';

export const LIVE_CHANNEL = 'sos_live';

/** live_version + 1 and NOTIFY sos_live '<id>'. Call inside the transaction that commits the change. */
export async function bumpLiveVersion(
  db: Kysely<Database> | Transaction<Database>,
  submissionId: string,
): Promise<void> {
  await db
    .updateTable('submissions')
    .set({ live_version: sql<string>`live_version + 1` })
    .where('id', '=', submissionId)
    .execute();
  await sql`SELECT pg_notify(${LIVE_CHANNEL}, ${submissionId})`.execute(db);
}
