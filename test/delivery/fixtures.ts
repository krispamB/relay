import type { CoreClient, CoreResult, SaveCallInput } from '../../src/core/types.js';
import type { Db } from '../../src/db/index.js';
import type { NewSubmission } from '../../src/db/types.js';
import { unusedCore } from '../helpers/context.js';

export type SaveResult = CoreResult<{ callId: string }>;

export interface SaveCallRecord {
  input: SaveCallInput;
  submissionId: string;
  opts?: { timeoutMs?: number };
}

/** A Core client whose saveCall answers from a script. Every other method fails the test. */
export function scriptedCore(
  ...script: (SaveResult | ((rec: SaveCallRecord) => Promise<SaveResult> | SaveResult))[]
): CoreClient & { calls: SaveCallRecord[] } {
  const calls: SaveCallRecord[] = [];
  return {
    ...unusedCore(),
    calls,
    async saveCall(input, submissionId, opts) {
      const rec = { input, submissionId, opts };
      calls.push(rec);
      const next = script.length > 1 ? script.shift()! : script[0];
      if (next === undefined) throw new Error('scriptedCore: no scripted result');
      return typeof next === 'function' ? next(rec) : next;
    },
  };
}

export const ok = (callId = '48213'): SaveResult => ({ kind: 'ok', data: { callId }, requestId: 'r' });
export const retryable = (retryAfterSeconds?: number): SaveResult =>
  retryAfterSeconds === undefined
    ? { kind: 'retryable', reason: 'HTTP 503' }
    : { kind: 'retryable', reason: 'HTTP 429', retryAfterSeconds };

let seq = 0;

/** Inserts a user and a queued submission of theirs. Each call uses a fresh user (one open SOS per user). */
export async function insertSubmission(
  db: Db,
  acceptedAt: Date,
  overrides: Partial<NewSubmission> = {},
): Promise<string> {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  const userId = `usr_${n}`;
  await db
    .insertInto('users')
    .values({
      id: userId,
      full_name: 'Ade',
      phone: `+2348076${n.padStart(6, '0')}`,
      password_hash: '$argon2id$stub',
      created_at: acceptedAt,
      updated_at: acceptedAt,
    })
    .execute();
  const id = overrides.id ?? `sos_TEST${n}`;
  await db
    .insertInto('submissions')
    .values({
      id,
      user_id: userId,
      idempotency_key: `key-${n}`,
      intake_code: 'TEST-DEPT',
      reference: `SOS-${n}`,
      status: 'queued',
      nature_label: 'SOS – caller recording to follow',
      phone: '+2348012345678',
      phone_hash: 'ph',
      lat: 6.5244,
      lon: 3.3792,
      accuracy_m: 12,
      location_captured_at: acceptedAt,
      location_source: 'gps',
      address: null,
      ip: '203.0.113.1',
      next_attempt_at: acceptedAt,
      accepted_at: acceptedAt,
      updated_at: acceptedAt,
      ...overrides,
    })
    .execute();
  return id;
}

export async function getSubmission(db: Db, id: string) {
  return db.selectFrom('submissions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function eventsFor(db: Db, id: string) {
  return db
    .selectFrom('submission_events')
    .select(['from_status', 'to_status', 'cause', 'at'])
    .where('submission_id', '=', id)
    .orderBy('id')
    .execute();
}
