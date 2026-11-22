/**
 * The unit poll step of the status poller (docs/live-sos-plan.md §5.1, D11, D12, D13).
 *
 * Runs only while at least one watched SOS is `dispatched` and `relay_state.units_next_poll_at` has
 * passed. The step is claimed under an advisory lock by moving `units_next_poll_at` forward by
 * UNIT_POLL_INTERVAL_S before Core is called, so two instances never call GetAllUnitStatuses within
 * one interval. One call covers every SOS in the department.
 *
 * For each watched dispatched SOS, in one transaction each, its `submission_units` rows are replaced
 * by the units whose status destination is its call (DestinationType 2, DestinationId = call id),
 * keyed by an HMAC of the Core unit id. Only type, status text, coordinates and status time are kept;
 * nothing else from the response (names, groups, notes, other units' positions) is stored. The live
 * version is bumped only when one of those, or the set of keys, changed.
 *
 * A 401/403 pauses delivery like the other Core reads (the call takes no id, so it can only mean the
 * key, e.g. a key without `units.read`). Any other failure waits for the next interval.
 */
import { sql } from 'kysely';
import { deriveAuthKeys } from '../auth/keys.js';
import { addMs, HOUR, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { CoreUnitStatus } from '../core/types.js';
import type { Db } from '../db/index.js';
import { unitKey, unitsForCall } from '../live/units.js';
import { bumpLiveVersion } from '../live/version.js';
import { pauseForAuth, safely } from './coreRead.js';

/** Serialises the unit-poll claim across instances. */
const UNITS_CLAIM_LOCK = 0x534f_5302;
/** Must match the status poller's window: an SOS past it is not polled. */
const WINDOW_MS = 24 * HOUR;

interface UnitRow {
  unit_key: string;
  unit_type: string | null;
  status_text: string | null;
  lat: number | null;
  lon: number | null;
  status_at: Date | null;
}

const secrets = new Map<string, string>();

/** The unit-key HMAC secret, derived once per AUTH_TOKEN_SECRET (src/auth/keys.ts, `liveUnit`). */
function unitKeySecret(tokenSecret: string): string {
  let secret = secrets.get(tokenSecret);
  if (secret === undefined) {
    secret = deriveAuthKeys(tokenSecret).liveUnit.toString('hex');
    secrets.set(tokenSecret, secret);
  }
  return secret;
}

/** Watched, dispatched, real SOS with a Core call, inside the status window. */
function watchedDispatched(db: Db, now: Date) {
  return db
    .selectFrom('submissions')
    .where('status', '=', 'dispatched')
    .where('is_demo', '=', false)
    .where('core_call_id', 'is not', null)
    .where('live_watch_until', '>', now)
    .where('accepted_at', '>', new Date(now.getTime() - WINDOW_MS));
}

async function claim(ctx: AppContext): Promise<boolean> {
  return ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${UNITS_CLAIM_LOCK}::bigint)`.execute(trx);
    const now = ctx.clock.now();
    const state = await trx
      .selectFrom('relay_state')
      .select('units_next_poll_at')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (state.units_next_poll_at !== null && state.units_next_poll_at > now) return false;
    const any = await watchedDispatched(trx, now).select('id').limit(1).executeTakeFirst();
    if (!any) return false;
    await trx
      .updateTable('relay_state')
      .set({ units_next_poll_at: addMs(now, ctx.config.unitPollIntervalS * SECOND) })
      .where('id', '=', 1)
      .execute();
    return true;
  });
}

function toRows(units: CoreUnitStatus[], callId: string, secret: string): UnitRow[] {
  const byKey = new Map<string, UnitRow>();
  for (const u of unitsForCall(units, callId)) {
    const key = unitKey(secret, u.unitId);
    if (byKey.has(key)) continue;
    const at = u.timestamp === null ? null : new Date(u.timestamp);
    byKey.set(key, {
      unit_key: key,
      unit_type: u.unitType,
      status_text: u.statusText,
      lat: u.latitude,
      lon: u.longitude,
      status_at: at !== null && !Number.isNaN(at.getTime()) ? at : null,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0));
}

function sameRows(a: UnitRow[], b: UnitRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.unit_key === y.unit_key &&
      x.unit_type === y.unit_type &&
      x.status_text === y.status_text &&
      x.lat === y.lat &&
      x.lon === y.lon &&
      (x.status_at?.getTime() ?? null) === (y.status_at?.getTime() ?? null)
    );
  });
}

/** Replaces one SOS's units if they changed. Returns true when it bumped. */
async function applyUnits(ctx: AppContext, submissionId: string, units: CoreUnitStatus[]): Promise<boolean> {
  return ctx.db.transaction().execute(async (trx) => {
    const sub = await trx
      .selectFrom('submissions')
      .select(['id', 'status', 'core_call_id'])
      .where('id', '=', submissionId)
      .forUpdate()
      .executeTakeFirst();
    // Left dispatched meanwhile: the transition already deleted its units.
    if (sub?.status !== 'dispatched' || sub.core_call_id === null) return false;
    const next = toRows(units, sub.core_call_id, unitKeySecret(ctx.config.auth.tokenSecret));
    const current = await trx
      .selectFrom('submission_units')
      .select(['unit_key', 'unit_type', 'status_text', 'lat', 'lon', 'status_at'])
      .where('submission_id', '=', sub.id)
      .orderBy('unit_key')
      .execute();
    if (sameRows(current, next)) return false;
    await trx.deleteFrom('submission_units').where('submission_id', '=', sub.id).execute();
    if (next.length > 0) {
      await trx
        .insertInto('submission_units')
        .values(next.map((row) => ({ ...row, submission_id: sub.id })))
        .execute();
    }
    await bumpLiveVersion(trx, sub.id);
    return true;
  });
}

/** One unit poll step. `pass.stop` is set when the key was refused and delivery paused. */
export async function pollUnits(ctx: AppContext, pass: { stop: boolean }): Promise<void> {
  if (!(await claim(ctx))) return;

  const res = await safely(ctx, () => ctx.core.getAllUnitStatuses());
  if (res.kind === 'auth') {
    await pauseForAuth(ctx, `Core returned ${res.httpStatus} on GetAllUnitStatuses`);
    pass.stop = true;
    return;
  }
  if (res.kind !== 'ok') {
    ctx.log.warn(
      { result: res.kind, reason: res.kind === 'retryable' ? res.reason : undefined },
      'GetAllUnitStatuses failed; units will be read at the next interval',
    );
    return;
  }

  const targets = await watchedDispatched(ctx.db, ctx.clock.now()).select('id').orderBy('id').execute();
  let changed = 0;
  for (const { id } of targets) {
    if (await applyUnits(ctx, id, res.data.units)) changed += 1;
  }
  if (changed > 0) ctx.log.debug({ submissions: targets.length, changed }, 'units updated');
}
