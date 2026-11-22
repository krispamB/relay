/**
 * "The caller is watching" (docs/live-sos-plan.md D13, §5.1). The socket calls watchSubmission on
 * subscribe and on every ping; while `live_watch_until` is in the future the status poller reads
 * that SOS's call every 15 s whatever its status, and the unit poll step runs while it is dispatched.
 *
 * The 15 s floor per call holds across instances because the poller claims a row by moving
 * `next_poll_at` forward and stamping `last_poll_at` before it calls Core, and a watch only ever
 * pulls `next_poll_at` earlier, never below `last_poll_at + 15 s`.
 */
import { sql } from 'kysely';
import { SECOND } from '../clock.js';
import type { Db } from '../db/index.js';

/** How long one subscribe or ping keeps an SOS watched. */
export const WATCH_MS = 60 * SECOND;
/** GetCall interval for a watched SOS, and Core's floor for reading any one call. */
export const WATCHED_INTERVAL_MS = 15 * SECOND;

export function isWatched(liveWatchUntil: Date | null, now: Date): boolean {
  return liveWatchUntil !== null && liveWatchUntil > now;
}

/**
 * Marks the SOS watched until `now + 60 s` (never shortening a later watch) and, for a `dispatched`
 * or `closed` SOS whose call the poller reads with GetCall, makes the next read due as soon as the
 * 15 s floor allows. A `received` SOS is already read on the 15 s GetPendingCalls beat and keeps it;
 * a queued SOS has no call yet, and a demo SOS keeps its timetable. Unknown ids are ignored.
 */
export async function watchSubmission(db: Db, submissionId: string, now: Date): Promise<void> {
  const until = new Date(now.getTime() + WATCH_MS);
  await db
    .updateTable('submissions')
    .set({
      live_watch_until: sql<Date>`GREATEST(live_watch_until, ${until}::timestamptz)`,
      next_poll_at: sql<Date | null>`CASE
        WHEN status IN ('dispatched', 'closed') AND NOT is_demo AND next_poll_at IS NOT NULL
        THEN LEAST(
          next_poll_at,
          GREATEST(
            ${now}::timestamptz,
            COALESCE(last_poll_at, delivered_at, ${now}::timestamptz)
              + ${sql.raw(`interval '${WATCHED_INTERVAL_MS} milliseconds'`)}
          )
        )
        ELSE next_poll_at
      END`,
    })
    .where('id', '=', submissionId)
    .execute();
}
