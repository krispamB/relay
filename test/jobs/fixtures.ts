import { DEFAULT_API_KEY, type RunningMockCore } from '../../mock-core/server.js';
import type { Config } from '../../src/config.js';
import { createCoreClient } from '../../src/core/client.js';
import type { Db } from '../../src/db/index.js';
import type { NewSubmission } from '../../src/db/types.js';
import { attemptDelivery } from '../../src/delivery/deliver.js';
import { getSubmission } from '../delivery/fixtures.js';
import { createTestContext, type TestContext } from '../helpers/context.js';

let seq = 0;

/** Inserts a user (an account with a unique phone) and returns its id. */
export async function insertUser(
  db: Db,
  at: Date,
  opts: { id?: string; phone?: string; fullName?: string } = {},
) {
  seq += 1;
  const id = opts.id ?? `usr_J${String(seq).padStart(5, '0')}`;
  await db
    .insertInto('users')
    .values({
      id,
      full_name: opts.fullName ?? 'Ade',
      phone: opts.phone ?? `+2348075${String(seq).padStart(6, '0')}`,
      password_hash: '$argon2id$stub',
      created_at: at,
      updated_at: at,
    })
    .execute();
  return id;
}

/** A queued submission of the given user. */
export async function insertSubmissionOn(
  db: Db,
  userId: string,
  acceptedAt: Date,
  overrides: Partial<NewSubmission> = {},
): Promise<string> {
  seq += 1;
  const n = String(seq).padStart(5, '0');
  const id = overrides.id ?? `sos_J${n}`;
  await db
    .insertInto('submissions')
    .values({
      id,
      user_id: userId,
      idempotency_key: `jobs-key-${n}`,
      intake_code: 'TEST-DEPT',
      reference: `SOS-J${n}`,
      status: 'queued',
      nature_label: 'SOS – caller recording to follow',
      phone: '+2348012345678',
      phone_hash: 'phone-hash-a',
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

/** A test context whose Core client is the real HTTP client pointed at the mock. */
export function mockContext(mock: RunningMockCore, config?: Config): TestContext {
  const ctx = createTestContext(config ? { config } : {});
  ctx.core = createCoreClient(
    { apiBase: mock.url, apiKey: DEFAULT_API_KEY },
    { log: ctx.log, metrics: ctx.metrics, clock: ctx.clock },
  );
  return ctx;
}

/** Inserts a submission (of a new user unless one is given) and delivers it to the mock. */
export async function deliverToMock(
  ctx: TestContext,
  opts: { userId?: string; overrides?: Partial<NewSubmission> } = {},
): Promise<{ id: string; callId: string; userId: string; reference: string }> {
  const now = ctx.clock.now();
  const userId = opts.userId ?? (await insertUser(ctx.db, now));
  const id = await insertSubmissionOn(ctx.db, userId, now, opts.overrides);
  const outcome = await attemptDelivery(ctx, id);
  if (outcome !== 'received') throw new Error(`delivery to the mock failed: ${outcome}`);
  const row = await getSubmission(ctx.db, id);
  return { id, callId: row.core_call_id!, userId, reference: row.reference };
}

export async function strikesFor(db: Db, submissionId?: string) {
  let q = db.selectFrom('strikes').selectAll().orderBy('id');
  if (submissionId) q = q.where('submission_id', '=', submissionId);
  return q.execute();
}
