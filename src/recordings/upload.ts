/**
 * Storing an uploaded recording (docs/live-sos-plan.md §3.4, §4.2).
 *
 * One transaction: lock the submission row (which serialises every upload to the same SOS, so the
 * cap and `seq` cannot race), check owner and status, answer a replay, check the cap, take the next
 * `seq`, insert, and bump the live version so the snapshot shows `recording.status`.
 */
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { RecordingStatus } from '../db/types.js';
import { newRecordingId } from '../ids.js';
import { bumpLiveVersion } from '../live/version.js';

export interface UploadInput {
  userId: string;
  receiptId: string;
  idempotencyKey: string;
  bytes: Buffer;
  durationMs: number;
}

export interface StoredRecording {
  recordingId: string;
  seq: number;
  status: RecordingStatus;
}

export type UploadOutcome =
  | { kind: 'created'; recording: StoredRecording }
  | { kind: 'replay'; recording: StoredRecording }
  | { kind: 'not_found' }
  | { kind: 'sos_closed' }
  | { kind: 'limit' }
  | { kind: 'key_reused' };

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export async function storeRecording(
  ctx: Pick<AppContext, 'db' | 'clock' | 'config'>,
  input: UploadInput,
): Promise<UploadOutcome> {
  const bodyHash = sha256Hex(input.bytes);
  return ctx.db.transaction().execute(async (trx): Promise<UploadOutcome> => {
    // The owner check and the lock in one statement: someone else's SOS is the same "not found".
    const sub = await trx
      .selectFrom('submissions')
      .select(['id', 'status'])
      .where('id', '=', input.receiptId)
      .where('user_id', '=', input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!sub) return { kind: 'not_found' };

    // A retry of an accepted upload gets its answer even if the SOS has since ended.
    const same = await trx
      .selectFrom('recordings')
      .select(['id', 'seq', 'status', 'body_hash'])
      .where('submission_id', '=', sub.id)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (same) {
      if (same.body_hash !== bodyHash) return { kind: 'key_reused' };
      return { kind: 'replay', recording: { recordingId: same.id, seq: same.seq, status: same.status } };
    }

    if (sub.status === 'closed' || sub.status === 'failed') return { kind: 'sos_closed' };

    const held = await trx
      .selectFrom('recordings')
      .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('seq').as('last')])
      .where('submission_id', '=', sub.id)
      .executeTakeFirstOrThrow();
    if (Number(held.n) >= ctx.config.recordingsPerSos) return { kind: 'limit' };

    const now = ctx.clock.now();
    const id = newRecordingId(now.getTime());
    const seq = (held.last ?? 0) + 1;
    await trx
      .insertInto('recordings')
      .values({
        id,
        submission_id: sub.id,
        seq,
        idempotency_key: input.idempotencyKey,
        body_hash: bodyHash,
        bytes: input.bytes,
        size: input.bytes.length,
        duration_ms: input.durationMs,
        status: 'pending',
        next_attempt_at: now,
        created_at: now,
      })
      .execute();
    await bumpLiveVersion(trx, sub.id);
    return { kind: 'created', recording: { recordingId: id, seq, status: 'pending' } };
  });
}
