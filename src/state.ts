/** The single relay_state row: pause and health. See sos-relay-PRD.md §6.4, §8.4, §13.2. */
import { DAY } from './clock.js';
import type { Db } from './db/index.js';
import type { RelayStateRow } from './db/types.js';

export async function getState(db: Db): Promise<RelayStateRow> {
  return db.selectFrom('relay_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
}

export type UnavailableReason = 'paused' | 'unhealthy' | 'unverified';

/** PRD §6.4. Returns undefined when the real intake can take an SOS. */
export function unavailableReason(state: RelayStateRow, now: Date): UnavailableReason | undefined {
  if (state.paused) return 'paused';
  if (state.check_status === 'unhealthy') return 'unhealthy';
  if (!state.check_ok_at || now.getTime() - state.check_ok_at.getTime() > DAY) return 'unverified';
  return undefined;
}

/** Sets the pause flag. Returns true only if this call changed it (so the caller alerts once). */
export async function pauseDelivery(db: Db, now: Date, reason: string): Promise<boolean> {
  const res = await db
    .updateTable('relay_state')
    .set({ paused: true, paused_reason: reason, paused_at: now })
    .where('id', '=', 1)
    .where('paused', '=', false)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function resumeDelivery(db: Db): Promise<void> {
  await db
    .updateTable('relay_state')
    .set({ paused: false, paused_reason: null, paused_at: null })
    .where('id', '=', 1)
    .execute();
}

export interface CheckResult {
  status: 'ok' | 'unhealthy';
  detail?: string;
  required: { location: boolean; address: boolean; name: boolean };
}

/** Records a completed startup / hourly check. A check that could not reach Core is not recorded here. */
export async function recordCheck(db: Db, now: Date, result: CheckResult): Promise<void> {
  await db
    .updateTable('relay_state')
    .set({
      check_status: result.status,
      check_detail: result.detail ?? null,
      check_at: now,
      ...(result.status === 'ok' ? { check_ok_at: now } : {}),
      required_location: result.required.location,
      required_address: result.required.address,
      required_name: result.required.name,
    })
    .where('id', '=', 1)
    .execute();
}
