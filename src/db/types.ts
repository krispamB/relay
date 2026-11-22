import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** timestamptz: read as Date, written as Date. */
type Timestamp = ColumnType<Date, Date, Date>;
/** bigint columns come back from pg as strings. */
type BigIntCol = ColumnType<string, number | string | undefined, number | string>;

export type Platform = 'android' | 'ios';
export type SubmissionStatus = 'queued' | 'received' | 'dispatched' | 'closed' | 'failed';
export type LocationSource = 'gps' | 'network' | 'last_known';
export type SubjectType = 'user' | 'phone';
export type RecordingStatus = 'pending' | 'attached' | 'dropped';
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
  /** The signed-in user who sent the SOS. Their name and phone are the call's contact details. */
  user_id: string;
  idempotency_key: string;
  intake_code: string;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  reference: string;
  status: SubmissionStatus;
  /** The relay's fixed nature text (SOS_NATURE_TEXT) when the SOS was accepted. */
  nature_label: string;
  /** The account's phone in E.164 when the SOS was accepted: the callback number. */
  phone: string;
  phone_hash: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  location_captured_at: NullableTimestamp;
  location_source: LocationSource | null;
  address: string | null;
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
  /** Bumped with every change the live snapshot shows; see src/live/version.ts. */
  live_version: BigIntCol;
  /** The caller is watching the SOS until then (plan D13). */
  live_watch_until: NullableTimestamp;
  /** The caller's latest position from the live socket. Never sent to Core. */
  live_lat: ColumnType<number | null, number | null | undefined, number | null>;
  live_lon: ColumnType<number | null, number | null | undefined, number | null>;
  live_at: NullableTimestamp;
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
  /** When the unit poll step may next call GetAllUnitStatuses. */
  units_next_poll_at: NullableTimestamp;
}

export interface AlertLogTable {
  code: string;
  last_sent_at: Timestamp;
}

export interface UsersTable {
  id: string;
  full_name: string;
  phone: string;
  password_hash: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TokenFamiliesTable {
  id: string;
  user_id: string;
  install_id: string;
  platform: Platform;
  app_version: string;
  created_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface RefreshTokensTable {
  id: string;
  family_id: string;
  user_id: string;
  parent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** SHA-256 of the token; the token itself is never stored. */
  token_hash: string;
  issued_at: Timestamp;
  expires_at: Timestamp;
  rotated_at: NullableTimestamp;
  access_iat: Timestamp;
  access_exp: Timestamp;
}

export interface SignupIdempotencyTable {
  key: string;
  body_hmac: string;
  user_id: string;
  created_at: Timestamp;
}

export interface SignupPhoneAttemptsTable {
  id: Generated<string>;
  phone_hash: string;
  created_at: Timestamp;
}

/** Per-phone sign-in attempts for the 10-per-hour limit. phone_hash is a keyed HMAC, never the number. */
export interface SigninAttemptsTable {
  id: Generated<string>;
  phone_hash: string;
  created_at: Timestamp;
}

/** A voice recording that follows an SOS (docs/live-sos-plan.md §4). */
export interface RecordingsTable {
  /** 'rec_' + ULID. */
  id: string;
  submission_id: string;
  /** 1-based, per submission. */
  seq: number;
  idempotency_key: string;
  /** SHA-256 hex of the bytes. */
  body_hash: string;
  /** NULL once attached or dropped. */
  bytes: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  size: number;
  duration_ms: number;
  status: RecordingStatus;
  core_file_id: ColumnType<string | null, string | null | undefined, string | null>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: NullableTimestamp;
  drop_reason: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  attached_at: NullableTimestamp;
}

/** A unit whose status destination is the SOS's call (docs/live-sos-plan.md §5.1). */
export interface SubmissionUnitsTable {
  submission_id: string;
  /** HMAC of Core's unit id: a stable marker key that does not reveal the id. */
  unit_key: string;
  unit_type: string | null;
  status_text: string | null;
  lat: number | null;
  lon: number | null;
  status_at: NullableTimestamp;
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
  users: UsersTable;
  token_families: TokenFamiliesTable;
  refresh_tokens: RefreshTokensTable;
  signup_idempotency: SignupIdempotencyTable;
  signup_phone_attempts: SignupPhoneAttemptsTable;
  signin_attempts: SigninAttemptsTable;
  recordings: RecordingsTable;
  submission_units: SubmissionUnitsTable;
}

export type Device = Selectable<DevicesTable>;
export type Submission = Selectable<SubmissionsTable>;
export type NewSubmission = Insertable<SubmissionsTable>;
export type SubmissionUpdate = Updateable<SubmissionsTable>;
export type RelayStateRow = Selectable<RelayStateTable>;
export type Block = Selectable<BlocksTable>;
export type User = Selectable<UsersTable>;
export type Recording = Selectable<RecordingsTable>;
export type NewRecording = Insertable<RecordingsTable>;
export type SubmissionUnit = Selectable<SubmissionUnitsTable>;
