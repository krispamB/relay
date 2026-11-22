/**
 * `POST /v1/sos/{receiptId}/recording`. docs/live-sos-plan.md §3.4, D7, D9.
 *
 * The body is the raw `.m4a`, not JSON, so the route lives in its own encapsulated scope: that scope
 * accepts `audio/mp4` only (every other type is a 415) and has a 400 KB body limit, and neither
 * reaches any other route. The access token is checked in onRequest, before the body is read.
 *
 * The audio is never logged: the handler logs receipt id, recording id, size and sequence only, and a
 * failure is logged through safeError, which drops database detail.
 */
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { PublicApp } from '../app.js';
import { deriveAuthKeys } from '../auth/keys.js';
import type { AppContext } from '../context.js';
import { errors, safeError } from '../errors.js';
import { RECEIPT_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { METRICS } from '../metrics.js';
import { looksLikeMp4 } from '../recordings/container.js';
import { recordingErrors } from '../recordings/errors.js';
import { storeRecording, type UploadOutcome } from '../recordings/upload.js';
import { type Caller, requireCaller } from '../sos/caller.js';
import { ErrorObject } from '../sos/schemas.js';

/** Plan D9: a body over this is refused without decoding it. 60 s at 32 kbps is about 240 KB. */
export const MAX_RECORDING_BYTES = 400_000;
export const MAX_RECORDING_DURATION_MS = 60_000;

const receiptIdRe = new RegExp(RECEIPT_ID_PATTERN);
const uuidRe = new RegExp(UUID_PATTERN);
const durationRe = /^[1-9][0-9]{0,4}$/;

const RecordingHeaders = Type.Object({
  'idempotency-key': Type.String({
    pattern: UUID_PATTERN,
    description: 'UUID. One per recording, reused on every retry of the same bytes.',
  }),
  'x-recording-duration-ms': Type.String({
    pattern: durationRe.source,
    description: `Length of the recording in milliseconds: an integer from 1 to ${MAX_RECORDING_DURATION_MS}.`,
  }),
});

const RecordingReceipt = Type.Object({
  recordingId: Type.String({ description: '`rec_` + ULID.' }),
  seq: Type.Integer({ minimum: 1, description: '1-based position among the SOS recordings.' }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('attached'), Type.Literal('dropped')], {
    description:
      '`pending` until the relay has attached it to the Core call. A replay answers with the current status.',
  }),
});

const errorResponse = (description: string) => Type.Object({ error: ErrorObject }, { description });

const callers = new WeakMap<FastifyRequest, Caller>();

export async function recordingRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);

  await app.register(async (scope) => {
    // Only audio/mp4 is parsed here; the JSON parser of the parent is not inherited.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'audio/mp4',
      { parseAs: 'buffer', bodyLimit: MAX_RECORDING_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.withTypeProvider<TypeBoxTypeProvider>().post(
      '/v1/sos/:receiptId/recording',
      {
        bodyLimit: MAX_RECORDING_BYTES,
        // The schemas below describe the route for the OpenAPI document. The body is a Buffer and the
        // headers are checked by hand (one 400 with the relay's own code), so nothing is compiled.
        validatorCompiler: () => (data) => ({ value: data }),
        schema: {
          operationId: 'uploadSosRecording',
          summary: 'Upload the voice recording of an SOS.',
          description:
            "The raw `.m4a` (AAC in an MP4 container) as the request body, `Content-Type: audio/mp4`, at most 400 000 bytes. The relay checks the size, the `ftyp` box and the declared duration; it does not decode the audio. It stores the recording and attaches it to the Core call once the call exists, retrying like delivery. Only the SOS's owner can upload: anyone else's receipt is a 404.",
          tags: ['sos'],
          security: [{ accessToken: [] }],
          consumes: ['audio/mp4'],
          params: Type.Object({ receiptId: Type.String() }),
          headers: RecordingHeaders,
          // Not validated (the body is a Buffer); here for the OpenAPI document.
          body: Type.Unsafe<Buffer>({ format: 'binary', description: 'The raw audio bytes.' }),
          response: {
            200: Type.Object(RecordingReceipt.properties, {
              description: 'A replay: the same Idempotency-Key and the same bytes.',
            }),
            202: Type.Object(RecordingReceipt.properties, {
              description: 'Stored; the relay will attach it to the call.',
            }),
            400: errorResponse('Empty body, not an MP4 container, or bad headers.'),
            401: errorResponse('The access token is missing, not valid, or expired.'),
            404: errorResponse('Not found: unknown receipt, or not the signed-in user’s.'),
            409: errorResponse(
              '`recording_limit`: the SOS already holds its recordings (`RECORDINGS_PER_SOS`). `sos_closed`: the SOS is closed or failed, so the audio can never be attached.',
            ),
            413: errorResponse('`payload_too_large`: over 400 000 bytes.'),
            415: errorResponse('The content type is not `audio/mp4`.'),
            422: errorResponse('`idempotency_key_reused`: the same key, different bytes.'),
            429: errorResponse('Rate limited.'),
          },
        },
        onRequest: async (req) => {
          callers.set(req, await requireCaller(ctx, keys, req));
        },
      },
      async (req, reply) => {
        const caller = callers.get(req);
        if (!caller) throw new Error('recording handler reached without a caller');
        const { receiptId } = req.params;
        if (!receiptIdRe.test(receiptId)) throw errors.notFound();

        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !uuidRe.test(idempotencyKey)) {
          throw recordingErrors.invalid('Idempotency-Key must be a UUID.');
        }
        const durationHeader = req.headers['x-recording-duration-ms'];
        const durationMs =
          typeof durationHeader === 'string' && durationRe.test(durationHeader) ? Number(durationHeader) : 0;
        if (durationMs < 1 || durationMs > MAX_RECORDING_DURATION_MS) {
          throw recordingErrors.invalid(
            `X-Recording-Duration-Ms must be an integer from 1 to ${MAX_RECORDING_DURATION_MS}.`,
          );
        }
        const bytes = req.body as unknown;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw recordingErrors.invalid('The recording is empty.');
        }
        if (!looksLikeMp4(bytes)) throw recordingErrors.invalid('The recording is not an MP4 audio file.');

        let outcome: UploadOutcome;
        try {
          outcome = await storeRecording(ctx, {
            userId: caller.userId,
            receiptId,
            idempotencyKey,
            bytes,
            durationMs,
          });
        } catch (err) {
          // Replace the error so nothing downstream can log a database detail.
          req.log.error({ error: safeError(err), receiptId }, 'recording upload failed');
          throw new Error('recording upload failed');
        }

        switch (outcome.kind) {
          case 'not_found':
            throw errors.notFound();
          case 'sos_closed':
            ctx.metrics.inc(METRICS.recordingUploads, { result: 'sos_closed' });
            throw recordingErrors.sosClosed();
          case 'limit':
            ctx.metrics.inc(METRICS.recordingUploads, { result: 'recording_limit' });
            throw recordingErrors.limit();
          case 'key_reused':
            ctx.metrics.inc(METRICS.recordingUploads, { result: 'key_reused' });
            throw recordingErrors.keyReused();
          case 'replay':
            ctx.metrics.inc(METRICS.recordingUploads, { result: 'replay' });
            req.log.info({ receiptId, recordingId: outcome.recording.recordingId }, 'recording replay');
            return reply.code(200).send(outcome.recording);
          case 'created':
            ctx.metrics.inc(METRICS.recordingUploads, { result: 'accepted' });
            req.log.info(
              {
                receiptId,
                recordingId: outcome.recording.recordingId,
                seq: outcome.recording.seq,
                size: bytes.length,
                durationMs,
              },
              'recording accepted',
            );
            return reply.code(202).send(outcome.recording);
        }
      },
    );
  });
}
