/**
 * Hoax strikes and automatic blocks. sos-relay-PRD.md §9.2, §8.5.
 *
 * A strike is recorded for the device and for the phone hash when the poller sees a real
 * submission's call closed as Unfounded (3) or False alarm (7). Enough live strikes block the
 * subject automatically. When the call later leaves the hoax state, that submission's strikes are
 * removed, and an automatic block they made possible is lifted (see removeStrikes).
 *
 * The functions that write run inside the caller's transaction and return what happened; the caller
 * raises alerts after the commit with raiseBlockAlerts.
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

/** A block applied or lifted by this module. `subject` is a device id or a phone hash. */
export interface BlockChange {
  change: 'applied' | 'lifted';
  blockId: string;
  subjectType: SubjectType;
  subject: string;
  liveStrikes: number;
  /** The submission whose closure caused the change (for the alert's reference and receiptId). */
  submissionId: string;
  reference: string;
}

function subjectsOf(sub: StrikeSubmission): Array<{ type: SubjectType; subject: string }> {
  return [
    { type: 'device', subject: sub.device_id },
    { type: 'phone', subject: sub.phone_hash },
  ];
}

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

/**
 * Records one strike for the device and one for the phone hash (idempotent per submission), then
 * applies an automatic block to a subject that reached the threshold and has no live block.
 * A threshold of 0 records strikes and never blocks. Run inside the caller's transaction.
 */
export async function recordHoaxStrikes(
  trx: Db,
  sub: StrikeSubmission,
  now: Date,
  limits: StrikeLimits,
): Promise<BlockChange[]> {
  const changes: BlockChange[] = [];
  for (const { type, subject } of subjectsOf(sub)) {
    await lockSubject(trx, type, subject);
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
    if (!inserted || limits.hoaxStrikesToBlock <= 0) continue;

    const live = await liveStrikeCount(trx, type, subject, now);
    if (live < limits.hoaxStrikesToBlock || (await liveBlockExists(trx, type, subject, now))) continue;

    const blockId = newBlockId(now.getTime());
    await trx
      .insertInto('blocks')
      .values({
        id: blockId,
        subject_type: type,
        subject,
        reason: `automatic: ${live} hoax strikes`,
        source: 'automatic',
        created_at: now,
        expires_at: new Date(now.getTime() + limits.blockTtlDays * DAY),
      })
      .execute();
    changes.push({
      change: 'applied',
      blockId,
      subjectType: type,
      subject,
      liveStrikes: live,
      submissionId: sub.id,
      reference: sub.reference,
    });
  }
  return changes;
}

/**
 * Removes the strikes of one submission (its call left the hoax state). Then, for each subject now
 * below the threshold, lifts the live automatic blocks created since that strike: the strike was
 * part of what caused them, and the dispatcher has taken back the judgement they rested on.
 * Manual blocks are never touched. Run inside the caller's transaction.
 */
export async function removeStrikes(
  trx: Db,
  sub: StrikeSubmission,
  now: Date,
  limits: Pick<StrikeLimits, 'hoaxStrikesToBlock'>,
): Promise<BlockChange[]> {
  const changes: BlockChange[] = [];
  for (const { type, subject } of subjectsOf(sub)) {
    await lockSubject(trx, type, subject);
    const removed = await trx
      .deleteFrom('strikes')
      .where('subject_type', '=', type)
      .where('submission_id', '=', sub.id)
      .returning(['subject', 'created_at'])
      .executeTakeFirst();
    if (!removed) continue;

    const live = await liveStrikeCount(trx, type, removed.subject, now);
    if (limits.hoaxStrikesToBlock > 0 && live >= limits.hoaxStrikesToBlock) continue;

    const lifted = await trx
      .deleteFrom('blocks')
      .where('subject_type', '=', type)
      .where('subject', '=', removed.subject)
      .where('source', '=', 'automatic')
      .where('created_at', '>=', removed.created_at)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .returning('id')
      .execute();
    for (const b of lifted) {
      changes.push({
        change: 'lifted',
        blockId: b.id,
        subjectType: type,
        subject: removed.subject,
        liveStrikes: live,
        submissionId: sub.id,
        reference: sub.reference,
      });
    }
  }
  return changes;
}

/** Warning alerts for applied and lifted blocks. Call after the transaction commits. */
export async function raiseBlockAlerts(
  ctx: Pick<AppContext, 'alerts' | 'log'>,
  changes: BlockChange[],
): Promise<void> {
  for (const c of changes) {
    // A device is named by its id; a phone number is never named, not even by its hash.
    const who = c.subjectType === 'device' ? `device ${c.subject}` : 'a phone number';
    ctx.log.warn(
      {
        blockId: c.blockId,
        subjectType: c.subjectType,
        deviceId: c.subjectType === 'device' ? c.subject : undefined,
        liveStrikes: c.liveStrikes,
        receiptId: c.submissionId,
        reference: c.reference,
      },
      c.change === 'applied' ? 'automatic block applied' : 'automatic block lifted',
    );
    const message =
      c.change === 'applied'
        ? `Automatic block ${c.blockId} applied to ${who} after ${c.liveStrikes} hoax closures (latest: SOS ${c.reference})`
        : `Automatic block ${c.blockId} on ${who} lifted: the hoax closure of SOS ${c.reference} was reversed in Core`;
    await ctx.alerts.raise({
      severity: 'warning',
      code: ALERT_CODES.automaticBlock,
      message,
      reference: c.reference,
      receiptId: c.submissionId,
    });
  }
}
