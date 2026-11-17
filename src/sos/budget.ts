/**
 * The time budget of one `POST /v1/sos`. sos-relay-PRD.md §8.1 step 2, AC2.
 *
 * Measured with a monotonic timer from the moment the request arrives. The values can be replaced
 * (tests shrink them so a "slow Core" test waits milliseconds, not seconds).
 */
import { SECOND } from '../clock.js';

export interface SosBudget {
  /** Total time the request may take before it must answer. */
  totalMs: number;
  /** Cap on the inline SaveCall. */
  maxInlineMs: number;
  /** Kept back for the work after the Core call: the outcome write, the reply. */
  reserveMs: number;
  /** Below this, an inline attempt is not worth starting; the worker takes the submission. */
  minInlineMs: number;
}

export const DEFAULT_SOS_BUDGET: Readonly<SosBudget> = Object.freeze({
  totalMs: 7500,
  maxInlineMs: 6000,
  reserveMs: 300,
  minInlineMs: 500,
});

/**
 * A new row's next_attempt_at is set this far past accepted_at, beyond any inline attempt, so the
 * worker cannot pick it up while the inline attempt runs (PRD §8.3). It is in microseconds with a
 * sub-millisecond part on purpose: every time the delivery code writes comes from a JS Date, which
 * has whole milliseconds, so a row still holding exactly this value was not rescheduled by anyone.
 */
export const INLINE_HOLD_US = 20 * SECOND * 1000 + 1;

let current: SosBudget = { ...DEFAULT_SOS_BUDGET };

export function sosBudget(): Readonly<SosBudget> {
  return current;
}

/** For tests. */
export function setSosBudget(patch: Partial<SosBudget>): void {
  current = { ...current, ...patch };
}

/** For tests. */
export function resetSosBudget(): void {
  current = { ...DEFAULT_SOS_BUDGET };
}

/** The SaveCall timeout to use after `elapsedMs` of the request, or undefined to skip the inline attempt. */
export function inlineTimeoutMs(elapsedMs: number, b: Readonly<SosBudget> = current): number | undefined {
  const left = Math.floor(Math.min(b.maxInlineMs, b.totalMs - elapsedMs - b.reserveMs));
  return left >= b.minInlineMs ? left : undefined;
}
