/** The four-field receipt of `POST /v1/sos`, used by success, replay and 409 responses. */
import type { Submission, SubmissionStatus } from '../db/types.js';
import { ApiError } from '../errors.js';
import type { SosReceipt } from './schemas.js';

/** RFC 3339 in UTC, to the second, as in the PRD's examples. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function receiptFor(
  row: Pick<Submission, 'id' | 'reference' | 'status' | 'accepted_at'>,
  status: SubmissionStatus = row.status,
): SosReceipt {
  return {
    receiptId: row.id,
    reference: row.reference,
    status,
    submittedAt: isoSeconds(row.accepted_at),
  };
}

/** 202 while queued, 201 for every other state (PRD §7.4, replay row). */
export function httpStatusFor(status: SubmissionStatus): 201 | 202 {
  return status === 'queued' ? 202 : 201;
}

/** PRD §7.4: the 409 carries the error object plus the open submission's receipt. */
export function openSubmissionError(row: Submission): ApiError {
  return new ApiError(409, 'sos_already_open', 'An SOS from this account is already open.', undefined, {
    ...receiptFor(row),
  });
}
