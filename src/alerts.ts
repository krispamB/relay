/** Alert contract. See sos-relay-PRD.md §11.2. The webhook implementation lives in alerts/webhook.ts. */
export type Severity = 'critical' | 'high' | 'warning';

export interface Alert {
  severity: Severity;
  /** Stable machine code, e.g. "delivery_paused". Used for de-duplication. */
  code: string;
  /** Human sentence. Must contain no personal data: reference and receipt id only. */
  message: string;
  reference?: string;
  receiptId?: string;
  /** Send even if the same code was sent in the last 15 minutes (failed submissions). */
  always?: boolean;
}

export interface Alerter {
  /** Never throws and never blocks the caller on the network for long. */
  raise(alert: Alert): Promise<void>;
}

export const ALERT_CODES = {
  deliveryPaused: 'delivery_paused',
  policyUnmeetable: 'field_policy_unmeetable',
  referenceMismatch: 'core_reference_mismatch',
  intakeBreaker: 'intake_breaker_tripped',
  submissionFailed: 'submission_failed',
  coreRejected: 'core_rejected_call',
  keyExpiring: 'resgrid_key_expiring',
  unknownCallState: 'unknown_call_state',
  queueBacklog: 'queue_backlog',
  automaticBlock: 'automatic_block',
} as const;

export class NoopAlerter implements Alerter {
  async raise(): Promise<void> {}
}

/** Keeps alerts in memory. For tests. */
export class RecordingAlerter implements Alerter {
  readonly alerts: Alert[] = [];
  async raise(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
  codes(): string[] {
    return this.alerts.map((a) => a.code);
  }
  clear(): void {
    this.alerts.length = 0;
  }
}
