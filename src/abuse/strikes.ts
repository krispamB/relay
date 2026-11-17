/**
 * Hoax strikes, automatic device blocks and phone-number alerts. sos-relay-PRD.md §9.2, §8.5.
 *
 * A strike is recorded for the device and for the phone hash when the poller sees a real
 * submission's call closed as Unfounded (3) or False alarm (7).
 *
 * - **Device:** enough live strikes block the device automatically. When the call later leaves the
 *   hoax state, that submission's strikes are removed, and an automatic device block they made
 *   possible is lifted (see removeStrikes).
 * - **Phone number:** never blocked automatically. The number is typed by the caller and unverified,
 *   so anyone with a few attested devices could otherwise get a stranger's number blocked. Reaching
 *   the threshold raises a warning alert instead, and an operator decides (manual block through the
 *   admin API).
 *
 * The functions that write run inside the caller's transaction and return what happened; the caller
 * raises alerts after the commit with raiseStrikeAlerts.
 */
import { sql } from 'kysely';
import { ALERT_CODES } from '../alerts.js';
import { DAY } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { SubjectType } from '../db/types.js';
import { newBlockId } from '../ids.js';

export interface StrikeSubmission {
  id: string;
  reference: string;
  device_id: string;
  /** Keyed hash of the phone number; never the number itself. */
  phone_hash: string;
}

export interface StrikeLimits {
  hoaxStrikesToBlock: number;
  strikeTtlDays: number;
  blockTtlDays: number;
}

/** Something this module did that an operator should hear about. */
export type StrikeOutcome =
  | {
      /** An automatic device block was applied or lifted. */
      kind: 'device_block_applied' | 'device_block_lifted';
      blockId: string;
      deviceId: string;
      liveStrikes: number;
      /** The submission whose closure caused the change (for the alert's reference and receiptId). */
      submissionId: string;
      reference: string;
    }
  | {
      /**
       * A new strike took a phone number to the threshold or past it, and the number has no live
       * block. Nothing was blocked. Carries no phone number and no phone hash.
       */
      kind: 'phone_threshold_reached';
      liveStrikes: number;
      threshold: number;
      strikeTtlDays: number;
      submissionId: string;
      reference: string;
    };

/** Serialises strike and block decisions for one subject across instances, until the commit. */
async function lockSubject(trx: Db, type: SubjectType, subject: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`strike:${type}:${subject}`}))`.execute(trx);
}

export async function liveStrikeCount(
  db: Db,
  type: SubjectType,
  subject: string,
  now: Date,
): Promise<number> {
  const row = await db
    .selectFrom('strikes')
    .select(sql<string>`count(*)`.as('n'))
    .where('subject_type', '=', type)
    .where('subject', '=', subject)
    .where('expires_at', '>', now)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function liveBlockExists(db: Db, type: SubjectType, subject: string, now: Date): Promise<boolean> {
  const row = await db
    .selectFrom('blocks')
    .select('id')
    .where('subject_type', '=', type)
    .where('subject', '=', subject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Inserts the strike; true only when it is new (one per subject type per submission). */
async function insertStrike(
  trx: Db,
  type: SubjectType,
  subject: string,
  sub: StrikeSubmission,
  now: Date,
  limits: StrikeLimits,
): Promise<boolean> {
  const inserted = await trx
    .insertInto('strikes')
    .values({
      subject_type: type,
      subject,
      submission_id: sub.id,
      created_at: now,
      expires_at: new Date(now.getTime() + limits.strikeTtlDays * DAY),
    })
    .onConflict((oc) => oc.columns(['subject_type', 'submission_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/**
 * Records one strike for the device and one for the phone hash (idempotent per submission).
 * A device that reaches the threshold with no live block is blocked automatically. A phone number
 * that reaches it with no live block is reported, never blocked. Both happen only when this call
 * inserted a new strike, so the poller seeing the same hoax state again reports nothing. A threshold
 * of 0 records strikes and neither blocks nor reports. Run inside the caller's transaction.
 */
export async function recordHoaxStrikes(
  trx: Db,
  sub: StrikeSubmission,
  now: Date,
  limits: StrikeLimits,
): Promise<StrikeOutcome[]> {
  const outcomes: StrikeOutcome[] = [];

  await lockSubject(trx, 'device', sub.device_id);
  if ((await insertStrike(trx, 'device', sub.device_id, sub, now, limits)) && limits.hoaxStrikesToBlock > 0) {
    const live = await liveStrikeCount(trx, 'device', sub.device_id, now);
    if (live >= limits.hoaxStrikesToBlock && !(await liveBlockExists(trx, 'device', sub.device_id, now))) {
      const blockId = newBlockId(now.getTime());
      await trx
        .insertInto('blocks')
        .values({
          id: blockId,
          subject_type: 'device',
          subject: sub.device_id,
          reason: `automatic: ${live} hoax strikes`,
          source: 'automatic',
          created_at: now,
          expires_at: new Date(now.getTime() + limits.blockTtlDays * DAY),
        })
        .execute();
      outcomes.push({
        kind: 'device_block_applied',
        blockId,
        deviceId: sub.device_id,
        liveStrikes: live,
        submissionId: sub.id,
        reference: sub.reference,
      });
    }
  }

  await lockSubject(trx, 'phone', sub.phone_hash);
  if ((await insertStrike(trx, 'phone', sub.phone_hash, sub, now, limits)) && limits.hoaxStrikesToBlock > 0) {
    const live = await liveStrikeCount(trx, 'phone', sub.phone_hash, now);
    // A number an operator has already blocked needs no prompt to consider blocking it.
    if (live >= limits.hoaxStrikesToBlock && !(await liveBlockExists(trx, 'phone', sub.phone_hash, now))) {
      outcomes.push({
        kind: 'phone_threshold_reached',
        liveStrikes: live,
        threshold: limits.hoaxStrikesToBlock,
        strikeTtlDays: limits.strikeTtlDays,
        submissionId: sub.id,
        reference: sub.reference,
      });
    }
  }
  return outcomes;
}

/**
 * Removes the strikes of one submission (its call left the hoax state). Then, if the device is now
 * below the threshold, lifts the live automatic device blocks created since that strike: the strike
 * was part of what caused them, and the dispatcher has taken back the judgement they rested on.
 * Phone strikes are removed too; there is no automatic phone block to lift. Manual blocks are never
 * touched. Run inside the caller's transaction.
 */
export async function removeStrikes(
  trx: Db,
  sub: StrikeSubmission,
  now: Date,
  limits: Pick<StrikeLimits, 'hoaxStrikesToBlock'>,
): Promise<StrikeOutcome[]> {
  const outcomes: StrikeOutcome[] = [];

  await lockSubject(trx, 'phone', sub.phone_hash);
  await trx
    .deleteFrom('strikes')
    .where('subject_type', '=', 'phone')
    .where('submission_id', '=', sub.id)
    .execute();

  await lockSubject(trx, 'device', sub.device_id);
  const removed = await trx
    .deleteFrom('strikes')
    .where('subject_type', '=', 'device')
    .where('submission_id', '=', sub.id)
    .returning(['subject', 'created_at'])
    .executeTakeFirst();
  if (!removed) return outcomes;

  const live = await liveStrikeCount(trx, 'device', removed.subject, now);
  if (limits.hoaxStrikesToBlock > 0 && live >= limits.hoaxStrikesToBlock) return outcomes;

  const lifted = await trx
    .deleteFrom('blocks')
    .where('subject_type', '=', 'device')
    .where('subject', '=', removed.subject)
    .where('source', '=', 'automatic')
    .where('created_at', '>=', removed.created_at)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .returning('id')
    .execute();
  for (const b of lifted) {
    outcomes.push({
      kind: 'device_block_lifted',
      blockId: b.id,
      deviceId: removed.subject,
      liveStrikes: live,
      submissionId: sub.id,
      reference: sub.reference,
    });
  }
  return outcomes;
}

/** Warning alerts for device blocks and phone thresholds. Call after the transaction commits. */
export async function raiseStrikeAlerts(
  ctx: Pick<AppContext, 'alerts' | 'log'>,
  outcomes: StrikeOutcome[],
): Promise<void> {
  for (const o of outcomes) {
    if (o.kind === 'phone_threshold_reached') {
      // A phone number is never named, not even by its hash. The reference finds the call in
      // Resgrid, whose contact details show the number, if the operator decides to block it.
      ctx.log.warn(
        {
          liveStrikes: o.liveStrikes,
          threshold: o.threshold,
          receiptId: o.submissionId,
          reference: o.reference,
        },
        'phone number reached the hoax strike threshold; not blocked',
      );
      await ctx.alerts.raise({
        severity: 'warning',
        code: ALERT_CODES.phoneHoaxThreshold,
        message:
          `The phone number given with SOS ${o.reference} has ${o.liveStrikes} unfounded or false-alarm ` +
          `closures in the last ${o.strikeTtlDays} days (threshold ${o.threshold}). It was not blocked: ` +
          'phone numbers are unverified. Review the calls and block the number through the admin API if warranted.',
        reference: o.reference,
        receiptId: o.submissionId,
      });
      continue;
    }
    ctx.log.warn(
      {
        blockId: o.blockId,
        subjectType: 'device',
        deviceId: o.deviceId,
        liveStrikes: o.liveStrikes,
        receiptId: o.submissionId,
        reference: o.reference,
      },
      o.kind === 'device_block_applied' ? 'automatic block applied' : 'automatic block lifted',
    );
    const message =
      o.kind === 'device_block_applied'
        ? `Automatic block ${o.blockId} applied to device ${o.deviceId} after ${o.liveStrikes} hoax closures (latest: SOS ${o.reference})`
        : `Automatic block ${o.blockId} on device ${o.deviceId} lifted: the hoax closure of SOS ${o.reference} was reversed in Core`;
    await ctx.alerts.raise({
      severity: 'warning',
      code: ALERT_CODES.automaticBlock,
      message,
      reference: o.reference,
      receiptId: o.submissionId,
    });
  }
}
