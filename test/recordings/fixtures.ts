import { createHash, randomUUID } from 'node:crypto';
import type { PublicApp } from '../../src/app.js';
import type { SubmissionStatus } from '../../src/db/types.js';
import { newReceiptId } from '../../src/ids.js';
import { type SeededUser, seedUser } from '../helpers/seed.js';
import { insertSubmissionOn } from '../jobs/fixtures.js';
import type { Harness } from '../sos/helpers.js';

/** A small body that passes the container check: an `ftyp` box, then filler that marks the bytes. */
export function m4a(marker = 'audio', size = 64): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0);
  head.write('ftypM4A ', 4, 'latin1');
  const tail = Buffer.alloc(Math.max(0, size - head.length));
  tail.write(marker, 0, 'latin1');
  return Buffer.concat([head, tail]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface UploadOpts {
  token?: string | null;
  key?: string | null;
  durationMs?: string | null;
  contentType?: string | null;
  body?: Buffer | string;
  headers?: Record<string, string>;
}

export async function upload(app: PublicApp, receiptId: string, opts: UploadOpts = {}) {
  const headers: Record<string, string> = { 'x-real-ip': '203.0.113.7' };
  if (opts.token !== null && opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  if (opts.durationMs !== null) headers['x-recording-duration-ms'] = opts.durationMs ?? '12000';
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'audio/mp4';
  const res = await app.inject({
    method: 'POST',
    url: `/v1/sos/${receiptId}/recording`,
    headers: { ...headers, ...opts.headers },
    payload: opts.body ?? m4a(),
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
  return { status: res.statusCode, body: res.json() as Record<string, any>, headers: res.headers };
}

/** A signed-in user with one SOS in the database (inserted directly: the route under test is the upload). */
export async function userWithSos(
  h: Harness,
  opts: { status?: SubmissionStatus; isDemo?: boolean; coreCallId?: string | null } = {},
): Promise<SeededUser & { receiptId: string; reference: string }> {
  const seeded = await seedUser(h.ctx);
  const status = opts.status ?? 'queued';
  const receiptId = await insertSubmissionOn(h.ctx.db, seeded.user.id, h.ctx.clock.now(), {
    id: newReceiptId(h.ctx.clock.now().getTime()),
    status,
    is_demo: opts.isDemo ?? false,
    core_call_id: opts.coreCallId ?? null,
  });
  const row = await h.ctx.db
    .selectFrom('submissions')
    .select('reference')
    .where('id', '=', receiptId)
    .executeTakeFirstOrThrow();
  return { ...seeded, receiptId, reference: row.reference };
}

export async function recordingsOf(h: Harness, receiptId: string) {
  return h.ctx.db
    .selectFrom('recordings')
    .selectAll()
    .where('submission_id', '=', receiptId)
    .orderBy('seq')
    .execute();
}

export async function liveVersion(h: Harness, receiptId: string): Promise<number> {
  const row = await h.ctx.db
    .selectFrom('submissions')
    .select('live_version')
    .where('id', '=', receiptId)
    .executeTakeFirstOrThrow();
  return Number(row.live_version);
}
