/** Retry schedule. sos-relay-PRD.md §8.3. */

/** Delay before retry n (1-based): 5 s, 15 s, 30 s, 60 s, then every 60 s. */
export const RETRY_SCHEDULE_S = [5, 15, 30, 60] as const;

/**
 * Seconds to wait after the `failedAttempts`-th failed attempt (1 = the first attempt just failed).
 * A Retry-After from Core (429) replaces the scheduled delay, with a floor of one second.
 */
export function retryDelaySeconds(failedAttempts: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(1, Math.ceil(retryAfterSeconds));
  }
  const i = Math.max(1, Math.floor(failedAttempts)) - 1;
  return RETRY_SCHEDULE_S[Math.min(i, RETRY_SCHEDULE_S.length - 1)]!;
}

export function nextAttemptAt(now: Date, failedAttempts: number, retryAfterSeconds?: number): Date {
  return new Date(now.getTime() + retryDelaySeconds(failedAttempts, retryAfterSeconds) * 1000);
}
