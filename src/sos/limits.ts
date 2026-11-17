/**
 * SOS rate limits. sos-relay-PRD.md §6.3, §9.1.
 *
 * Counted from the submissions table: only accepted submissions count, so refused requests and
 * replays never do. Demo and real submissions are counted apart in every rule. A limit of 0 is off.
 */
import { DAY, HOUR, SECOND } from '../clock.js';
import type { Limits } from '../config.js';
import type { Db } from '../db/index.js';

export type LimitRule = 'sos_per_device' | 'sos_per_phone' | 'sos_per_ip' | 'intake_breaker';

export interface LimitScope {
  deviceId: string;
  phoneHash: string;
  ip: string;
  intakeCode: string;
  demo: boolean;
}

export interface LimitHit {
  rule: LimitRule;
  /** Seconds until enough counted submissions leave the window for one more to fit. At least 1. */
  retryAfterSeconds: number;
}

interface Rule {
  rule: LimitRule;
  max: number;
  windowMs: number;
  column: 'device_id' | 'phone_hash' | 'ip' | 'intake_code';
  value: string;
}

/** The rules in the order they are checked: per-caller limits first, then the whole-intake breaker. */
export function sosRules(scope: LimitScope, limits: Limits): Rule[] {
  return [
    {
      rule: 'sos_per_device',
      max: limits.sosPerDevicePer24h,
      windowMs: DAY,
      column: 'device_id',
      value: scope.deviceId,
    },
    {
      rule: 'sos_per_phone',
      max: limits.sosPerPhonePer24h,
      windowMs: DAY,
      column: 'phone_hash',
      value: scope.phoneHash,
    },
    { rule: 'sos_per_ip', max: limits.sosPerIpPerHour, windowMs: HOUR, column: 'ip', value: scope.ip },
    {
      rule: 'intake_breaker',
      max: limits.intakeBreakerCount,
      windowMs: limits.intakeBreakerWindowS * SECOND,
      column: 'intake_code',
      value: scope.intakeCode,
    },
  ];
}

/**
 * Checks one rule. Finds the max-th newest counted submission inside the window: if there is one,
 * the limit is reached, and once that one leaves the window only max - 1 remain, so its exit time
 * is the retry time. With exactly max counted, it is the oldest.
 */
async function checkRule(db: Db, r: Rule, demo: boolean, now: Date): Promise<LimitHit | undefined> {
  if (r.max <= 0 || r.windowMs <= 0) return undefined;
  const windowStart = new Date(now.getTime() - r.windowMs);
  const row = await db
    .selectFrom('submissions')
    .select('accepted_at')
    .where(r.column, '=', r.value)
    .where('is_demo', '=', demo)
    .where('accepted_at', '>', windowStart)
    .orderBy('accepted_at', 'desc')
    .offset(r.max - 1)
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  const leavesAt = row.accepted_at.getTime() + r.windowMs;
  return { rule: r.rule, retryAfterSeconds: Math.max(1, Math.ceil((leavesAt - now.getTime()) / 1000)) };
}

/** Returns the first rule the request would break, or undefined. */
export async function checkSosLimits(
  db: Db,
  scope: LimitScope,
  limits: Limits,
  now: Date,
): Promise<LimitHit | undefined> {
  for (const r of sosRules(scope, limits)) {
    const hit = await checkRule(db, r, scope.demo, now);
    if (hit) return hit;
  }
  return undefined;
}
