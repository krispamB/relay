/**
 * Steps 6, 7, 9, 10 and 11 of the order of checks (sos-relay-PRD.md §7.4), done atomically, and the
 * lookups the route uses for replays and open submissions.
 *
 * The limits, the availability check and the insert run in one transaction under a per-intake
 * advisory lock, so concurrent requests cannot all pass a limit at its last free slot. Under the
 * lock the replay and open-SOS checks run again: a request that waited for a concurrent identical
 * one sees that one's row and becomes a replay, instead of being counted against a limit it
 * itself filled. The unique indexes remain the final guard, for requests that take different locks.
 */
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { type Db, isUniqueViolation } from '../db/index.js';
import { type Device, OPEN_STATUSES, type Submission } from '../db/types.js';
import { newReceiptId, newReference } from '../ids.js';
import type { Intake } from '../intakes.js';
import { getState, type UnavailableReason, unavailableReason } from '../state.js';
import { INLINE_HOLD_US } from './budget.js';
import { checkSosLimits, type LimitHit } from './limits.js';
import type { SosContent } from './validate.js';

export const IDEMPOTENCY_CONSTRAINT = 'submissions_device_id_idempotency_key_key';
export const OPEN_SUBMISSION_CONSTRAINT = 'submissions_one_open_per_device_idx';
export const REFERENCE_CONSTRAINT = 'submissions_reference_key';

/** Attempts at a fresh reference before giving up. 31^4 ≈ 923k codes; collisions are rare. */
const MAX_INSERT_TRIES = 5;

export async function findByIdempotencyKey(
  db: Db,
  deviceId: string,
  idempotencyKey: string,
): Promise<Submission | undefined> {
  return db
    .selectFrom('submissions')
    .selectAll()
    .where('device_id', '=', deviceId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
}

export async function findOpenSubmission(db: Db, deviceId: string): Promise<Submission | undefined> {
  return db
    .selectFrom('submissions')
    .selectAll()
    .where('device_id', '=', deviceId)
    .where('status', 'in', OPEN_STATUSES)
    .executeTakeFirst();
}

export async function getSubmissionById(db: Db, id: string): Promise<Submission | undefined> {
  return db.selectFrom('submissions').selectAll().where('id', '=', id).executeTakeFirst();
}

export interface PersistInput {
  device: Device;
  idempotencyKey: string;
  intake: Intake;
  content: SosContent;
  phoneHash: string;
  ip: string;
}

export type PersistOutcome =
  | { kind: 'created'; row: Submission }
  | { kind: 'replay'; row: Submission }
  | { kind: 'open'; row: Submission }
  | { kind: 'limited'; hit: LimitHit }
  | { kind: 'unavailable'; reason: UnavailableReason };

export async function persistSubmission(ctx: AppContext, input: PersistInput): Promise<PersistOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await persistOnce(ctx, input);
    } catch (err) {
      const raced = await afterUniqueViolation(ctx.db, input, err);
      if (raced === undefined || attempt >= MAX_INSERT_TRIES) throw err;
      if (raced !== 'retry') return raced;
    }
  }
}

/**
 * Turns a lost insert race into the response the winner's row calls for: a concurrent identical
 * request makes this a replay, a concurrent different SOS from the device makes it a 409.
 * 'retry' runs the whole step again (a reference collision, or the winner's row already gone or closed).
 */
async function afterUniqueViolation(
  db: Db,
  input: PersistInput,
  err: unknown,
): Promise<PersistOutcome | 'retry' | undefined> {
  if (isUniqueViolation(err, IDEMPOTENCY_CONSTRAINT)) {
    const row = await findByIdempotencyKey(db, input.device.id, input.idempotencyKey);
    return row ? { kind: 'replay', row } : 'retry';
  }
  if (isUniqueViolation(err, OPEN_SUBMISSION_CONSTRAINT)) {
    const row = await findOpenSubmission(db, input.device.id);
    return row ? { kind: 'open', row } : 'retry';
  }
  if (isUniqueViolation(err, REFERENCE_CONSTRAINT)) return 'retry';
  return undefined;
}

async function persistOnce(ctx: AppContext, input: PersistInput): Promise<PersistOutcome> {
  const { device, intake, content } = input;
  return ctx.db.transaction().execute(async (trx): Promise<PersistOutcome> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`sos-intake:${intake.code}`}, 0))`.execute(trx);

    // Steps 6 and 7 again, now that concurrent requests for this intake are serialised.
    const replay = await findByIdempotencyKey(trx, device.id, input.idempotencyKey);
    if (replay) return { kind: 'replay', row: replay };
    const open = await findOpenSubmission(trx, device.id);
    if (open) return { kind: 'open', row: open };

    const now = ctx.clock.now();

    // Step 9.
    const hit = await checkSosLimits(
      trx,
      {
        deviceId: device.id,
        phoneHash: input.phoneHash,
        ip: input.ip,
        intakeCode: intake.code,
        demo: intake.demo,
      },
      ctx.config.limits,
      now,
    );
    if (hit) return { kind: 'limited', hit };

    // Step 10. The demo intake is not affected by availability (PRD §6.3, §6.4).
    if (!intake.demo) {
      const reason = unavailableReason(await getState(trx), now);
      if (reason) return { kind: 'unavailable', reason };
    }

    // Step 11: committed as queued before any Core call (PRD §8.1).
    const loc = content.location;
    const row = await trx
      .insertInto('submissions')
      .values({
        id: newReceiptId(now.getTime()),
        device_id: device.id,
        idempotency_key: input.idempotencyKey,
        intake_code: intake.code,
        is_demo: intake.demo,
        reference: newReference(),
        status: 'queued',
        nature_id: content.natureId,
        nature_label: content.natureLabel,
        phone: content.phoneE164,
        phone_hash: input.phoneHash,
        name: content.name,
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        accuracy_m: loc?.accuracyM ?? null,
        location_captured_at: loc?.capturedAt ?? null,
        location_source: loc?.source ?? null,
        address: content.address,
        details: content.details,
        ip: input.ip,
        next_attempt_at: sql<Date>`${now}::timestamptz + ${sql.raw(`interval '${INLINE_HOLD_US} microseconds'`)}`,
        accepted_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('submission_events')
      .values({ submission_id: row.id, from_status: null, to_status: 'queued', cause: 'accepted', at: now })
      .execute();
    return { kind: 'created', row };
  });
}

/**
 * Makes a queued submission due now if it still holds the inline-attempt hold set at insert, i.e.
 * nothing rescheduled it: attemptDelivery leaves next_attempt_at alone when delivery is paused or
 * Core answered 401/403, and there is no attempt at all when the budget ran out. A backoff time an
 * attempt wrote is kept. Returns true when the hold was released.
 */
export async function releaseInlineHold(db: Db, id: string, now: Date): Promise<boolean> {
  const res = await db
    .updateTable('submissions')
    .set({ next_attempt_at: now })
    .where('id', '=', id)
    .where('status', '=', 'queued')
    .where(
      sql<boolean>`next_attempt_at = accepted_at + ${sql.raw(`interval '${INLINE_HOLD_US} microseconds'`)}`,
    )
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}
