import { describe, expect, it } from 'vitest';
import { createPromMetrics } from '../../src/metrics/prom.js';
import { METRICS, type MetricName } from '../../src/metrics.js';

describe('prom metrics', () => {
  it('renders counters, histograms and gauges with their labels', async () => {
    const m = createPromMetrics();
    m.inc(METRICS.submissions, { outcome: 'received' });
    m.inc(METRICS.coreCalls, { endpoint: 'SaveCall', result: 'ok' }, 3);
    m.inc(METRICS.attestations, { platform: 'ios', phase: 'request', result: 'ok' });
    m.inc(METRICS.rateLimited, { rule: 'device' });
    m.observe(METRICS.coreLatency, 0.3, { endpoint: 'SaveCall' });
    m.observe(METRICS.sosLatency, 7.5);
    m.set(METRICS.queueDepth, 4);
    m.set(METRICS.oldestQueuedAge, 120);
    m.set(METRICS.paused, 1);
    const out = await m.render();
    expect(out).toContain('# TYPE sos_submissions_total counter');
    expect(out).toContain('sos_submissions_total{outcome="received"} 1');
    expect(out).toContain('sos_core_calls_total{endpoint="SaveCall",result="ok"} 3');
    expect(out).toContain('sos_attestations_total{platform="ios",phase="request",result="ok"} 1');
    expect(out).toContain('sos_rate_limited_total{rule="device"} 1');
    expect(out).toContain('# TYPE sos_core_call_duration_seconds histogram');
    expect(out).toContain('sos_core_call_duration_seconds_bucket{le="0.5",endpoint="SaveCall"} 1');
    expect(out).toContain('sos_request_duration_seconds_bucket{le="8"} 1');
    expect(out).toContain('sos_queue_depth 4');
    expect(out).toContain('sos_oldest_queued_age_seconds 120');
    expect(out).toContain('sos_delivery_paused 1');
    expect(out).toContain('process_cpu_user_seconds_total');
    expect(m.contentType).toMatch(/^text\/plain/);
  });

  it('does not throw on unknown names, unknown or missing labels, or bad values', async () => {
    const m = createPromMetrics();
    expect(() => {
      m.inc('nope' as MetricName);
      m.observe('nope' as MetricName, 1);
      m.set('nope' as MetricName, 1);
      m.inc(METRICS.submissions, { outcome: 'received', extra: 'x' });
      m.inc(METRICS.submissions);
      m.inc(METRICS.submissions, { outcome: 'received' }, -1);
      m.set(METRICS.queueDepth, Number.NaN);
    }).not.toThrow();
    const out = await m.render();
    expect(out).not.toContain('extra');
    expect(out).toContain('sos_submissions_total{outcome="received"} 1');
  });

  it('keeps separate state per instance', async () => {
    const a = createPromMetrics();
    const b = createPromMetrics();
    a.inc(METRICS.rateLimited, { rule: 'ip' });
    expect(await a.render()).toContain('sos_rate_limited_total{rule="ip"} 1');
    expect(await b.render()).not.toContain('sos_rate_limited_total{rule="ip"}');
  });
});
