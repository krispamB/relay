import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';

/** Submission id. Also the receiptId, Core's Idempotency-Key and ExternalId. */
export function newReceiptId(nowMs: number): string {
  return `sos_${ulid(nowMs)}`;
}

/** Recording id (docs/live-sos-plan.md §4.1). */
export function newRecordingId(nowMs: number): string {
  return `rec_${ulid(nowMs)}`;
}

export function newBlockId(nowMs: number): string {
  return `blk_${ulid(nowMs)}`;
}

/** No look-alikes: 0, O, 1, I, L are left out. */
export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newReference(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `SOS-${code}`;
}

export const RECEIPT_ID_PATTERN = '^sos_[0-9A-HJKMNP-TV-Z]{26}$';
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
