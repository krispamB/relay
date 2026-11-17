import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** timestamptz: read as Date, written as Date. */
type Timestamp = ColumnType<Date, Date, Date>;
/** bigint columns come back from pg as strings. */
type BigIntCol = ColumnType<string, number | string | undefined, number | string>;

export type Platform = 'android' | 'ios';
export type SubmissionStatus = 'queued' | 'received' | 'dispatched' | 'closed' | 'failed';
export type LocationSource = 'gps' | 'network' | 'last_known';
export type SubjectType = 'device' | 'phone';
export type CheckStatus = 'unknown' | 'ok' | 'unhealthy';

export const OPEN_STATUSES: readonly SubmissionStatus[] = ['queued', 'received', 'dispatched'];

export interface DevicesTable {
  id: string;
  platform: Platform;
  token_hash: string;
  token_expires_at: Timestamp;
  attested: boolean;
  ios_key_id: string | null;
  ios_public_key: string | null;
  ios_counter: BigIntCol;
  phone_verified_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DeviceRegistrationsTable {
  id: Generated<string>;
  device_id: string;
  ip_hash: string;
  created_at: Timestamp;
}

export interface NoncesTable {
  nonce: string;
  expires_at: Timestamp;
  used_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

type NullableTimestamp = ColumnType<Date | null, Date | null | undefined, Date | null>;

export interface SubmissionsTable {
  id: string;
  device_id: string;
  idempotency_key: string;
  intake_code: string;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  reference: string;
  status: SubmissionStatus;
  nature_id: string;
  nature_label: string;
  phone: string;
  phone_hash: string;
  name: string | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  location_captured_at: NullableTimestamp;
  location_source: LocationSource | null;
  address: string | null;
  details: string | null;
  ip: string;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: NullableTimestamp;
  core_call_id: string | null;
  core_state: number | null;
  failure_reason: string | null;
  next_poll_at: NullableTimestamp;
  accepted_at: Timestamp;
  delivered_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface SubmissionEventsTable {
  id: Generated<string>;
  submission_id: string;
  from_status: SubmissionStatus | null;
  to_status: SubmissionStatus;
  cause: string;
  at: Timestamp;
}

export interface StrikesTable {
  id: Generated<string>;
  subject_type: SubjectType;
  subject: string;
  submission_id: string;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface BlocksTable {
  id: string;
  subject_type: SubjectType;
  subject: string;
  reason: string;
  source: 'automatic' | 'manual';
  created_at: Timestamp;
  expires_at: NullableTimestamp;
}

export interface RelayStateTable {
  id: ColumnType<number, never, never>;
  paused: boolean;
  paused_reason: string | null;
  paused_at: NullableTimestamp;
  check_status: CheckStatus;
  check_detail: string | null;
  check_at: NullableTimestamp;
  check_ok_at: NullableTimestamp;
  required_location: boolean;
  required_address: boolean;
  required_name: boolean;
}

export interface AlertLogTable {
  code: string;
  last_sent_at: Timestamp;
}

export interface Database {
  devices: DevicesTable;
  device_registrations: DeviceRegistrationsTable;
  nonces: NoncesTable;
  submissions: SubmissionsTable;
  submission_events: SubmissionEventsTable;
  strikes: StrikesTable;
  blocks: BlocksTable;
  relay_state: RelayStateTable;
  alert_log: AlertLogTable;
}

export type Device = Selectable<DevicesTable>;
export type Submission = Selectable<SubmissionsTable>;
export type NewSubmission = Insertable<SubmissionsTable>;
export type SubmissionUpdate = Updateable<SubmissionsTable>;
export type RelayStateRow = Selectable<RelayStateTable>;
export type Block = Selectable<BlocksTable>;
