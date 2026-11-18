/** Metrics contract. See sos-relay-PRD.md §11.3. The Prometheus implementation lives in metrics/prom.ts. */
export type Labels = Record<string, string>;

export interface Metrics {
  inc(name: MetricName, labels?: Labels, value?: number): void;
  observe(name: MetricName, seconds: number, labels?: Labels): void;
  set(name: MetricName, value: number, labels?: Labels): void;
}

/** Every metric the relay emits. Labels must never carry personal data. */
export const METRICS = {
  /** counter {outcome: received|failed|queued|not_sent|replay|conflict} */
  submissions: 'sos_submissions_total',
  /** counter {endpoint, result: ok|auth|conflict|rejected|retryable} */
  coreCalls: 'sos_core_calls_total',
  /** counter {platform, phase: register|request, result: ok|failed|missing} */
  attestations: 'sos_attestations_total',
  /** counter {rule} */
  rateLimited: 'sos_rate_limited_total',
  /** histogram {endpoint} */
  coreLatency: 'sos_core_call_duration_seconds',
  /** histogram */
  sosLatency: 'sos_request_duration_seconds',
  /** gauge */
  queueDepth: 'sos_queue_depth',
  /** gauge */
  oldestQueuedAge: 'sos_oldest_queued_age_seconds',
  /** gauge 0|1 */
  paused: 'sos_delivery_paused',
  /** counter {result: created|replay} */
  authSignups: 'auth_signups_total',
  /** counter {result: rotated|grace|reuse_detected|revoked|invalid|rate_limited} */
  authRefreshes: 'auth_refreshes_total',
  /** counter {result: revoked|noop} */
  authSignouts: 'auth_signouts_total',
  /** counter {result: success|invalid_credentials|rate_limited} */
  authSignins: 'auth_signins_total',
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

export class NoopMetrics implements Metrics {
  inc(): void {}
  observe(): void {}
  set(): void {}
}
