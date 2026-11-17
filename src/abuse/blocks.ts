import type { Db } from '../db/index.js';
import type { SubjectType } from '../db/types.js';

/**
 * True when a live block exists (PRD §9.2). `subject` is a device id, or the keyed hash of a
 * phone number from `phoneHash()` — never a phone number in the clear.
 */
export async function isBlocked(db: Db, type: SubjectType, subject: string, now: Date): Promise<boolean> {
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
