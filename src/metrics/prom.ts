import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { type Labels, METRICS, type MetricName, type Metrics } from '../metrics.js';

export type PromMetrics = Metrics & { render(): Promise<string>; contentType: string };

/** Buckets for requests that take 50 ms to 8 s. */
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 6, 8, 12];

const HELP = 'See sos-relay-PRD.md section 11.3';

/** Own registry per instance, so tests can create several. */
export function createPromMetrics(): PromMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const counters = new Map<string, { m: Counter<string>; labels: string[] }>();
  const histograms = new Map<string, { m: Histogram<string>; labels: string[] }>();
  const gauges = new Map<string, { m: Gauge<string>; labels: string[] }>();

  const counter = (name: string, labelNames: string[]) => {
    counters.set(name, {
      m: new Counter({ name, help: HELP, labelNames, registers: [registry] }),
      labels: labelNames,
    });
  };
  const histogram = (name: string, labelNames: string[]) => {
    histograms.set(name, {
      m: new Histogram({ name, help: HELP, labelNames, buckets: LATENCY_BUCKETS, registers: [registry] }),
      labels: labelNames,
    });
  };
  const gauge = (name: string, labelNames: string[]) => {
    gauges.set(name, {
      m: new Gauge({ name, help: HELP, labelNames, registers: [registry] }),
      labels: labelNames,
    });
  };

  counter(METRICS.submissions, ['outcome']);
  counter(METRICS.coreCalls, ['endpoint', 'result']);
  counter(METRICS.attestations, ['platform', 'phase', 'result']);
  counter(METRICS.rateLimited, ['rule']);
  histogram(METRICS.coreLatency, ['endpoint']);
  histogram(METRICS.sosLatency, []);
  gauge(METRICS.queueDepth, []);
  gauge(METRICS.oldestQueuedAge, []);
  gauge(METRICS.paused, []);
  counter(METRICS.authSignups, ['result']);
  counter(METRICS.authRefreshes, ['result']);
  counter(METRICS.authSignouts, ['result']);
  counter(METRICS.authSignins, ['result']);

  /** Keeps only the declared labels, so a stray label cannot throw or add cardinality. */
  const pick = (allowed: string[], labels?: Labels): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of allowed) {
      const v = labels?.[k];
      if (v !== undefined) out[k] = String(v);
    }
    return out;
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Metrics must never break the caller.
    }
  };

  return {
    contentType: registry.contentType,
    inc(name: MetricName, labels?: Labels, value = 1) {
      const c = counters.get(name);
      if (c) safe(() => c.m.inc(pick(c.labels, labels), value));
    },
    observe(name: MetricName, seconds: number, labels?: Labels) {
      const h = histograms.get(name);
      if (h) safe(() => h.m.observe(pick(h.labels, labels), seconds));
    },
    set(name: MetricName, value: number, labels?: Labels) {
      const g = gauges.get(name);
      if (g) safe(() => g.m.set(pick(g.labels, labels), value));
    },
    render: () => registry.metrics(),
  };
}
