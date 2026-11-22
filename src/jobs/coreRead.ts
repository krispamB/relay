/** Shared by the status poller and its unit poll step: how a Core read fails safely and pauses. */
import { ALERT_CODES } from '../alerts.js';
import type { AppContext } from '../context.js';
import type { CoreResult } from '../core/types.js';
import { safeError } from '../errors.js';
import { METRICS } from '../metrics.js';
import { pauseDelivery } from '../state.js';

/** The client is not supposed to throw; if it does, treat it as a transient failure. */
export async function safely<T>(ctx: AppContext, fn: () => Promise<CoreResult<T>>): Promise<CoreResult<T>> {
  try {
    return await fn();
  } catch (err) {
    ctx.log.error({ error: safeError(err) }, 'core client threw');
    return { kind: 'retryable', reason: 'client error' };
  }
}

/** PRD §8.4: pause, and raise the critical alert only if this call is the one that paused. */
export async function pauseForAuth(ctx: AppContext, reason: string): Promise<void> {
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
