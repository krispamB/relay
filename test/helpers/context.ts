import { sql } from 'kysely';
import { inject } from 'vitest';
import { RecordingAlerter } from '../../src/alerts.js';
import { FakeClock } from '../../src/clock.js';
import { type Config, DEFAULT_LIMITS, DEFAULT_SOS_NATURE_TEXT } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import type { CoreClient } from '../../src/core/types.js';
import { createDb, type Db } from '../../src/db/index.js';
import { type Intakes, parseIntakes } from '../../src/intakes.js';
import { silentLogger } from '../../src/logger.js';
import { NoopMetrics } from '../../src/metrics.js';

export const TEST_INTAKE_CODE = 'TEST-DEPT';
export const DEMO_INTAKE_CODE = 'DEMO-DEPT';

export function testIntakes(): Intakes {
  return parseIntakes([
    {
      code: TEST_INTAKE_CODE,
      displayName: 'Test Fire Service',
      emergencyPhone: '112',
      natures: [
        { id: 'medical', label: 'Medical emergency' },
        { id: 'fire', label: 'Fire' },
      ],
    },
    {
      code: DEMO_INTAKE_CODE,
      displayName: 'Demo Department',
      emergencyPhone: '000-DEMO',
      natures: [{ id: 'medical', label: 'Medical emergency' }],
      demo: true,
    },
  ]);
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    databaseUrl: inject('databaseUrl'),
    runJobs: false,
    logLevel: 'silent',
    clientIpHeader: 'x-real-ip',
    resgrid: {
      apiBase: 'http://127.0.0.1:1',
      apiKey: `rgk_testtest_${'s'.repeat(43)}`,
      apiKeyExpiresOn: '2028-01-01',
      callTypeName: 'Public SOS',
      priorityId: 3,
    },
    intakesFile: '(test)',
    intakesJson: undefined,
    phoneHashSecret: 'phone-hash-secret-for-tests-01234567890',
    adminToken: 'admin-token-for-tests-0123456789abcdef',
    auth: { tokenSecret: 'auth-token-secret-for-tests-0123456789ab' },
    sosNatureText: DEFAULT_SOS_NATURE_TEXT,
    alertWebhookUrl: undefined,
    demoDispatchAfterS: 30,
    demoCloseAfterS: 90,
    limits: { ...DEFAULT_LIMITS },
    ...overrides,
  };
}

/** A Core client that fails the test if anything calls it. Override the methods a test needs. */
export function unusedCore(): CoreClient {
  const fail = (name: string) => async (): Promise<never> => {
    throw new Error(`Core client method ${name} was called unexpectedly`);
  };
  return {
    saveCall: fail('saveCall'),
    getCall: fail('getCall'),
    getPendingCalls: fail('getPendingCalls'),
    getCallTypes: fail('getCallTypes'),
    getCallPriorities: fail('getCallPriorities'),
    getFieldPolicy: fail('getFieldPolicy'),
  };
}

export interface TestContext extends AppContext {
  clock: FakeClock;
  alerts: RecordingAlerter;
}

let sharedDb: Db | undefined;

/** One pool per test file. */
export function testDb(): Db {
  sharedDb ??= createDb(inject('databaseUrl'), 5);
  return sharedDb;
}

export async function closeTestDb(): Promise<void> {
  await sharedDb?.destroy();
  sharedDb = undefined;
}

/** Empties every table and restores the single relay_state row. Call in beforeEach. */
export async function resetDb(db: Db = testDb()): Promise<void> {
  await sql`TRUNCATE submission_units, recordings, signin_attempts, signup_phone_attempts, signup_idempotency, refresh_tokens, token_families, users, submission_events, submissions, strikes, blocks, alert_log, relay_state RESTART IDENTITY CASCADE`.execute(
    db,
  );
  await sql`INSERT INTO relay_state (id) VALUES (1)`.execute(db);
}

/** Marks the startup check as passed "now", so the real intake is available (PRD §6.4). */
export async function markHealthy(ctx: Pick<AppContext, 'db' | 'clock'>): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db
    .updateTable('relay_state')
    .set({ check_status: 'ok', check_at: now, check_ok_at: now })
    .where('id', '=', 1)
    .execute();
}

export function createTestContext(overrides: Partial<AppContext> & { config?: Config } = {}): TestContext {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock();
  const alerts = (overrides.alerts as RecordingAlerter | undefined) ?? new RecordingAlerter();
  return {
    config: testConfig(),
    db: testDb(),
    log: silentLogger(),
    intakes: testIntakes(),
    core: unusedCore(),
    metrics: new NoopMetrics(),
    ...overrides,
    clock,
    alerts,
  };
}
