import type { Alert, Alerter, Severity } from '../alerts.js';
import { type Clock, MINUTE } from '../clock.js';
import type { Db } from '../db/index.js';
import { safeError } from '../errors.js';
import type { Logger } from '../logger.js';

export const ALERT_DEDUP_MS = 15 * MINUTE;

export interface WebhookAlerterDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  webhookUrl: string | undefined;
  fetchImpl?: typeof fetch;
  /** Per-try timeout. Default 3000. */
  timeoutMs?: number;
  /** Waits before the second and third try. Default [500, 2000]. */
  retryDelaysMs?: number[];
}

export type FlushableAlerter = Alerter & {
  /** Resolves when every delivery started so far has finished (sent or given up). */
  flush(): Promise<void>;
};

const LOG_LEVEL: Record<Severity, 'fatal' | 'error' | 'warn'> = {
  critical: 'fatal',
  high: 'error',
  warning: 'warn',
};

/** PRD §11.2. Always logs; posts to the webhook at most once per code per 15 minutes. */
export function createWebhookAlerter(deps: WebhookAlerterDeps): FlushableAlerter {
  const { db, clock, log, webhookUrl } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const delays = deps.retryDelaysMs ?? [500, 2000];
  const inflight = new Set<Promise<void>>();

  /** True when this call won the right to send. Atomic across instances: one upsert statement. */
  async function claim(code: string, now: Date, always: boolean): Promise<boolean> {
    const cutoff = new Date(now.getTime() - ALERT_DEDUP_MS);
    const q = db
      .insertInto('alert_log')
      .values({ code, last_sent_at: now })
      .onConflict((oc) => {
        const upd = oc.column('code').doUpdateSet({ last_sent_at: now });
        return always ? upd : upd.where('alert_log.last_sent_at', '<=', cutoff);
      })
      .returning('code');
    const row = await q.executeTakeFirst();
    return row !== undefined;
  }

  async function attempt(body: string): Promise<boolean> {
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([
        doFetch(webhookUrl as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: ctl.signal,
        }),
        timeout,
      ]);
      if (res === 'timeout') return false;
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(alert: Alert, at: Date): Promise<void> {
    const body = JSON.stringify({
      severity: alert.severity,
      code: alert.code,
      text: `[${alert.severity}] ${alert.message}`,
      reference: alert.reference ?? null,
      receiptId: alert.receiptId ?? null,
      at: at.toISOString(),
    });
    const tries = delays.length + 1;
    for (let i = 0; i < tries; i++) {
      if (await attempt(body)) return;
      if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
    }
    // Never log the URL or the error text: either may carry the secret.
    log.error({ code: alert.code, tries }, 'alert webhook delivery failed');
  }

  return {
    async raise(alert: Alert): Promise<void> {
      try {
        const now = clock.now();
        log[LOG_LEVEL[alert.severity]](
          {
            alert: alert.code,
            severity: alert.severity,
            reference: alert.reference,
            receiptId: alert.receiptId,
          },
          alert.message,
        );
        if (!webhookUrl) return;
        let send = true;
        try {
          send = await claim(alert.code, now, alert.always === true);
        } catch (err) {
          // Better a duplicate alert than none.
          log.error(
            { error: safeError(err), code: alert.code },
            'alert de-duplication failed; sending anyway',
          );
        }
        if (!send) return;
        const p: Promise<void> = deliver(alert, now)
          .catch(() => {})
          .finally(() => inflight.delete(p));
        inflight.add(p);
      } catch {
        // raise() never throws.
      }
    },
    async flush(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
