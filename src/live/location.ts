/**
 * The caller's position from the live socket (docs/live-sos-plan.md D14, §5.2). Kept on the
 * submission as live_lat, live_lon and live_at (the fix's capture time) for the snapshot's distance,
 * and nothing else: it is never sent to Core.
 *
 * At most one fix per LOCATION_INTERVAL_MS per submission is stored. The limit is in the UPDATE's own
 * WHERE clause, on live_stored_at (when the relay last stored one, by its clock), so it holds across
 * instances: two concurrent UPDATEs of the row serialise on its lock, and the second re-checks the
 * condition against the first's write and matches nothing.
 */
import { SECOND } from '../clock.js';
import type { Db } from '../db/index.js';
import { FINAL_STATUSES } from '../db/types.js';
import { bumpLiveVersion } from './version.js';

export const LOCATION_INTERVAL_MS = 5 * SECOND;

export interface LiveFix {
  lat: number;
  lon: number;
  capturedAt: Date;
}

/**
 * Stores the fix when the SOS is the user's, still open, has stored no fix in the last 5 s, and has no
 * newer fix. Bumps the live version in the same transaction (distanceM depends on it). Returns whether
 * it was stored; a fix that was not is simply ignored.
 */
export async function storeLiveLocation(
  db: Db,
  submissionId: string,
  userId: string,
  fix: LiveFix,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - LOCATION_INTERVAL_MS);
  return db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable('submissions')
      .set({ live_lat: fix.lat, live_lon: fix.lon, live_at: fix.capturedAt, live_stored_at: now })
      .where('id', '=', submissionId)
      .where('user_id', '=', userId)
      .where('status', 'not in', FINAL_STATUSES)
      .where((eb) => eb.or([eb('live_stored_at', 'is', null), eb('live_stored_at', '<=', cutoff)]))
      .where((eb) => eb.or([eb('live_at', 'is', null), eb('live_at', '<', fix.capturedAt)]))
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return false;
    await bumpLiveVersion(trx, submissionId);
    return true;
  });
}
