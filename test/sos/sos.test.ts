import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE } from '../../src/clock.js';
import { phoneHash, statusTokenFor } from '../../src/crypto.js';
import { parseIntakes } from '../../src/intakes.js';
import { METRICS } from '../../src/metrics.js';
import { resetSosBudget, setSosBudget } from '../../src/sos/budget.js';
import { pauseDelivery } from '../../src/state.js';
import { eventsFor, getSubmission, ok, scriptedCore } from '../delivery/fixtures.js';
import {
  closeTestDb,
  DEMO_INTAKE_CODE,
  resetDb,
  TEST_INTAKE_CODE,
  testConfig,
  unusedCore,
} from '../helpers/context.js';
import { seedDevice } from '../helpers/seed.js';
import {
  ADDRESS,
  DETAILS,
  device,
  fakeAttestation,
  type Harness,
  harness,
  isoAgo,
  LAT,
  LON,
  NAME,
  PHONE,
  postSos,
  sosBody,
  submissionCount,
} from './helpers.js';

let h: Harness | undefined;
beforeEach(() => resetDb());
afterEach(async () => {
  await h?.app.close();
  h = undefined;
});
afterAll(() => closeTestDb());

const RECEIPT_ID = /^sos_[0-9A-HJKMNP-TV-Z]{26}$/;
const REFERENCE = /^SOS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

async function block(hh: Harness, type: 'device' | 'phone', subject: string) {
  await hh.ctx.db
    .insertInto('blocks')
    .values({
      id: `blk_${randomUUID()}`,
      subject_type: type,
      subject,
      reason: 'test',
      source: 'manual',
      created_at: hh.ctx.clock.now(),
      expires_at: null,
    })
    .execute();
}

describe('responses (PRD §7.4, app PRD §7.1)', () => {
  it('201 received: the five-field body, a stored E.164 submission and one Core call', async () => {
    const core = scriptedCore(ok('48213'));
    h = await harness({ core });
    const d = await device(h);
    const res = await d.send();

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'receiptId',
      'reference',
      'status',
      'statusToken',
      'submittedAt',
    ]);
    expect(res.body.status).toBe('received');
    expect(res.body.receiptId).toMatch(RECEIPT_ID);
    expect(res.body.reference).toMatch(REFERENCE);
    expect(res.body.statusToken).toBe(statusTokenFor(h.ctx.config.statusTokenSecret, res.body.receiptId));
    expect(res.body.submittedAt).toBe('2026-11-17T12:00:00Z');

    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({
      status: 'received',
      core_call_id: '48213',
      device_id: d.device.id,
      intake_code: TEST_INTAKE_CODE,
      is_demo: false,
      reference: res.body.reference,
      nature_id: 'fire',
      nature_label: 'Fire',
      phone: PHONE,
      phone_hash: phoneHash(h.ctx.config.phoneHashSecret, PHONE),
      name: NAME,
      details: DETAILS,
      lat: LAT,
      lon: LON,
      accuracy_m: 12,
      location_source: 'gps',
      ip: '203.0.113.7',
    });
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.submissionId).toBe(res.body.receiptId);
    expect(await eventsFor(h.ctx.db, row.id)).toMatchObject([
      { from_status: null, to_status: 'queued', cause: 'accepted' },
      { from_status: 'queued', to_status: 'received' },
    ]);
  });

  it('201 failed when Core rejects the call', async () => {
    h = await harness({ core: scriptedCore({ kind: 'rejected', httpStatus: 400, message: 'bad' }) });
    const res = await (await device(h)).send();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect((await getSubmission(h.ctx.db, res.body.receiptId)).status).toBe('failed');
  });

  it.each([
    ['429', { kind: 'retryable', reason: 'HTTP 429', retryAfterSeconds: 20 } as const, 20_000],
    ['5xx', { kind: 'retryable', reason: 'HTTP 503' } as const, 5_000],
    ['timeout', { kind: 'retryable', reason: 'timeout' } as const, 5_000],
    ['409 in flight', { kind: 'conflict' } as const, 5_000],
  ])('202 queued on Core %s, keeping the backoff delivery set', async (_n, result, delayMs) => {
    h = await harness({ core: scriptedCore(result) });
    const res = await (await device(h)).send();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.statusToken).toBe(statusTokenFor(h.ctx.config.statusTokenSecret, res.body.receiptId));
    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row.status).toBe('queued');
    expect(row.next_attempt_at!.getTime() - h.ctx.clock.now().getTime()).toBe(delayMs);
    expect(h.metrics.count(METRICS.submissions, { outcome: 'queued' })).toBe(1);
  });

  it.each([401, 403])(
    '503 on Core %i: delivery pauses, the SOS is marked failed and nothing later contradicts the 503',
    async (s) => {
      const core = scriptedCore({ kind: 'auth', httpStatus: s }, ok());
      h = await harness({ core });
      const d = await device(h);
      const key = randomUUID();
      const res = await d.send({}, { key });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: {
          code: 'unavailable',
          message: 'This service cannot take an SOS right now.',
          retryAfterSeconds: 60,
        },
      });
      expect(res.headers['retry-after']).toBe('60');
      expect(
        (await h.ctx.db.selectFrom('relay_state').select('paused').executeTakeFirstOrThrow()).paused,
      ).toBe(true);
      expect(h.ctx.alerts.codes()).toEqual(['delivery_paused']);
      expect(h.metrics.count(METRICS.submissions, { outcome: 'not_sent' })).toBe(1);
      expect(h.metrics.count(METRICS.submissions, { outcome: 'queued' })).toBe(0);

      // The row: failed, never to be attempted again.
      const rows = await h.ctx.db.selectFrom('submissions').selectAll().execute();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ status: 'failed', next_attempt_at: null, attempts: 1 });
      expect(row.failure_reason).toContain('not sent');
      expect(await eventsFor(h.ctx.db, row.id)).toMatchObject([
        { to_status: 'queued', cause: 'accepted' },
        { from_status: 'queued', to_status: 'failed', cause: `not_sent_core_auth_${s}` },
      ]);

      // A replay with the same key: 201 failed, the app's "NOT DELIVERED, call now". No Core call.
      const replay = await d.send({}, { key });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ receiptId: row.id, reference: row.reference, status: 'failed' });

      // The status endpoint says failed too.
      const status = await h.app.inject({
        method: 'GET',
        url: `/v1/sos/${row.id}/status`,
        headers: { 'x-status-token': replay.body.statusToken },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().status).toBe('failed');

      // A new SOS from the device is not a 409 pointing at the refused one: it is refused while paused.
      const next = await d.send();
      expect(next.status).toBe(503);
      expect(next.body.receiptId).toBeUndefined();

      // Once resumed, a new SOS goes through, and the refused one is never sent.
      await h.ctx.db.updateTable('relay_state').set({ paused: false }).where('id', '=', 1).execute();
      const after = await d.send();
      expect(after.status).toBe(201);
      expect(after.body.status).toBe('received');
      expect(core.calls.map((c) => c.submissionId)).toEqual([row.id, after.body.receiptId]);
    },
  );

  describe('delivery paused by something else after the availability check', () => {
    // Pauses delivery in the same transaction that saves the SOS, i.e. after step 10 passed.
    async function pauseOnInsert(hh: Harness) {
      await sql`CREATE OR REPLACE FUNCTION test_pause_on_insert() RETURNS trigger AS $$
        BEGIN UPDATE relay_state SET paused = true, paused_reason = 'test' WHERE id = 1; RETURN NEW; END
        $$ LANGUAGE plpgsql`.execute(hh.ctx.db);
      await sql`CREATE TRIGGER test_pause_on_insert AFTER INSERT ON submissions
        FOR EACH ROW EXECUTE FUNCTION test_pause_on_insert()`.execute(hh.ctx.db);
    }
    afterEach(async () => {
      if (!h) return;
      await sql`DROP TRIGGER IF EXISTS test_pause_on_insert ON submissions`.execute(h.ctx.db);
      await sql`DROP FUNCTION IF EXISTS test_pause_on_insert()`.execute(h.ctx.db);
      resetSosBudget();
    });

    it('503 with no Core call; the SOS is marked failed', async () => {
      h = await harness({ core: unusedCore() });
      await pauseOnInsert(h);
      const d = await device(h);
      const res = await d.send();
      expect(res.status).toBe(503);
      const row = await h.ctx.db.selectFrom('submissions').selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'failed', attempts: 0, next_attempt_at: null });
      expect(await eventsFor(h.ctx.db, row.id)).toMatchObject([
        { cause: 'accepted' },
        { from_status: 'queued', to_status: 'failed', cause: 'not_sent_paused' },
      ]);
      expect(h.ctx.alerts.alerts).toEqual([]);
    });

    it('503 also when no time was left for an inline attempt', async () => {
      h = await harness({ core: unusedCore() });
      await pauseOnInsert(h);
      setSosBudget({ minInlineMs: 60_000 });
      const res = await (await device(h)).send();
      expect(res.status).toBe(503);
      const row = await h.ctx.db.selectFrom('submissions').selectAll().executeTakeFirstOrThrow();
      expect(row.status).toBe('failed');
    });

    it('with no pause, no time left still answers 202 queued for the worker', async () => {
      h = await harness({ core: unusedCore() });
      setSosBudget({ minInlineMs: 60_000 });
      const res = await (await device(h)).send();
      expect(res.status).toBe(202);
      const row = await getSubmission(h.ctx.db, res.body.receiptId);
      expect(row.status).toBe('queued');
      expect(row.next_attempt_at).toEqual(h.ctx.clock.now());
    });
  });

  it('a demo SOS is still accepted and received while paused', async () => {
    h = await harness({ core: unusedCore() });
    const d = await device(h);
    await pauseDelivery(h.ctx.db, h.ctx.clock.now(), 'test');
    const res = await d.send({ intakeCode: DEMO_INTAKE_CODE, nature: 'medical' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
  });

  it('the row is held past the inline attempt while Core is being called', async () => {
    let heldFor = 0;
    const core = scriptedCore(async (rec) => {
      const row = await getSubmission(h!.ctx.db, rec.submissionId);
      heldFor = row.next_attempt_at!.getTime() - h!.ctx.clock.now().getTime();
      return ok();
    });
    h = await harness({ core });
    expect((await (await device(h)).send()).status).toBe(201);
    expect(heldFor).toBeGreaterThanOrEqual(15_000);
  });

  it('409 carries the error object and the open submission’s five fields', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    const first = await d.send();
    const second = await d.send({ nature: 'medical' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'sos_already_open' });
    expect(second.body).toMatchObject({
      receiptId: first.body.receiptId,
      statusToken: first.body.statusToken,
      reference: first.body.reference,
      status: 'received',
      submittedAt: first.body.submittedAt,
    });
    expect(await submissionCount(h)).toBe(1);
    expect(h.metrics.count(METRICS.submissions, { outcome: 'conflict' })).toBe(1);
  });

  it('401 for a missing, unknown or expired device token', async () => {
    h = await harness();
    expect((await postSos(h.app, { body: sosBody(h.ctx) })).status).toBe(401);
    expect((await postSos(h.app, { token: 'nope', body: sosBody(h.ctx) })).status).toBe(401);
    const expired = await seedDevice(h.ctx, { expiresInMs: -1000 });
    const res = await postSos(h.app, { token: expired.token, body: sosBody(h.ctx) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('403 for a blocked device, a blocked phone and a refused attestation, never saying why', async () => {
    h = await harness();
    const blocked = await device(h);
    await block(h, 'device', blocked.device.id);
    const a = await blocked.send();

    await block(h, 'phone', phoneHash(h.ctx.config.phoneHashSecret, PHONE));
    const b = await (await device(h)).send();

    for (const res of [a, b]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'forbidden', message: 'This request is not allowed.' } });
    }
    expect(await submissionCount(h)).toBe(0);
  });

  it('404 for an unknown intake, 410 for a disabled one', async () => {
    h = await harness();
    h.ctx.intakes = parseIntakes([
      {
        code: TEST_INTAKE_CODE,
        displayName: 'T',
        emergencyPhone: '112',
        natures: [{ id: 'fire', label: 'Fire' }],
        enabled: false,
      },
    ]);
    const d = await device(h);
    const gone = await d.send();
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe('intake_disabled');
    const unknown = await d.send({ intakeCode: 'NO-SUCH-INTAKE' });
    expect(unknown.status).toBe(404);
  });

  it.each([
    ['paused', async (hh: Harness) => void (await pauseDelivery(hh.ctx.db, hh.ctx.clock.now(), 'test'))],
    [
      'unhealthy',
      async (hh: Harness) =>
        void (await hh.ctx.db
          .updateTable('relay_state')
          .set({ check_status: 'unhealthy' })
          .where('id', '=', 1)
          .execute()),
    ],
    ['never checked', async (_hh: Harness) => {}],
    [
      'last good check over 24 h ago',
      async (hh: Harness) => {
        hh.ctx.clock.advance(24 * 60 * MINUTE + 1000);
      },
    ],
  ])('503 with Retry-After and nothing persisted when the intake is %s', async (name, arrange) => {
    h = await harness({ healthy: name !== 'never checked' });
    await arrange(h);
    const res = await (await device(h)).send();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('unavailable');
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.body.error.retryAfterSeconds));
    expect(await submissionCount(h)).toBe(0);
  });
});

describe('replays (PRD §7.4, §8.3, AC3)', () => {
  it('a retry with the same key returns the same receipt and status token, and sends nothing', async () => {
    const core = scriptedCore(ok());
    h = await harness({ core });
    const d = await device(h);
    const key = randomUUID();
    const first = await d.send({}, { key });
    const again = await d.send({}, { key });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(core.calls).toHaveLength(1);
    expect(await submissionCount(h)).toBe(1);
    expect(h.metrics.count(METRICS.submissions, { outcome: 'replay' })).toBe(1);
  });

  it('returns the current state: 202 while queued, 201 once dispatched or closed', async () => {
    h = await harness({ core: scriptedCore({ kind: 'retryable', reason: 'HTTP 503' }) });
    const d = await device(h);
    const key = randomUUID();
    const first = await d.send({}, { key });
    expect(first.status).toBe(202);

    const queued = await d.send({}, { key });
    expect(queued.status).toBe(202);
    expect(queued.body.status).toBe('queued');

    for (const status of ['dispatched', 'closed'] as const) {
      await h.ctx.db
        .updateTable('submissions')
        .set({ status })
        .where('id', '=', first.body.receiptId)
        .execute();
      const res = await d.send({}, { key });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ...first.body, status });
    }
  });

  it('the body is not compared: a different body with the same key is still a replay', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    const key = randomUUID();
    const first = await d.send({}, { key });
    const again = await d.send({ nature: 'medical', details: 'changed' }, { key });
    expect(again.body.receiptId).toBe(first.body.receiptId);
  });

  it('a replay is answered even when its location has since gone stale', async () => {
    h = await harness({ core: scriptedCore({ kind: 'retryable', reason: 'timeout' }) });
    const d = await device(h);
    const key = randomUUID();
    const body = sosBody(h.ctx, { address: undefined });
    const first = await postSos(h.app, { token: d.token, key, body });
    expect(first.status).toBe(202);
    h.ctx.clock.advance(11 * MINUTE);
    const again = await postSos(h.app, { token: d.token, key, body });
    expect(again.status).toBe(202);
    expect(again.body.receiptId).toBe(first.body.receiptId);
  });
});

describe('the order of checks (PRD §7.4)', () => {
  it('1 before 2 and 3: an invalid token is a 401 whatever the body', async () => {
    h = await harness();
    const res = await postSos(h.app, { token: 'bad', key: 'not-a-uuid', payload: '{"x":' });
    expect(res.status).toBe(401);
  });

  it('2 before 3: a blocked device gets 403 even for an invalid body', async () => {
    h = await harness();
    const d = await device(h);
    await block(h, 'device', d.device.id);
    const res = await postSos(h.app, { token: d.token, key: 'not-a-uuid', body: { nope: true } });
    expect(res.status).toBe(403);
  });

  it('3 before 4: an invalid body is a 400 and attestation is never consulted', async () => {
    const att = fakeAttestation(() => ({ accepted: false, reason: 'x' }));
    h = await harness({ attestation: att });
    const d = await device(h);
    expect((await d.send({ phone: '12345' })).status).toBe(400);
    expect(att.requests).toHaveLength(0);
  });

  it('4 before 5: a refused attestation is a 403 even for an unknown intake', async () => {
    h = await harness({ attestation: fakeAttestation(() => ({ accepted: false, reason: 'x' })) });
    expect((await (await device(h)).send({ intakeCode: 'NO-SUCH-INTAKE' })).status).toBe(403);
  });

  it('5 before 6: a replay to an intake that has since been disabled gets 410', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    const key = randomUUID();
    expect((await d.send({}, { key })).status).toBe(201);
    h.ctx.intakes = parseIntakes([
      {
        code: TEST_INTAKE_CODE,
        displayName: 'T',
        emergencyPhone: '112',
        natures: [{ id: 'fire', label: 'Fire' }],
        enabled: false,
      },
    ]);
    expect((await d.send({}, { key })).status).toBe(410);
  });

  it('6 before 7: a replay of the open submission is a replay, not a 409', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    const key = randomUUID();
    await d.send({}, { key });
    expect((await d.send({}, { key })).status).toBe(201);
  });

  it('6 and 7 before 8: after the phone is blocked, the replay and the 409 still carry the receipt', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const d = await device(h);
    const key = randomUUID();
    const first = await d.send({}, { key });
    await block(h, 'phone', phoneHash(h.ctx.config.phoneHashSecret, PHONE));
    const replay = await d.send({}, { key });
    expect(replay.status).toBe(201);
    expect(replay.body.receiptId).toBe(first.body.receiptId);
    const conflict = await d.send();
    expect(conflict.status).toBe(409);
    expect(conflict.body.receiptId).toBe(first.body.receiptId);
  });

  it('6 and 7 before 9 and 10: replay and 409 are answered while paused and while over a limit', async () => {
    h = await harness({
      core: scriptedCore({ kind: 'retryable', reason: 'timeout' }),
      limits: { sosPerDevicePer24h: 1, sosPerIpPerHour: 1, sosPerPhonePer24h: 1, intakeBreakerCount: 1 },
    });
    const d = await device(h);
    const key = randomUUID();
    const first = await d.send({}, { key });
    expect(first.status).toBe(202);
    await pauseDelivery(h.ctx.db, h.ctx.clock.now(), 'test');

    const replay = await d.send({}, { key });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    const conflict = await d.send();
    expect(conflict.status).toBe(409);
    expect(conflict.body.statusToken).toBe(first.body.statusToken);
  });

  it('8 before 9: a blocked phone over a limit gets 403, not 429', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: { sosPerPhonePer24h: 1 } });
    await (await device(h)).send();
    await block(h, 'phone', phoneHash(h.ctx.config.phoneHashSecret, PHONE));
    expect((await (await device(h)).send()).status).toBe(403);
  });

  it('9 before 10: over a limit while paused is a 429, not a 503', async () => {
    h = await harness({ core: scriptedCore(ok()), limits: { sosPerPhonePer24h: 1 } });
    await (await device(h)).send();
    await pauseDelivery(h.ctx.db, h.ctx.clock.now(), 'test');
    expect((await (await device(h)).send()).status).toBe(429);
  });
});

describe('attestation (PRD §7.4, §10.1, AC13)', () => {
  it('passes the hash of the key and the raw bytes as received, and the header as sent', async () => {
    const att = fakeAttestation();
    h = await harness({ attestation: att, core: scriptedCore(ok()) });
    const d = await device(h);
    const key = randomUUID();
    // Unusual spacing and key order: the hash must cover these exact bytes.
    const payload = `{ "phone":"${PHONE}",  "intakeCode":"${TEST_INTAKE_CODE}","nature":"fire",\n"address":"x"}`;
    const res = await postSos(h.app, {
      token: d.token,
      key,
      payload,
      headers: { 'x-attestation': 'abc123==' },
    });
    expect(res.status).toBe(201);
    const expected = createHash('sha256').update(`${key}\n${payload}`).digest();
    expect(att.requests[0]!.bindingHash.equals(expected)).toBe(true);
    expect(att.requests[0]!.attestation).toBe('abc123==');
    expect(att.requests[0]!.platform).toBe('android');
  });

  it('passes undefined when no attestation header is sent', async () => {
    const att = fakeAttestation();
    h = await harness({ attestation: att, core: scriptedCore(ok()) });
    await (await device(h)).send();
    expect(att.requests[0]!.attestation).toBeUndefined();
  });

  it('an enforce-style refusal is a bare 403 and persists nothing', async () => {
    h = await harness({
      attestation: fakeAttestation(() => ({ accepted: false, reason: 'requestHash mismatch' })),
    });
    const res = await (await device(h)).send();
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('mismatch');
    expect(await submissionCount(h)).toBe(0);
  });

  it('stores the new iOS counter and passes the stored one in', async () => {
    const att = fakeAttestation((input) => ({
      accepted: true,
      attested: true,
      iosCounter: input.device.iosCounter + 1,
    }));
    h = await harness({ attestation: att, core: scriptedCore(ok()) });
    const d = await device(h, 'ios');
    await h.ctx.db
      .updateTable('devices')
      .set({ ios_counter: 41, ios_public_key: 'PEM' })
      .where('id', '=', d.device.id)
      .execute();
    expect((await d.send()).status).toBe(201);
    expect(att.requests[0]!.device).toEqual({ iosPublicKeyPem: 'PEM', iosCounter: 41 });
    const row = await h.ctx.db
      .selectFrom('devices')
      .select('ios_counter')
      .where('id', '=', d.device.id)
      .executeTakeFirstOrThrow();
    expect(row.ios_counter).toBe('42');
  });

  it('in enforce mode, a counter another request already stored is refused (racing assertions)', async () => {
    const enforce = { ...testConfig().attestation, mode: 'enforce' as const };
    // Verifies against a stale read, as a concurrent request would.
    const att = fakeAttestation(() => ({ accepted: true, attested: true, iosCounter: 5 }));
    h = await harness({ attestation: att, config: { attestation: enforce } });
    const d = await device(h, 'ios');
    await h.ctx.db.updateTable('devices').set({ ios_counter: 5 }).where('id', '=', d.device.id).execute();
    expect((await d.send()).status).toBe(403);
    expect(await submissionCount(h)).toBe(0);
  });
});

describe('demo intake (PRD §6.3)', () => {
  it('works while delivery is paused and never touches Core', async () => {
    h = await harness({ core: unusedCore(), healthy: false });
    await pauseDelivery(h.ctx.db, h.ctx.clock.now(), 'test');
    const d = await device(h);
    const res = await d.send({ intakeCode: DEMO_INTAKE_CODE, nature: 'medical' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
    const row = await getSubmission(h.ctx.db, res.body.receiptId);
    expect(row).toMatchObject({ is_demo: true, intake_code: DEMO_INTAKE_CODE, status: 'received' });
    // Demo submissions stay out of operational metrics.
    expect(h.metrics.incs).toEqual([]);
    expect(h.metrics.observations).toEqual([]);
  });

  it('validates natures against the demo intake', async () => {
    h = await harness({ core: unusedCore() });
    const res = await (await device(h)).send({ intakeCode: DEMO_INTAKE_CODE, nature: 'fire' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('nature_invalid');
  });
});

describe('metrics', () => {
  it('observes the request latency for real submissions', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    await (await device(h)).send();
    expect(h.metrics.observations.filter((o) => o.name === METRICS.sosLatency)).toHaveLength(1);
  });
});

describe('OpenAPI', () => {
  it('documents POST /v1/sos with its headers, body and every response', async () => {
    h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const op = res.json().paths['/v1/sos'].post;
    expect(Object.keys(op.responses).sort()).toEqual(
      ['201', '202', '400', '401', '403', '404', '409', '410', '429', '503'].sort(),
    );
    expect(op.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['idempotency-key', 'x-attestation']),
    );
    const body = op.requestBody.content['application/json'].schema;
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(expect.arrayContaining(['intakeCode', 'nature', 'phone']));
    expect(op.security).toEqual([{ deviceToken: [] }]);
    const conflict = op.responses['409'].content['application/json'].schema;
    expect(Object.keys(conflict.properties).sort()).toEqual(
      ['error', 'receiptId', 'reference', 'status', 'statusToken', 'submittedAt'].sort(),
    );
  });
});

describe('a stale capturedAt relative to the clock', () => {
  it('uses ctx.clock, not the wall clock', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    const res = await (await device(h)).send({
      address: ADDRESS,
      location: { lat: LAT, lon: LON, capturedAt: isoAgo(h.ctx, 11 * MINUTE), source: 'gps' },
    });
    expect(res.status).toBe(201);
    expect((await getSubmission(h.ctx.db, res.body.receiptId)).lat).toBeNull();
  });
});
