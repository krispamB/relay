import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_API_KEY, type RunningMockCore, startMockCore } from '../../mock-core/server.js';
import { ALERT_CODES } from '../../src/alerts.js';
import { buildPublicApp } from '../../src/app.js';
import { SECOND } from '../../src/clock.js';
import { createCoreClient } from '../../src/core/client.js';
import type { CoreClient } from '../../src/core/types.js';
import { attemptDelivery } from '../../src/delivery/deliver.js';
import { newReceiptId } from '../../src/ids.js';
import { buildJobs } from '../../src/jobs/index.js';
import { createRecordingWorker, runRecordingPass } from '../../src/jobs/recordingWorker.js';
import { METRICS } from '../../src/metrics.js';
import { getState, pauseDelivery, resumeDelivery } from '../../src/state.js';
import { getSubmission } from '../delivery/fixtures.js';
import { closeTestDb, createTestContext, resetDb, type TestContext, unusedCore } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import { insertSubmissionOn, mockContext } from '../jobs/fixtures.js';
import { capturingLogger, RecordingMetrics } from '../sos/helpers.js';
import { m4a, upload } from './fixtures.js';

let mock: RunningMockCore;
beforeAll(async () => {
  mock = await startMockCore();
});
afterAll(async () => {
  await mock.close();
  await closeTestDb();
});
beforeEach(async () => {
  mock.control.reset();
  await resetDb();
});

type SaveFile = CoreClient['saveCallFile'];
type FileResult = Awaited<ReturnType<SaveFile>>;

interface FileCall {
  callId: string;
  name: string;
  data: Buffer;
}

/** A Core whose saveCallFile answers from a script (the last answer repeats) and records its calls. */
function scriptedFiles(...script: (FileResult | (() => Promise<FileResult> | FileResult))[]) {
  const calls: FileCall[] = [];
  const core: CoreClient & { calls: FileCall[] } = {
    ...unusedCore(),
    calls,
    async saveCallFile(input) {
      calls.push({ callId: input.callId, name: input.name, data: input.data });
      const next = script.length > 1 ? script.shift()! : script[0];
      if (next === undefined) throw new Error('no scripted answer');
      return typeof next === 'function' ? next() : next;
    },
  };
  return core;
}
const fileOk = (fileId = '501'): FileResult => ({ kind: 'ok', data: { fileId } });
const fileRetryable = (retryAfterSeconds?: number): FileResult => ({
  kind: 'retryable',
  reason: 'HTTP 503',
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

function metricsContext(overrides: Partial<TestContext> = {}) {
  const metrics = new RecordingMetrics();
  return { ctx: createTestContext({ metrics, ...overrides }), metrics };
}

interface Seeded {
  userId: string;
  token: () => string;
  id: string;
  reference: string;
}

async function seedSos(
  ctx: TestContext,
  opts: {
    status?: 'queued' | 'received' | 'dispatched' | 'closed' | 'failed';
    demo?: boolean;
    callId?: string | null;
  } = {},
): Promise<Seeded> {
  const seeded = await seedUser(ctx);
  const id = await insertSubmissionOn(ctx.db, seeded.user.id, ctx.clock.now(), {
    id: newReceiptId(ctx.clock.now().getTime()),
    status: opts.status ?? 'received',
    is_demo: opts.demo ?? false,
    core_call_id: opts.callId === undefined ? '48213' : opts.callId,
  });
  const row = await getSubmission(ctx.db, id);
  return { userId: seeded.user.id, token: seeded.token, id, reference: row.reference };
}

/** A recording row as the upload leaves it, written directly. */
async function seedRecording(
  ctx: TestContext,
  submissionId: string,
  opts: { bytes?: Buffer | null; seq?: number; nextAttemptAt?: Date | null; key?: string } = {},
): Promise<string> {
  const bytes = opts.bytes === undefined ? m4a('worker', 120) : opts.bytes;
  const id = `rec_TEST${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
  await ctx.db
    .insertInto('recordings')
    .values({
      id,
      submission_id: submissionId,
      seq: opts.seq ?? 1,
      idempotency_key: opts.key ?? randomUUID(),
      body_hash: 'hash',
      bytes,
      size: bytes?.length ?? 0,
      duration_ms: 5000,
      status: 'pending',
      next_attempt_at: opts.nextAttemptAt === undefined ? ctx.clock.now() : opts.nextAttemptAt,
      created_at: ctx.clock.now(),
    })
    .execute();
  return id;
}

const recording = (ctx: TestContext, id: string) =>
  ctx.db.selectFrom('recordings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const liveVersion = async (ctx: TestContext, id: string) =>
  Number(
    (
      await ctx.db
        .selectFrom('submissions')
        .select('live_version')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).live_version,
  );

describe('recording worker', () => {
  it('is a 1 s job named recordings, and one of the relay jobs', () => {
    const ctx = createTestContext();
    const job = createRecordingWorker(ctx);
    expect(job.name).toBe('recordings');
    expect(job.intervalMs).toBe(1000);
    expect(buildJobs(ctx).map((j) => j.name)).toContain('recordings');
  });

  describe('against the mock Core', () => {
    it('a recording uploaded while the SOS is still queued is attached once the call exists, and never twice for one key', async () => {
      const ctx = mockContext(mock);
      const app = await buildPublicApp(ctx);
      const user = await seedUser(ctx);
      const id = await insertSubmissionOn(ctx.db, user.user.id, ctx.clock.now(), {
        id: newReceiptId(ctx.clock.now().getTime()),
      });
      const key = randomUUID();
      const bytes = m4a('voice', 5000);

      const up = await upload(app, id, { token: user.token(), key, body: bytes });
      expect(up.status).toBe(202);

      // The SOS is still queued: nothing to attach to yet. The recording waits, without counting an attempt.
      await runRecordingPass(ctx);
      let rec = await recording(ctx, up.body.recordingId);
      expect(rec).toMatchObject({ status: 'pending', attempts: 0 });
      expect(rec.next_attempt_at!.getTime()).toBe(ctx.clock.now().getTime() + 5 * SECOND);
      expect(mock.control.requests({ endpoint: 'CallFiles/SaveCallFile' })).toHaveLength(0);

      // Not due before 5 s have passed, and still nothing sent.
      ctx.clock.advanceSeconds(4);
      await runRecordingPass(ctx);
      expect(mock.control.requests({ endpoint: 'CallFiles/SaveCallFile' })).toHaveLength(0);

      // The call is created in Core.
      expect(await attemptDelivery(ctx, id)).toBe('received');
      const callId = (await getSubmission(ctx.db, id)).core_call_id!;

      ctx.clock.advanceSeconds(1);
      await runRecordingPass(ctx);
      rec = await recording(ctx, up.body.recordingId);
      expect(rec).toMatchObject({ status: 'attached', bytes: null, drop_reason: null, attempts: 1 });
      expect(rec.core_file_id).toMatch(/^\d+$/);
      expect(rec.attached_at).toEqual(ctx.clock.now());
      expect(rec.next_attempt_at).toBeNull();

      expect(mock.control.requests({ endpoint: 'CallFiles/SaveCallFile' })).toHaveLength(1);
      const files = mock.control.files({ callId });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        Id: rec.core_file_id,
        Name: `${(await getSubmission(ctx.db, id)).reference}-1.m4a`,
        Size: bytes.length,
      });

      // The app retries the upload with the same key, and the worker runs again and again: still one file.
      const replay = await upload(app, id, { token: user.token(), key, body: bytes });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...up.body, status: 'attached' });
      ctx.clock.advanceSeconds(120);
      await runRecordingPass(ctx);
      await runRecordingPass(ctx);
      expect(mock.control.files({ callId })).toHaveLength(1);
      await app.close();
    });

    it('a recording for a call a dispatcher closed first ends dropped, with its bytes cleared', async () => {
      const ctx = mockContext(mock);
      const app = await buildPublicApp(ctx);
      const user = await seedUser(ctx);
      const id = await insertSubmissionOn(ctx.db, user.user.id, ctx.clock.now(), {
        id: newReceiptId(ctx.clock.now().getTime()),
      });
      const up = await upload(app, id, { token: user.token() });
      expect(await attemptDelivery(ctx, id)).toBe('received');
      const callId = (await getSubmission(ctx.db, id)).core_call_id!;
      // The dispatcher closes the call before the poller has noticed: the submission is still `received`.
      mock.control.setCallState(callId, 1);
      expect((await getSubmission(ctx.db, id)).status).toBe('received');

      await runRecordingPass(ctx);

      const rec = await recording(ctx, up.body.recordingId);
      expect(rec).toMatchObject({
        status: 'dropped',
        drop_reason: 'call_closed',
        bytes: null,
        core_file_id: null,
      });
      expect(mock.control.files()).toEqual([]);
      await app.close();
    });
  });

  describe('logs', () => {
    it('never print the audio or its base64, on success, retry, drop or a throwing client', async () => {
      const { log, lines } = capturingLogger();
      const ctx = mockContext(mock);
      ctx.log = log;
      ctx.core = createCoreClient(
        { apiBase: mock.url, apiKey: DEFAULT_API_KEY },
        { log, metrics: ctx.metrics, clock: ctx.clock },
      );
      const marker = 'WORKER-LOG-MARKER-0123456789';
      const bytes = m4a(marker, 600);
      const mk = async () => {
        const s = await seedSos(ctx, { status: 'queued', callId: null });
        await seedRecording(ctx, s.id, { bytes });
        return s.id;
      };
      const ids = [await mk(), await mk(), await mk()];
      for (const id of ids) {
        await attemptDelivery(ctx, id);
      }
      // 1st: a 503 then success. 2nd: Core refuses with 422. 3rd: the call is closed.
      mock.control.injectFault('CallFiles/SaveCallFile', { status: 503 }, 1);
      await runRecordingPass(ctx);
      mock.control.injectFault('CallFiles/SaveCallFile', { status: 422, body: { detail: 'bad' } }, 1);
      ctx.clock.advanceSeconds(10);
      await runRecordingPass(ctx);
      const third = (await getSubmission(ctx.db, ids[2]!)).core_call_id!;
      mock.control.setCallState(third, 1);
      ctx.clock.advanceSeconds(10);
      await runRecordingPass(ctx);

      const all = lines.join('\n');
      // The three outcomes all ran, and logged by id only.
      expect(all).toContain('recording attach will be retried');
      expect(all).toContain('recording attached');
      expect(all).toContain('recording dropped');
      expect(all).not.toContain(marker);
      expect(all).not.toContain(bytes.toString('base64').slice(16, 80));
      expect(all).not.toContain(bytes.toString('hex').slice(0, 40));
    });
  });

  describe('what the worker decides', () => {
    it('sends the file named {reference}-{seq}.m4a with the stored bytes to the submission’s call', async () => {
      const core = scriptedFiles(fileOk('77'));
      const { ctx, metrics } = metricsContext({ core });
      const s = await seedSos(ctx, { callId: '9001' });
      const bytes = m4a('exact', 333);
      const id = await seedRecording(ctx, s.id, { bytes, seq: 2 });

      await runRecordingPass(ctx);

      expect(core.calls).toHaveLength(1);
      expect(core.calls[0]).toMatchObject({ callId: '9001', name: `${s.reference}-2.m4a` });
      expect(Buffer.compare(core.calls[0]!.data, bytes)).toBe(0);
      expect(await recording(ctx, id)).toMatchObject({ status: 'attached', core_file_id: '77', bytes: null });
      expect(metrics.count(METRICS.recordingsAttached)).toBe(1);
    });

    it('marks a demo recording attached with no Core call, and clears the bytes', async () => {
      const { ctx, metrics } = metricsContext(); // unusedCore: any Core call fails the test
      const s = await seedSos(ctx, { demo: true, status: 'received', callId: null });
      const id = await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      expect(await recording(ctx, id)).toMatchObject({ status: 'attached', core_file_id: null, bytes: null });
      expect((await recording(ctx, id)).attached_at).not.toBeNull();
      // Demo requests stay out of operational metrics (PRD §6.3).
      expect(metrics.count(METRICS.recordingsAttached)).toBe(0);
    });

    it.each([
      ['closed', 'sos_closed'],
      ['failed', 'sos_failed'],
    ] as const)('drops the recording of a %s SOS without calling Core', async (status, reason) => {
      const { ctx, metrics } = metricsContext();
      const s = await seedSos(ctx, { status });
      const id = await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      expect(await recording(ctx, id)).toMatchObject({ status: 'dropped', drop_reason: reason, bytes: null });
      expect(metrics.count(METRICS.recordingsDropped, { reason })).toBe(1);
    });

    it('drops when Core says the call is closed', async () => {
      const core = scriptedFiles({ kind: 'call_closed' });
      const { ctx, metrics } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      expect(await recording(ctx, id)).toMatchObject({
        status: 'dropped',
        drop_reason: 'call_closed',
        bytes: null,
      });
      expect(metrics.count(METRICS.recordingsDropped, { reason: 'call_closed' })).toBe(1);
      expect(core.calls).toHaveLength(1);
    });

    it('drops a pending row whose bytes are gone instead of sending nothing', async () => {
      const { ctx } = metricsContext();
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id, { bytes: null });
      await runRecordingPass(ctx);
      expect(await recording(ctx, id)).toMatchObject({ status: 'dropped', drop_reason: 'no_bytes' });
    });

    it('leaves a row that is not due yet alone', async () => {
      const core = scriptedFiles(fileOk());
      const { ctx } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id, {
        nextAttemptAt: new Date(ctx.clock.now().getTime() + 10 * SECOND),
      });
      await runRecordingPass(ctx);
      expect(core.calls).toHaveLength(0);
      ctx.clock.advanceSeconds(10);
      await runRecordingPass(ctx);
      expect(core.calls).toHaveLength(1);
      expect((await recording(ctx, id)).status).toBe('attached');
    });

    it('retries with the delivery backoff (5, 15, 30, 60 s) and drops after the 5th failed attempt', async () => {
      const core = scriptedFiles(fileRetryable());
      const { ctx, metrics } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);

      const attemptTimes: number[] = [];
      for (let t = 0; t <= 400; t++) {
        const before = core.calls.length;
        await runRecordingPass(ctx);
        if (core.calls.length > before) attemptTimes.push(t);
        ctx.clock.advanceSeconds(1);
      }

      expect(attemptTimes.map((t, i) => (i === 0 ? 0 : t - attemptTimes[i - 1]!)).slice(1)).toEqual([
        5, 15, 30, 60,
      ]);
      expect(core.calls).toHaveLength(5);
      expect(ctx.alerts.codes()).toEqual([ALERT_CODES.recordingDropped]);
      expect(await recording(ctx, id)).toMatchObject({
        status: 'dropped',
        drop_reason: 'attempts_exhausted',
        bytes: null,
        attempts: 5,
        next_attempt_at: null,
      });
      expect(metrics.count(METRICS.recordingsDropped, { reason: 'attempts_exhausted' })).toBe(1);
    });

    it('attaches after a retryable failure, and honours Retry-After', async () => {
      const core = scriptedFiles(fileRetryable(20), fileOk('12'));
      const { ctx } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      ctx.clock.advanceSeconds(19);
      await runRecordingPass(ctx);
      expect(core.calls).toHaveLength(1);
      ctx.clock.advanceSeconds(1);
      await runRecordingPass(ctx);
      expect(core.calls).toHaveLength(2);
      expect(await recording(ctx, id)).toMatchObject({ status: 'attached', core_file_id: '12', attempts: 2 });
    });

    it('treats a Core client that throws, and a 409, as retryable', async () => {
      let n = 0;
      const core = scriptedFiles(
        () => {
          n++;
          throw new Error('boom');
        },
        { kind: 'conflict' },
        fileOk(),
      );
      const { ctx } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);
      for (let t = 0; t < 60; t++) {
        await runRecordingPass(ctx);
        ctx.clock.advanceSeconds(1);
      }
      expect(n).toBe(1);
      expect(core.calls).toHaveLength(3);
      expect(await recording(ctx, id)).toMatchObject({ status: 'attached', attempts: 3 });
    });

    it.each([401, 403])(
      'pauses delivery and alerts on Core %i, keeps the recording pending and stops calling',
      async (httpStatus) => {
        const core = scriptedFiles({ kind: 'auth', httpStatus }, fileOk());
        const { ctx } = metricsContext({ core });
        const s = await seedSos(ctx);
        const id = await seedRecording(ctx, s.id);

        await runRecordingPass(ctx);

        expect((await getState(ctx.db)).paused).toBe(true);
        expect(ctx.alerts.codes()).toContain(ALERT_CODES.deliveryPaused);
        expect(ctx.alerts.alerts.find((a) => a.code === ALERT_CODES.deliveryPaused)).toMatchObject({
          severity: 'critical',
        });
        // Core's refusal says nothing about this recording: it is not counted against it.
        expect(await recording(ctx, id)).toMatchObject({ status: 'pending', attempts: 0 });
        expect(core.calls).toHaveLength(1);

        // Paused: no Core calls of any kind (PRD §8.4).
        ctx.clock.advanceSeconds(30);
        await runRecordingPass(ctx);
        expect(core.calls).toHaveLength(1);

        await resumeDelivery(ctx.db);
        await runRecordingPass(ctx);
        expect(core.calls).toHaveLength(2);
        expect((await recording(ctx, id)).status).toBe('attached');
      },
    );

    it('still drops a closed SOS’s recording and attaches a demo one while delivery is paused', async () => {
      const { ctx } = metricsContext(); // no Core call may happen
      await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
      const closed = await seedSos(ctx, { status: 'closed' });
      const demo = await seedSos(ctx, { demo: true, callId: null });
      const a = await seedRecording(ctx, closed.id);
      const b = await seedRecording(ctx, demo.id);
      await runRecordingPass(ctx);
      expect((await recording(ctx, a)).status).toBe('dropped');
      expect((await recording(ctx, b)).status).toBe('attached');
    });

    it.each([400, 413, 422])('drops on a Core refusal (HTTP %i) and alerts', async (httpStatus) => {
      const core = scriptedFiles({ kind: 'rejected', httpStatus, message: 'nope' });
      const { ctx, metrics } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      expect(await recording(ctx, id)).toMatchObject({
        status: 'dropped',
        drop_reason: 'core_rejected',
        bytes: null,
      });
      expect(metrics.count(METRICS.recordingsDropped, { reason: 'core_rejected' })).toBe(1);
      const alert = ctx.alerts.alerts.find((a) => a.code === ALERT_CODES.recordingRejected);
      expect(alert).toMatchObject({ severity: 'high', reference: s.reference, receiptId: s.id });
      expect(alert?.message).toContain(String(httpStatus));
      // The relay is not paused by a refusal of one file.
      expect((await getState(ctx.db)).paused).toBe(false);
    });

    it('bumps the live version once per status change, and not when it only reschedules', async () => {
      const core = scriptedFiles(fileRetryable(), fileOk());
      const { ctx } = metricsContext({ core });
      const s = await seedSos(ctx, { callId: null });
      await seedRecording(ctx, s.id);
      expect(await liveVersion(ctx, s.id)).toBe(0);

      await runRecordingPass(ctx); // no call yet: reschedules
      expect(await liveVersion(ctx, s.id)).toBe(0);

      await ctx.db.updateTable('submissions').set({ core_call_id: '1' }).where('id', '=', s.id).execute();
      ctx.clock.advanceSeconds(5);
      await runRecordingPass(ctx); // retryable: reschedules
      expect(await liveVersion(ctx, s.id)).toBe(0);

      ctx.clock.advanceSeconds(5);
      await runRecordingPass(ctx); // attached
      expect(await liveVersion(ctx, s.id)).toBe(1);
    });

    it('bumps the live version when it drops', async () => {
      const { ctx } = metricsContext();
      const s = await seedSos(ctx, { status: 'closed' });
      await seedRecording(ctx, s.id);
      await runRecordingPass(ctx);
      expect(await liveVersion(ctx, s.id)).toBe(1);
    });

    it('sends one recording once when two worker passes run at the same time', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const core = scriptedFiles(async () => {
        await gate;
        return fileOk();
      });
      const { ctx } = metricsContext({ core });
      const s = await seedSos(ctx);
      const id = await seedRecording(ctx, s.id);

      const first = runRecordingPass(ctx);
      await new Promise((r) => setTimeout(r, 100));
      const second = runRecordingPass(ctx);
      await second; // the row is held by the first pass: skipped, not waited on
      expect(core.calls).toHaveLength(1);
      release();
      await first;
      expect(core.calls).toHaveLength(1);
      expect((await recording(ctx, id)).status).toBe('attached');
    });

    it('works through the oldest recordings first and goes on past one that waits', async () => {
      const core = scriptedFiles(fileOk());
      const { ctx } = metricsContext({ core });
      const waiting = await seedSos(ctx, { callId: null });
      const ready = await seedSos(ctx);
      const a = await seedRecording(ctx, waiting.id);
      const b = await seedRecording(ctx, ready.id);
      await runRecordingPass(ctx);
      expect((await recording(ctx, a)).status).toBe('pending');
      expect((await recording(ctx, b)).status).toBe('attached');
    });
  });
});
