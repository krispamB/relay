/** Core (Resgrid) client contract. integration.md is the specification. */
import type { SubmissionStatus } from '../db/types.js';

export type CoreResult<T> =
  | { kind: 'ok'; data: T; requestId?: string }
  /** 401 / 403: pause delivery (after confirmation, for reads). */
  | { kind: 'auth'; httpStatus: number }
  /** 409: the same Idempotency-Key is still being processed. */
  | { kind: 'conflict' }
  /** Other 4xx: do not retry. */
  | { kind: 'rejected'; httpStatus: number; message: string }
  /** 429, 5xx, timeout, network. */
  | { kind: 'retryable'; reason: string; retryAfterSeconds?: number };

/** The twelve fields of integration.md §4.2, minus IsPending, which the client always sets to true. */
export interface SaveCallInput {
  Priority: number;
  Type?: string;
  Name: string;
  Nature: string;
  Geolocation?: string;
  Address?: string;
  ContactName?: string;
  ContactInfo?: string;
  ExternalId?: string;
  ReferenceId?: string;
  Note?: string;
}

export interface CallStateResult {
  /** True when Core answered Status "not_found". */
  notFound: boolean;
  /** Raw Core State number, when present. */
  state?: number;
  /** Mapped relay status. Undefined means "unknown state: keep the last known status". */
  status?: Extract<SubmissionStatus, 'received' | 'dispatched' | 'closed'>;
  /** True for State 3 (Unfounded) and 7 (False alarm). */
  hoax: boolean;
}

export interface CallPriority {
  id: number;
  isDeleted: boolean;
}

/** One row of Core's GetAllUnitStatuses: a unit's latest status, destination and position. */
export interface CoreUnitStatus {
  /** Core UnitId, as a string. */
  unitId: string;
  /** Core's unit type name. */
  unitType: string | null;
  /** Core's status text, e.g. "En Route". */
  statusText: string | null;
  /** 1 station, 2 call, 3 POI. */
  destinationType: number | null;
  /** As a string. */
  destinationId: string | null;
  latitude: number | null;
  longitude: number | null;
  /** ISO 8601 of the status. */
  timestamp: string | null;
}

export interface CoreClient {
  saveCall(
    call: SaveCallInput,
    submissionId: string,
    opts?: { timeoutMs?: number },
  ): Promise<CoreResult<{ callId: string }>>;
  getCall(callId: string): Promise<CoreResult<CallStateResult>>;
  /** Ids of every pending call in the department. Empty when Core says not_found. */
  getPendingCalls(): Promise<CoreResult<{ callIds: string[] }>>;
  getCallTypes(): Promise<CoreResult<{ names: string[] }>>;
  getCallPriorities(): Promise<CoreResult<{ priorities: CallPriority[] }>>;
  /** Keys with Required: true in the new-call field policy. */
  getFieldPolicy(): Promise<CoreResult<{ requiredKeys: string[] }>>;
  /**
   * Attaches a file to a call (CallFiles/SaveCallFile). `call_closed` means Core refused because the
   * call is no longer active or pending (or is gone): do not retry.
   */
  saveCallFile(
    input: { callId: string; name: string; data: Buffer },
    opts?: { timeoutMs?: number },
  ): Promise<CoreResult<{ fileId: string }> | { kind: 'call_closed' }>;
  /** Every unit's latest status in the department. Empty when Core says not_found. */
  getAllUnitStatuses(): Promise<CoreResult<{ units: CoreUnitStatus[] }>>;
}
