import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newReceiptId } from '../../src/ids.js';
import { METRICS } from '../../src/metrics.js';
import { closeTestDb, resetDb } from '../helpers/context.js';
import { seedUser } from '../helpers/seed.js';
import { capturingLogger, harness } from '../sos/helpers.js';
import { liveVersion, m4a, recordingsOf, sha256, upload, userWithSos } from './fixtures.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

describe('POST /v1/sos/:receiptId/recording', () => {
  it('stores the recording and answers 202 pending, with the bytes, size and duration kept', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const bytes = m4a('hello', 200);

    const res = await upload(h.app, u.receiptId, { token: u.token(), body: bytes, durationMs: '11500' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      recordingId: expect.stringMatching(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/),
      seq: 1,
      status: 'pending',
    });
    const [row, ...rest] = await recordingsOf(h, u.receiptId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id: res.body.recordingId,
      seq: 1,
      status: 'pending',
      size: 200,
      duration_ms: 11500,
      body_hash: sha256(bytes),
      attempts: 0,
      core_file_id: null,
    });
    expect(Buffer.compare(row!.bytes!, bytes)).toBe(0);
    // Due at once: the worker attaches it as soon as the call exists.
    expect(row!.next_attempt_at).not.toBeNull();
  });

  it('bumps the live version of the SOS in the same transaction', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    expect(await liveVersion(h, u.receiptId)).toBe(0);
    await upload(h.app, u.receiptId, { token: u.token() });
    expect(await liveVersion(h, u.receiptId)).toBe(1);
  });

  it('answers 200 with the same body for a replay of the same key and bytes, and stores nothing new', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const key = randomUUID();
    const bytes = m4a('same');
    const first = await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes });
    const again = await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes });

    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await recordingsOf(h, u.receiptId)).toHaveLength(1);
    // A replay changes nothing the snapshot shows.
    expect(await liveVersion(h, u.receiptId)).toBe(1);
  });

  it('still answers a replay with 200 after the SOS closed', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const key = randomUUID();
    const bytes = m4a('same');
    await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes });
    await h.ctx.db
      .updateTable('submissions')
      .set({ status: 'closed' })
      .where('id', '=', u.receiptId)
      .execute();

    expect((await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes })).status).toBe(200);
  });

  it('reports what happened to the recording when a replay comes after the worker ran', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const key = randomUUID();
    const bytes = m4a('same');
    const first = await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes });
    await h.ctx.db
      .updateTable('recordings')
      .set({ status: 'attached', bytes: null, core_file_id: '9' })
      .where('id', '=', first.body.recordingId)
      .execute();
    const again = await upload(h.app, u.receiptId, { token: u.token(), key, body: bytes });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, status: 'attached' });
  });

  it('refuses the same key with different bytes: 422 idempotency_key_reused', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const key = randomUUID();
    await upload(h.app, u.receiptId, { token: u.token(), key, body: m4a('one') });
    const res = await upload(h.app, u.receiptId, { token: u.token(), key, body: m4a('two') });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
    expect(await recordingsOf(h, u.receiptId)).toHaveLength(1);
  });

  it('refuses a second recording at the cap: 409 recording_limit', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    await upload(h.app, u.receiptId, { token: u.token() });
    const res = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('another') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('recording_limit');
    expect(await recordingsOf(h, u.receiptId)).toHaveLength(1);
    expect(await liveVersion(h, u.receiptId)).toBe(1);
  });

  it('numbers recordings 1, 2, ... up to RECORDINGS_PER_SOS', async () => {
    const h = await harness({ config: { recordingsPerSos: 2 } });
    const u = await userWithSos(h);
    const a = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('a') });
    const b = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('b') });
    const c = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('c') });
    expect([a.body.seq, b.body.seq]).toEqual([1, 2]);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('recording_limit');
  });

  it.each(['closed', 'failed'] as const)(
    'refuses a recording for a %s SOS: 409 sos_closed',
    async (status) => {
      const h = await harness();
      const u = await userWithSos(h, { status });
      const res = await upload(h.app, u.receiptId, { token: u.token() });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('sos_closed');
      expect(await recordingsOf(h, u.receiptId)).toEqual([]);
    },
  );

  it.each(['queued', 'received', 'dispatched'] as const)(
    'accepts a recording for a %s SOS',
    async (status) => {
      const h = await harness();
      const u = await userWithSos(h, { status });
      expect((await upload(h.app, u.receiptId, { token: u.token() })).status).toBe(202);
    },
  );

  it("answers 404 for another user's SOS, an unknown id and a malformed id, and stores nothing", async () => {
    const h = await harness();
    const owner = await userWithSos(h);
    const other = await seedUser(h.ctx);

    const stranger = await upload(h.app, owner.receiptId, { token: other.token() });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('not_found');
    expect((await upload(h.app, 'sos_0000000000000000000000000X', { token: owner.token() })).status).toBe(
      404,
    );
    expect((await upload(h.app, 'nonsense', { token: owner.token() })).status).toBe(404);
    const unknownButWellFormed = newReceiptId(h.ctx.clock.now().getTime());
    expect((await upload(h.app, unknownButWellFormed, { token: owner.token() })).status).toBe(404);
    expect(await recordingsOf(h, owner.receiptId)).toEqual([]);
    expect(await liveVersion(h, owner.receiptId)).toBe(0);
  });

  it('answers 401 without a valid access token, whatever the body', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    expect((await upload(h.app, u.receiptId)).status).toBe(401);
    expect((await upload(h.app, u.receiptId, { token: 'junk' })).status).toBe(401);
    expect((await upload(h.app, u.receiptId, { body: Buffer.alloc(0) })).status).toBe(401);
    expect((await upload(h.app, u.receiptId, { body: Buffer.alloc(500_000) })).status).toBe(401);
  });

  describe('the body and the headers', () => {
    it('accepts 400 000 bytes and refuses one more with 413 payload_too_large', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      const over = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('big', 400_001) });
      expect(over.status).toBe(413);
      expect(over.body.error.code).toBe('payload_too_large');
      expect(await recordingsOf(h, u.receiptId)).toEqual([]);

      const exact = await upload(h.app, u.receiptId, { token: u.token(), body: m4a('big', 400_000) });
      expect(exact.status).toBe(202);
    });

    it('refuses an empty body: 400', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      const res = await upload(h.app, u.receiptId, { token: u.token(), body: Buffer.alloc(0) });
      expect(res.status).toBe(400);
      expect(await recordingsOf(h, u.receiptId)).toEqual([]);
    });

    it('refuses a body that is not an MP4 container: 400', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      const res = await upload(h.app, u.receiptId, {
        token: u.token(),
        body: Buffer.from('RIFF....WAVEfmt not an mp4'),
      });
      expect(res.status).toBe(400);
      expect(await recordingsOf(h, u.receiptId)).toEqual([]);
    });

    it.each(['0', '60001', '-5', '12.5', 'abc', ' ', '1e3'])(
      'refuses a duration of %j: 400',
      async (durationMs) => {
        const h = await harness();
        const u = await userWithSos(h);
        expect((await upload(h.app, u.receiptId, { token: u.token(), durationMs })).status).toBe(400);
      },
    );

    it.each(['1', '60000'])('accepts a duration of %s', async (durationMs) => {
      const h = await harness();
      const u = await userWithSos(h);
      expect((await upload(h.app, u.receiptId, { token: u.token(), durationMs })).status).toBe(202);
    });

    it('refuses a missing duration or a missing or malformed Idempotency-Key: 400', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      expect((await upload(h.app, u.receiptId, { token: u.token(), durationMs: null })).status).toBe(400);
      expect((await upload(h.app, u.receiptId, { token: u.token(), key: null })).status).toBe(400);
      expect((await upload(h.app, u.receiptId, { token: u.token(), key: 'not-a-uuid' })).status).toBe(400);
    });

    it('takes only audio/mp4: other content types are 415', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      expect(
        (await upload(h.app, u.receiptId, { token: u.token(), contentType: 'application/json', body: '{}' }))
          .status,
      ).toBe(415);
      expect((await upload(h.app, u.receiptId, { token: u.token(), contentType: 'audio/mpeg' })).status).toBe(
        415,
      );
      expect((await upload(h.app, u.receiptId, { token: u.token(), contentType: null })).status).toBe(415);
    });

    it('does not widen the body limit or the content types of any other route', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/sos',
        headers: {
          authorization: `Bearer ${u.token()}`,
          'content-type': 'audio/mp4',
          'idempotency-key': randomUUID(),
        },
        payload: m4a('x', 100),
      });
      expect(res.statusCode).toBe(415);
      const big = await h.app.inject({
        method: 'POST',
        url: '/v1/sos',
        headers: {
          authorization: `Bearer ${u.token()}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        payload: JSON.stringify({ intakeCode: 'x'.repeat(20_000) }),
      });
      expect(big.statusCode).toBe(413);
    });
  });

  it('counts uploads by result', async () => {
    const h = await harness();
    const u = await userWithSos(h);
    const key = randomUUID();
    await upload(h.app, u.receiptId, { token: u.token(), key });
    await upload(h.app, u.receiptId, { token: u.token(), key });
    await upload(h.app, u.receiptId, { token: u.token(), key, body: m4a('other') });
    await upload(h.app, u.receiptId, { token: u.token(), body: m4a('second') });
    const count = (result: string) => h.metrics.count(METRICS.recordingUploads, { result });
    expect([count('accepted'), count('replay'), count('key_reused'), count('recording_limit')]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  describe('concurrency', () => {
    it('stores one recording when the same upload arrives twice at once', async () => {
      const h = await harness();
      const u = await userWithSos(h);
      const key = randomUUID();
      const bytes = m4a('race');
      const results = await Promise.all([
        upload(h.app, u.receiptId, { token: u.token(), key, body: bytes }),
        upload(h.app, u.receiptId, { token: u.token(), key, body: bytes }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 202]);
      expect(results[0]!.body.recordingId).toBe(results[1]!.body.recordingId);
      expect(await recordingsOf(h, u.receiptId)).toHaveLength(1);
    });

    it('never exceeds the cap when different uploads arrive at once', async () => {
      const h = await harness({ config: { recordingsPerSos: 2 } });
      const u = await userWithSos(h);
      const results = await Promise.all(
        [1, 2, 3, 4].map((i) => upload(h.app, u.receiptId, { token: u.token(), body: m4a(`r${i}`) })),
      );
      expect(results.filter((r) => r.status === 202)).toHaveLength(2);
      expect(
        results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'recording_limit'),
      ).toBe(true);
      expect((await recordingsOf(h, u.receiptId)).map((r) => r.seq)).toEqual([1, 2]);
    });
  });

  describe('logs', () => {
    it('never print the audio, in the request log or the error log', async () => {
      const { log, lines } = capturingLogger();
      const h = await harness({ log });
      const u = await userWithSos(h);
      const marker = 'MARKER-AUDIO-BYTES-0123456789';
      const bytes = m4a(marker, 300);
      await upload(h.app, u.receiptId, { token: u.token(), body: bytes });
      await upload(h.app, u.receiptId, { token: u.token(), body: m4a(`${marker}2`, 300) });
      await upload(h.app, u.receiptId, {
        token: u.token(),
        body: Buffer.concat([bytes, Buffer.alloc(400_000)]),
      });
      await upload(h.app, u.receiptId, { token: u.token(), body: Buffer.from(marker) });

      const all = lines.join('\n');
      expect(all).not.toContain(marker);
      expect(all).not.toContain(bytes.toString('base64').slice(10, 60));
      expect(all).not.toContain(bytes.toString('hex').slice(0, 40));
      // The log does say that an upload happened, by receipt id and recording id only.
      expect(all).toContain('recording accepted');
    });
  });
});
