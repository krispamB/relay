/**
 * Startup and hourly check. sos-relay-PRD.md §6.4, §11.2, §13.2, §13.3; integration.md §6, §7.
 *
 * A check reads the call types, the priorities and the new-call field policy, and records the
 * outcome with recordCheck: `ok`, or `unhealthy` with a detail and a critical alert. A 401 / 403
 * pauses delivery. When Core cannot be reached nothing is recorded, so the intake stays available
 * only while the last good check is under 24 hours old, and the check is retried with backoff.
 *
 * The job never throws and never exits the process: a crash loop with a bad key could trip Core's
 * lockout (integration.md §2.4).
 */

import { ALERT_CODES } from '../alerts.js';
import { DAY, HOUR, MINUTE, SECOND } from '../clock.js';
import type { AppContext } from '../context.js';
import type { CoreResult } from '../core/types.js';
import { safeError } from '../errors.js';
import { METRICS } from '../metrics.js';
import { type CheckResult, getState, pauseDelivery, recordCheck } from '../state.js';
import type { Job } from './runner.js';

/** How often the job wakes to see whether a check is due. */
export const POLICY_TICK_MS = 30 * SECOND;
export const CHECK_INTERVAL_MS = HOUR;
/** Retry after Core could not be reached: 1, 2, 4, 8, then every 15 minutes. */
export const RETRY_BASE_MS = MINUTE;
export const RETRY_MAX_MS = 15 * MINUTE;

/** Field-policy keys the relay can never satisfy (integration.md §7). */
export const UNMEETABLE_KEYS = ['what3words', 'incidentId', 'destinationPoi'] as const;

export type PolicyCheckOutcome = 'ok' | 'unhealthy' | 'auth' | 'unreachable' | 'paused';

export function retryDelayMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n - 1, 10));
}

function hasKey(keys: readonly string[], key: string): boolean {
  return keys.some((k) => k.toLowerCase() === key.toLowerCase());
}

/** The check, given what Core answered. Pure; exported for tests. */
export function evaluateCheck(
  input: {
    callTypeNames: string[];
    priorities: { id: number; isDeleted: boolean }[];
    requiredKeys: string[];
  },
  config: { callTypeName: string; priorityId: number },
): CheckResult & { referenceProblems: string[]; unmeetable: string[] } {
  const referenceProblems: string[] = [];
  // integration.md §6.1: exact, case-sensitive match.
  if (!input.callTypeNames.includes(config.callTypeName)) {
    referenceProblems.push(`call type "${config.callTypeName}" not found in Core`);
  }
  const priority = input.priorities.find((p) => p.id === config.priorityId);
  if (!priority) referenceProblems.push(`priority ${config.priorityId} not found in Core`);
  else if (priority.isDeleted) referenceProblems.push(`priority ${config.priorityId} is deleted in Core`);

  const unmeetable = UNMEETABLE_KEYS.filter((k) => hasKey(input.requiredKeys, k));
  const problems = [...referenceProblems];
  if (unmeetable.length > 0) {
    problems.push(`field policy requires ${unmeetable.join(', ')}, which the relay cannot send`);
  }
  return {
    status: problems.length === 0 ? 'ok' : 'unhealthy',
    ...(problems.length > 0 ? { detail: problems.join('; ') } : {}),
    required: {
      location: hasKey(input.requiredKeys, 'geolocation'),
      address: hasKey(input.requiredKeys, 'address'),
      name: hasKey(input.requiredKeys, 'contactName'),
    },
    referenceProblems,
    unmeetable,
  };
}

async function safely<T>(ctx: AppContext, fn: () => Promise<CoreResult<T>>): Promise<CoreResult<T>> {
  try {
    return await fn();
  } catch (err) {
    ctx.log.error({ error: safeError(err) }, 'core client threw');
    return { kind: 'retryable', reason: 'client error' };
  }
}

async function pauseForAuth(ctx: AppContext, reason: string): Promise<void> {
  const flipped = await pauseDelivery(ctx.db, ctx.clock.now(), reason);
  ctx.log.error({ reason, flipped }, 'Core refused the API key; delivery paused');
  if (flipped) {
    ctx.metrics.set(METRICS.paused, 1);
    await ctx.alerts.raise({
      severity: 'critical',
      code: ALERT_CODES.deliveryPaused,
      message: `SOS delivery paused: ${reason}`,
    });
  }
}

/**
 * One check against Core, unless delivery is paused. Exported for tests.
 * Reads stop at the first refusal or failure, so a bad key costs one request, not three.
 */
export async function runPolicyCheck(ctx: AppContext): Promise<PolicyCheckOutcome> {
  if ((await getState(ctx.db)).paused) return 'paused';

  const reads = [
    ['GetAllCallTypes', () => ctx.core.getCallTypes()],
    ['GetAllCallPriorites', () => ctx.core.getCallPriorities()],
    ['GetNewCallFieldPolicy', () => ctx.core.getFieldPolicy()],
  ] as const;
  const data: unknown[] = [];
  for (const [endpoint, read] of reads) {
    const res: CoreResult<unknown> = await safely<unknown>(ctx, read);
    if (res.kind === 'ok') {
      data.push(res.data);
      continue;
    }
    if (res.kind === 'auth') {
      await pauseForAuth(ctx, `Core returned ${res.httpStatus} on ${endpoint}`);
      return 'auth';
    }
    ctx.log.warn(
      {
        endpoint,
        result: res.kind,
        reason: res.kind === 'retryable' ? res.reason : undefined,
        httpStatus: res.kind === 'rejected' ? res.httpStatus : undefined,
      },
      'startup check could not complete; nothing recorded, will retry',
    );
    return 'unreachable';
  }
  const [types, priorities, policy] = data as [
    { names: string[] },
    { priorities: { id: number; isDeleted: boolean }[] },
    { requiredKeys: string[] },
  ];

  const result = evaluateCheck(
    { callTypeNames: types.names, priorities: priorities.priorities, requiredKeys: policy.requiredKeys },
    ctx.config.resgrid,
  );
  // The pause could have been set by another job while we read; a recorded check does not undo it.
  await recordCheck(ctx.db, ctx.clock.now(), {
    status: result.status,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    required: result.required,
  });

  if (result.status === 'ok') {
    ctx.log.info({ required: result.required }, 'startup check passed');
    return 'ok';
  }
  ctx.log.error({ detail: result.detail }, 'startup check failed; the real intake is unavailable');
  if (result.referenceProblems.length > 0) {
    await ctx.alerts.raise({
      severity: 'critical',
      code: ALERT_CODES.referenceMismatch,
      message: `SOS intake unavailable: ${result.referenceProblems.join('; ')}`,
    });
  }
  if (result.unmeetable.length > 0) {
    await ctx.alerts.raise({
      severity: 'critical',
      code: ALERT_CODES.policyUnmeetable,
      message: `SOS intake unavailable: Core's field policy requires ${result.unmeetable.join(', ')}, which the relay cannot send`,
    });
  }
  return 'unhealthy';
}

// ---------------------------------------------------------------------------------------------
// Key expiry (PRD §11.2)
// ---------------------------------------------------------------------------------------------

export type KeyExpiryStage = 'expired' | 'within_7_days' | 'within_30_days';

/** The key is taken to stop working at 00:00 UTC on the configured date, as the admin health does. */
export function keyExpiryStage(expiresOn: string, now: Date): KeyExpiryStage | undefined {
  const at = new Date(`${expiresOn}T00:00:00Z`).getTime();
  if (Number.isNaN(at)) return undefined;
  const left = at - now.getTime();
  if (left <= 0) return 'expired';
  if (left <= 7 * DAY) return 'within_7_days';
  if (left <= 30 * DAY) return 'within_30_days';
  return undefined;
}

/** alert_log row that remembers the last key-expiry warning per stage (the purge drops it after a day). */
export function keyExpiryLogCode(stage: KeyExpiryStage): string {
  return `${ALERT_CODES.keyExpiring}:${stage}`;
}

/**
 * Warns at most once a day per stage, and at once when a more urgent stage begins. The Alerter only
 * de-duplicates within 15 minutes, so the daily memory is a row of its own in alert_log, claimed
 * with one atomic upsert so two instances do not both send.
 */
export async function checkKeyExpiry(ctx: AppContext): Promise<KeyExpiryStage | undefined> {
  const now = ctx.clock.now();
  const { apiKeyExpiresOn } = ctx.config.resgrid;
  const stage = keyExpiryStage(apiKeyExpiresOn, now);
  if (!stage) return undefined;

  const claimed = await ctx.db
    .insertInto('alert_log')
    .values({ code: keyExpiryLogCode(stage), last_sent_at: now })
    .onConflict((oc) =>
      oc
        .column('code')
        .doUpdateSet({ last_sent_at: now })
        .where('alert_log.last_sent_at', '<=', new Date(now.getTime() - DAY)),
    )
    .returning('code')
    .executeTakeFirst();
  if (!claimed) return stage;

  const days = Math.ceil((new Date(`${apiKeyExpiresOn}T00:00:00Z`).getTime() - now.getTime()) / DAY);
  const message =
    stage === 'expired'
      ? `The Resgrid API key expired on ${apiKeyExpiresOn}. Core will refuse it; replace it now.`
      : `The Resgrid API key expires on ${apiKeyExpiresOn} (in ${days} day${days === 1 ? '' : 's'}). Replace it before then.`;
  await ctx.alerts.raise({ severity: 'warning', code: ALERT_CODES.keyExpiring, message });
  return stage;
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

export interface PolicyCheckerJob extends Job {
  /** When the next check is due (ms since epoch). For tests and the admin view. */
  nextCheckAt(): number;
}

/**
 * Wakes every 30 s; checks at start, then an hour after each completed check. After Core could not
 * be reached it retries at 1, 2, 4, 8, then every 15 minutes. While paused it checks nothing and
 * runs a check as soon as delivery is resumed.
 */
export function createPolicyChecker(ctx: AppContext): PolicyCheckerJob {
  let nextAt = 0;
  let failures = 0;
  let nextKeyCheckAt = 0;

  async function run(): Promise<void> {
    const now = ctx.clock.now().getTime();
    try {
      if (now >= nextKeyCheckAt) {
        nextKeyCheckAt = now + HOUR;
        await checkKeyExpiry(ctx);
      }
    } catch (err) {
      ctx.log.error({ error: safeError(err) }, 'key expiry check failed');
    }
    if (now < nextAt) return;

    let outcome: PolicyCheckOutcome;
    try {
      outcome = await runPolicyCheck(ctx);
    } catch (err) {
      // A database error, most likely: treat like an unreachable Core.
      ctx.log.error({ error: safeError(err) }, 'startup check failed unexpectedly');
      outcome = 'unreachable';
    }
    const after = ctx.clock.now().getTime();
    switch (outcome) {
      case 'ok':
      case 'unhealthy':
        failures = 0;
        nextAt = after + CHECK_INTERVAL_MS;
        break;
      case 'paused':
      case 'auth':
        // Paused: nothing to do until an operator resumes; look again on every tick.
        failures = 0;
        nextAt = after;
        break;
      case 'unreachable':
        failures += 1;
        nextAt = after + retryDelayMs(failures);
        break;
    }
  }

  return {
    name: 'policy-checker',
    intervalMs: POLICY_TICK_MS,
    run,
    nextCheckAt: () => nextAt,
  };
}
