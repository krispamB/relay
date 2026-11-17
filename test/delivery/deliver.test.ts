import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_CODES } from '../../src/alerts.js';
import { MINUTE } from '../../src/clock.js';
import { attemptDelivery } from '../../src/delivery/deliver.js';
import { PLACEHOLDER_ADDRESS, PLACEHOLDER_NAME } from '../../src/delivery/mapping.js';
import { getState, pauseDelivery } from '../../src/state.js';
import { closeTestDb, createTestContext, resetDb, unusedCore } from '../helpers/context.js';
import {
  eventsFor,
  getSubmission,
  insertSubmission,
  ok,
  retryable,
  type SaveResult,
  scriptedCore,
} from './fixtures.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

function setup(core = scriptedCore(ok())) {
  const ctx = createTestContext({ core });
  return { ctx, core };
}

describe('attemptDelivery outcomes (PRD §8.1)', () => {
  it('ok → received, with call id, delivered_at, next_poll_at = now + 15 s and an event', async () => {
    const { ctx, core } = setup(scriptedCore(ok('48213')));
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    ctx.clock.advanceSeconds(2);
    expect(await attemptDelivery(ctx, id)).toBe('received');

    const row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({
      status: 'received',
      core_call_id: '48213',
      attempts: 1,
      next_attempt_at: null,
    });
    expect(row.delivered_at).toEqual(ctx.clock.now());
    expect(row.updated_at).toEqual(ctx.clock.now());
    expect(row.next_poll_at!.getTime() - ctx.clock.now().getTime()).toBe(15_000);
    expect(await eventsFor(ctx.db, id)).toMatchObject([{ from_status: 'queued', to_status: 'received' }]);
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.submissionId).toBe(id);
    expect(core.calls[0]!.input).toMatchObject({ ExternalId: id, ReferenceId: row.reference, Priority: 3 });
    expect(ctx.alerts.alerts).toEqual([]);
  });

  it.each([400, 404, 415, 422])(
    '%i rejected → failed with reason and a high alert, no retry',
    async (status) => {
      const { ctx } = setup(
        scriptedCore({
          kind: 'rejected',
          httpStatus: status,
          message: 'Required call fields are missing: address',
        }),
      );
      const id = await insertSubmission(ctx.db, ctx.clock.now());
      expect(await attemptDelivery(ctx, id)).toBe('failed');
      const row = await getSubmission(ctx.db, id);
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toContain(`HTTP ${status}`);
      expect(row.failure_reason).toContain('Required call fields are missing: address');
      expect(row.next_attempt_at).toBeNull();
      expect(await eventsFor(ctx.db, id)).toMatchObject([{ from_status: 'queued', to_status: 'failed' }]);
      expect(ctx.alerts.alerts).toHaveLength(1);
      const alert = ctx.alerts.alerts[0]!;
      expect(alert).toMatchObject({
        severity: 'high',
        code: ALERT_CODES.coreRejected,
        always: true,
        reference: row.reference,
        receiptId: id,
      });
      // No personal data in an alert.
      const text = JSON.stringify(alert);
      for (const pii of ['+2348012345678', 'Ade', '6.52', 'Not breathing']) expect(text).not.toContain(pii);

      // A failed submission is never attempted again.
      expect(await attemptDelivery(ctx, id)).toBe('skipped');
    },
  );

  it('keeps Core error text that is not a field-policy list out of the alert', async () => {
    const { ctx } = setup(
      scriptedCore({ kind: 'rejected', httpStatus: 400, message: 'bad value +2348012345678' }),
    );
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await attemptDelivery(ctx, id);
    expect(JSON.stringify(ctx.alerts.alerts)).not.toContain('+2348012345678');
  });

  it.each([401, 403])(
    '%i auth → stays queued, pauses, one critical alert only from the call that flipped it',
    async (status) => {
      const { ctx } = setup(scriptedCore({ kind: 'auth', httpStatus: status }));
      const a = await insertSubmission(ctx.db, ctx.clock.now());
      expect(await attemptDelivery(ctx, a)).toBe('queued');
      expect((await getSubmission(ctx.db, a)).status).toBe('queued');
      expect(await eventsFor(ctx.db, a)).toEqual([]);
      const state = await getState(ctx.db);
      expect(state.paused).toBe(true);
      expect(state.paused_reason).toContain(String(status));
      expect(ctx.alerts.alerts).toMatchObject([{ severity: 'critical', code: ALERT_CODES.deliveryPaused }]);
    },
  );

  it('does not alert again when delivery was already paused by someone else', async () => {
    const { ctx } = setup(scriptedCore({ kind: 'auth', httpStatus: 401 }));
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    // Another attempt paused between this one's claim and its result: simulate by pausing inside saveCall.
    ctx.core = scriptedCore(async () => {
      await pauseDelivery(ctx.db, ctx.clock.now(), 'other');
      return { kind: 'auth', httpStatus: 401 };
    });
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect(ctx.alerts.alerts).toEqual([]);
  });

  it('makes no Core call while paused', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect((await getSubmission(ctx.db, id)).attempts).toBe(0);
  });

  const retryCases: [string, SaveResult][] = [
    ['409 conflict', { kind: 'conflict' }],
    ['429', { kind: 'retryable', reason: 'HTTP 429' }],
    ['5xx', { kind: 'retryable', reason: 'HTTP 503' }],
    ['timeout', { kind: 'retryable', reason: 'timeout' }],
    ['network error', { kind: 'retryable', reason: 'network: ECONNREFUSED' }],
  ];
  it.each(retryCases)('%s → stays queued, attempts bumped, next attempt in 5 s', async (_n, result) => {
    const { ctx } = setup(scriptedCore(result));
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    const row = await getSubmission(ctx.db, id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at!.getTime() - ctx.clock.now().getTime()).toBe(5_000);
    expect(row.updated_at).toEqual(ctx.clock.now());
    expect(await eventsFor(ctx.db, id)).toEqual([]);
    expect(ctx.alerts.alerts).toEqual([]);
  });

  it('Retry-After overrides the next delay', async () => {
    const { ctx } = setup(scriptedCore(retryable(90)));
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await attemptDelivery(ctx, id);
    expect((await getSubmission(ctx.db, id)).next_attempt_at!.getTime() - ctx.clock.now().getTime()).toBe(
      90_000,
    );
  });

  it('treats a throwing client as retryable', async () => {
    const { ctx } = setup(
      scriptedCore(() => {
        throw new Error('boom');
      }),
    );
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect((await getSubmission(ctx.db, id)).attempts).toBe(1);
  });

  it('a retry reuses the submission id as the idempotency key', async () => {
    const { ctx, core } = setup(scriptedCore(retryable(), { kind: 'conflict' }, ok('7')));
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect(await attemptDelivery(ctx, id)).toBe('queued');
    expect(await attemptDelivery(ctx, id)).toBe('received');
    expect(core.calls.map((c) => c.submissionId)).toEqual([id, id, id]);
    expect((await getSubmission(ctx.db, id)).attempts).toBe(3);
  });

  it('passes the inline timeout budget to the client', async () => {
    const { ctx, core } = setup();
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    await attemptDelivery(ctx, id, { timeoutMs: 4200 });
    expect(core.calls[0]!.opts).toEqual({ timeoutMs: 4200 });
  });

  it('two concurrent attempts for one submission make exactly one Core call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inCore = new Promise<void>((r) => {
      entered = r;
    });
    const { ctx, core } = setup(
      scriptedCore(async () => {
        entered();
        await gate;
        return ok('1');
      }),
    );
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    const first = attemptDelivery(ctx, id);
    await inCore;
    const second = await attemptDelivery(ctx, id);
    expect(second).toBe('skipped');
    release();
    expect(await first).toBe('received');
    expect(await attemptDelivery(ctx, id)).toBe('skipped');
    expect(core.calls).toHaveLength(1);
  });

  it('skips a submission that is not queued, or unknown', async () => {
    const { ctx } = setup(scriptedCore(ok()));
    ctx.core = unusedCore();
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { status: 'received' });
    expect(await attemptDelivery(ctx, id)).toBe('skipped');
    expect(await attemptDelivery(ctx, 'sos_nope')).toBe('skipped');
  });

  it('dueOnly skips a row whose next attempt is still in the future', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const now = ctx.clock.now();
    const id = await insertSubmission(ctx.db, now, { next_attempt_at: new Date(now.getTime() + 5000) });
    expect(await attemptDelivery(ctx, id, { dueOnly: true })).toBe('skipped');
  });

  it('fails instead of delivering once the 30-minute hard stop has passed', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertSubmission(ctx.db, ctx.clock.now());
    ctx.clock.advance(30 * MINUTE);
    expect(await attemptDelivery(ctx, id)).toBe('failed');
    expect((await getSubmission(ctx.db, id)).status).toBe('failed');
    expect(ctx.alerts.alerts).toMatchObject([{ code: ALERT_CODES.submissionFailed, always: true }]);
  });
});

describe('field-policy placeholders through delivery', () => {
  it('sends the placeholders when relay_state says the policy requires address and name', async () => {
    const { ctx, core } = setup();
    await ctx.db
      .updateTable('relay_state')
      .set({ required_address: true, required_name: true })
      .where('id', '=', 1)
      .execute();
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { name: null, address: null });
    await attemptDelivery(ctx, id);
    expect(core.calls[0]!.input).toMatchObject({
      Address: PLACEHOLDER_ADDRESS,
      ContactName: PLACEHOLDER_NAME,
    });
  });
  it('sends neither placeholder when the policy does not require them', async () => {
    const { ctx, core } = setup();
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { name: null, address: null });
    await attemptDelivery(ctx, id);
    expect(core.calls[0]!.input).not.toHaveProperty('Address');
    expect(core.calls[0]!.input).not.toHaveProperty('ContactName');
  });
});

describe('demo submissions (PRD §6.3, AC11)', () => {
  it('are marked received without ever reaching the Core client', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { is_demo: true, intake_code: 'DEMO-DEPT' });
    expect(await attemptDelivery(ctx, id)).toBe('received');
    const row = await getSubmission(ctx.db, id);
    expect(row).toMatchObject({ status: 'received', core_call_id: null });
    expect(row.delivered_at).toEqual(ctx.clock.now());
    expect(await eventsFor(ctx.db, id)).toMatchObject([
      { from_status: 'queued', to_status: 'received', cause: 'demo' },
    ]);
    expect(ctx.alerts.alerts).toEqual([]);
  });
  it('are delivered even while paused, still without Core', async () => {
    const ctx = createTestContext({ core: unusedCore() });
    await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
    const id = await insertSubmission(ctx.db, ctx.clock.now(), { is_demo: true, intake_code: 'DEMO-DEPT' });
    expect(await attemptDelivery(ctx, id)).toBe('received');
  });
});
