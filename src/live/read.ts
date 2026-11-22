/**
 * Reads the live snapshot of one SOS from the database (docs/live-sos-plan.md §5.3; Seam 5 of
 * docs/live-sos-seams.md). Used by `GET /v1/sos/{receiptId}/status` and by the socket.
 *
 * - `version` is `submissions.live_version`, bumped in the transaction of every change shown here.
 * - `updatedAt` is the time of the latest status change (the latest event), else acceptance.
 * - `recording.status` is the status of the highest-`seq` recording, or `none`.
 * - `units` come from `submission_units`, and only while the SOS is `dispatched` (buildSnapshot).
 *
 * The reads run on one connection in a repeatable-read transaction, so the submission, recording and
 * units belong to one committed state even while the poller writes.
 */
import type { Db } from '../db/index.js';
import { buildSnapshot, type LiveSnapshot, type RecordingView } from './snapshot.js';

async function read(
  db: Db,
  submissionId: string,
  userId: string | undefined,
  now: Date,
): Promise<(LiveSnapshot & { userId: string }) | null> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      let q = trx
        .selectFrom('submissions')
        .select([
          'id',
          'user_id',
          'reference',
          'status',
          'accepted_at',
          'live_version',
          'lat',
          'lon',
          'live_lat',
          'live_lon',
          'live_at',
        ])
        .where('id', '=', submissionId);
      if (userId !== undefined) q = q.where('user_id', '=', userId);
      const sub = await q.executeTakeFirst();
      if (!sub) return null;

      const last = await trx
        .selectFrom('submission_events')
        .select((eb) => eb.fn.max('at').as('at'))
        .where('submission_id', '=', sub.id)
        .executeTakeFirst();
      const rec = await trx
        .selectFrom('recordings')
        .select('status')
        .where('submission_id', '=', sub.id)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      const units =
        sub.status === 'dispatched'
          ? await trx
              .selectFrom('submission_units')
              .select(['unit_key', 'unit_type', 'status_text', 'lat', 'lon', 'status_at'])
              .where('submission_id', '=', sub.id)
              .execute()
          : [];

      const snapshot = buildSnapshot(
        {
          submission: {
            id: sub.id,
            reference: sub.reference,
            status: sub.status,
            updatedAt: last?.at ?? sub.accepted_at,
            liveVersion: Number(sub.live_version),
            lat: sub.lat,
            lon: sub.lon,
            liveLat: sub.live_lat,
            liveLon: sub.live_lon,
            liveAt: sub.live_at,
          },
          recording: (rec?.status ?? 'none') satisfies RecordingView,
          units: units.map((u) => ({
            unitKey: u.unit_key,
            unitType: u.unit_type,
            statusText: u.status_text,
            lat: u.lat,
            lon: u.lon,
            statusAt: u.status_at,
          })),
        },
        now,
      );
      return { ...snapshot, userId: sub.user_id };
    });
}

/**
 * The snapshot for one SOS, or null if it does not exist or is not this user's. The caller cannot
 * tell the two apart, so receipt ids cannot be probed.
 */
export async function readSnapshot(
  db: Db,
  submissionId: string,
  userId: string,
  now: Date,
): Promise<LiveSnapshot | null> {
  const found = await read(db, submissionId, userId, now);
  if (!found) return null;
  const { userId: _owner, ...snapshot } = found;
  return snapshot;
}

/** Same, without the owner check, for fan-out after a NOTIFY. The owner id lets the caller check sockets. */
export async function readSnapshotById(
  db: Db,
  submissionId: string,
  now: Date,
): Promise<(LiveSnapshot & { userId: string }) | null> {
  return read(db, submissionId, undefined, now);
}
