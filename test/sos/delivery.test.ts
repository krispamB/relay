import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { phoneHash } from '../../src/crypto.js';
import { resetSosBudget, setSosBudget } from '../../src/sos/budget.js';
import {
  IDEMPOTENCY_CONSTRAINT,
  OPEN_SUBMISSION_CONSTRAINT,
  persistSubmission,
  REFERENCE_CONSTRAINT,
} from '../../src/sos/persist.js';
import { validateContent, validateStatic } from '../../src/sos/validate.js';
import { getSubmission, ok, scriptedCore } from '../delivery/fixtures.js';
import { closeTestDb, resetDb, TEST_INTAKE_CODE, unusedCore } from '../helpers/context.js';
import { seedDevice } from '../helpers/seed.js';
import {
  ADDRESS,
  capturingLogger,
  DETAILS,
  device,
  type Harness,
  harness,
  LAT,
  LON,
  NAME,
  PHONE,
  postSos,
  slowCore,
  sosBody,
  submissionCount,
} from './helpers.js';

let h: Harness | undefined;
beforeEach(() => resetDb());
afterEach(async () => {
  resetSosBudget();
  await h?.app.close();
  h = undefined;
});
afterAll(() => closeTestDb());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('concurrency (PRD §8.3, AC3, AC7)', () => {
  it('concurrent identical requests make one submission and one Core call, and all get the receipt', async () => {
    const core = scriptedCore(async () => {
      await sleep(50);
      return ok();
    });
    h = await harness({ core });
    const d = await device(h);
    const key = randomUUID();
    const payload = JSON.stringify(sosBody(h.ctx));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => postSos(h!.app, { token: d.token, key, payload })),
    );
    for (const r of results) expect([201, 202]).toContain(r.status);
    expect(new Set(results.map((r) => r.body.receiptId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.statusToken)).size).toBe(1);
    expect(await submissionCount(h)).toBe(1);
    expect(core.calls).toHaveLength(1);
  });

  it('concurrent different SOS from one device: one is accepted, the rest get 409 with its receipt', async () => {
    const core = scriptedCore(ok());
    h = await harness({ core });
    const d = await device(h);
    const results = await Promise.all(Array.from({ length: 5 }, () => d.send()));
    const accepted = results.filter((r) => r.status === 201);
    expect(accepted).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(4);
    for (const c of conflicts) expect(c.body.receiptId).toBe(accepted[0]!.body.receiptId);
    expect(core.calls).toHaveLength(1);
  });

  it('the constraint names the race handling relies on exist', async () => {
    h = await harness();
    const rows = await sql<{
      indexname: string;
    }>`select indexname from pg_indexes where tablename = 'submissions'`.execute(h.ctx.db);
    const names = rows.rows.map((r) => r.indexname);
    for (const n of [IDEMPOTENCY_CONSTRAINT, OPEN_SUBMISSION_CONSTRAINT, REFERENCE_CONSTRAINT]) {
      expect(names).toContain(n);
    }
  });

  /**
   * A request that takes a different lock (here: none) inserts a conflicting row and commits while
   * persistSubmission is blocked on the unique index. The violation must become a replay or a 409.
   */
  it.each([
    ['same key → replay', true, 'replay'],
    ['different key, open → 409', false, 'open'],
  ])('a lost insert race: %s', async (_n, sameKey, expected) => {
    h = await harness();
    const ctx = h.ctx;
    const { device: dev } = await seedDevice(ctx);
    const intake = ctx.intakes.get(TEST_INTAKE_CODE)!;
    const key = randomUUID();
    const content = validateContent(validateStatic(sosBody(ctx) as never), intake, ctx.clock.now(), {
      requiredLocation: false,
    });
    const now = ctx.clock.now();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => {
      inserted = r;
    });
    const winner = ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('submissions')
        .values({
          id: 'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD',
          device_id: dev.id,
          idempotency_key: sameKey ? key : randomUUID(),
          intake_code: TEST_INTAKE_CODE,
          reference: 'SOS-WWWW',
          status: 'queued',
          nature_id: 'fire',
          nature_label: 'Fire',
          phone: PHONE,
          phone_hash: 'x',
          ip: '1',
          accepted_at: now,
          updated_at: now,
        })
        .execute();
      inserted();
      await gate;
    });
    await didInsert;
    const loser = persistSubmission(ctx, {
      device: dev,
      idempotencyKey: key,
      intake,
      content,
      phoneHash: phoneHash(ctx.config.phoneHashSecret, PHONE),
      ip: '203.0.113.7',
    });
    // Let the loser reach the insert and block on the index, then commit the winner.
    await sleep(300);
    release();
    await winner;
    const outcome = await loser;
    expect(outcome.kind).toBe(expected);
    expect(outcome.kind === 'replay' || outcome.kind === 'open' ? outcome.row.id : '').toBe(
      'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD',
    );
    expect(await submissionCount(h)).toBe(1);
  });
});

describe('time budget (PRD §8.1, AC2)', () => {
  it('gives Core at most 6 s of a 7.5 s budget by default', async () => {
    const core = slowCore(0);
    h = await harness({ core });
    expect((await (await device(h)).send()).status).toBe(201);
    const t = core.calls[0]!.timeoutMs!;
    expect(t).toBeLessThanOrEqual(6000);
    expect(t).toBeGreaterThan(5000);
  });

  it('a slow Core yields 202 queued well within the budget', async () => {
    // Scaled down 20x so the test waits milliseconds: 7.5 s → 375 ms, 6 s → 300 ms.
    setSosBudget({ totalMs: 375, maxInlineMs: 300, reserveMs: 15, minInlineMs: 25 });
    const core = slowCore(5000);
    h = await harness({ core });
    const d = await device(h);
    const started = performance.now();
    const res = await d.send();
    const elapsed = performance.now() - started;
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(elapsed).toBeLessThan(375 + 200);
    expect(core.calls[0]!.timeoutMs).toBeLessThanOrEqual(300);
    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row.next_attempt_at!.getTime() - h.ctx.clock.now().getTime()).toBe(5000);
  });

  it('with almost nothing left, skips the inline attempt, answers 202 and leaves the row due now', async () => {
    setSosBudget({ totalMs: 0 });
    h = await harness({ core: unusedCore() });
    const res = await (await device(h)).send();
    expect(res.status).toBe(202);
    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    expect(row.next_attempt_at).toEqual(h.ctx.clock.now());
  });
});

describe('logs (PRD §10.4, AC15)', () => {
  it('no log line carries the phone, name, free text, address or coordinates', async () => {
    const { log, lines } = capturingLogger();
    h = await harness({
      log,
      core: scriptedCore(ok(), { kind: 'rejected', httpStatus: 400, message: `bad ${PHONE}` }),
    });
    const body = sosBody(h.ctx, { address: ADDRESS });
    const d = await device(h);
    const key = randomUUID();
    const first = await postSos(h.app, { token: d.token, key, body });
    expect(first.status).toBe(201);
    await postSos(h.app, { token: d.token, key, body }); // replay
    await postSos(h.app, { token: d.token, body }); // 409
    await postSos(h.app, { token: d.token, body: { ...body, extra: DETAILS } }); // 400
    await postSos(h.app, { token: d.token, body: { ...body, phone: '+2348012345' } }); // 400
    const d2 = await device(h);
    expect((await d2.send({ address: ADDRESS })).body.status).toBe('failed'); // Core rejected, alert raised

    const out = lines.join('\n');
    expect(out).toContain(first.body.receiptId); // the capture works
    for (const secret of [
      PHONE,
      PHONE.slice(1),
      '8012345678',
      NAME,
      'Okonkwo',
      DETAILS,
      'generator shed',
      ADDRESS,
      'Marina Road',
      String(LAT),
      String(LON),
      first.body.statusToken,
      d.token,
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});
