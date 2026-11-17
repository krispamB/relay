/** Device registration routes (PRD §7.2). Logic lives in src/devices/. */
import { type Static, Type } from '@sinclair/typebox';
import { clientIp, type PublicApp } from '../app.js';
import type { AppContext } from '../context.js';
import { bearerToken } from '../devices/auth.js';
import { issueNonce, NONCE_PATTERN } from '../devices/nonces.js';
import { registerDevice } from '../devices/registration.js';

const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  { description: 'Error body (PRD §7). A 403 never says why.' },
);

const Nonce = Type.String({
  pattern: NONCE_PATTERN,
  description: 'The nonce from GET /v1/devices/nonce, as-is. URL-safe base64 without padding, 43 characters.',
});

const NonceResponse = Type.Object({
  nonce: Nonce,
  expiresAt: Type.String({ format: 'date-time' }),
});

/** Size caps from docs/attestation-contract.md: attestationObject decodes to at most 64 KiB. */
const MAX_ATTESTATION_OBJECT_CHARS = Math.ceil((64 * 1024) / 3) * 4;
const MAX_INTEGRITY_TOKEN_CHARS = 16_384;

const AndroidAttestation = Type.Object(
  {
    integrityToken: Type.String({
      minLength: 1,
      maxLength: MAX_INTEGRITY_TOKEN_CHARS,
      description:
        'IntegrityTokenResponse.token() from a classic Play Integrity request with the nonce, as-is.',
    }),
  },
  { additionalProperties: false },
);

const IosAttestation = Type.Object(
  {
    keyId: Type.String({
      minLength: 1,
      maxLength: 128,
      description: 'The App Attest key id from generateKey(), standard base64.',
    }),
    attestationObject: Type.String({
      minLength: 1,
      maxLength: MAX_ATTESTATION_OBJECT_CHARS,
      description: 'attestKey(keyId, clientDataHash: SHA-256(UTF-8(nonce))), standard base64.',
    }),
  },
  { additionalProperties: false },
);

const RegisterBody = Type.Union(
  [
    Type.Object(
      {
        platform: Type.Literal('android'),
        nonce: Nonce,
        attestation: Type.Optional(AndroidAttestation),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        platform: Type.Literal('ios'),
        nonce: Nonce,
        attestation: Type.Optional(IosAttestation),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      'attestation is required in enforce mode; it may be left out only against a relay in permissive mode.',
  },
);
type RegisterBody = Static<typeof RegisterBody>;

const RegisterResponse = Type.Object({
  deviceId: Type.String({ pattern: '^dev_[0-9A-HJKMNP-TV-Z]{26}$' }),
  deviceToken: Type.String({ description: 'Opaque. Send as Authorization: Bearer. Store securely.' }),
  expiresAt: Type.String({ format: 'date-time' }),
});

/** Room for the largest attestationObject the verifier accepts; the app-wide limit is 16 KiB. */
const REGISTER_BODY_LIMIT = 96 * 1024;

export async function devicesRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  app.get(
    '/v1/devices/nonce',
    {
      schema: {
        operationId: 'getDeviceNonce',
        tags: ['devices'],
        summary: 'Get a single-use registration nonce, valid for 5 minutes.',
        response: { 200: NonceResponse, 429: ErrorResponse },
      },
    },
    async () => {
      const { nonce, expiresAt } = await issueNonce(ctx.db, ctx.clock.now());
      return { nonce, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    '/v1/devices/register',
    {
      bodyLimit: REGISTER_BODY_LIMIT,
      schema: {
        operationId: 'registerDevice',
        tags: ['devices'],
        summary: 'Register or renew a device with a platform attestation.',
        description:
          'Send the current device token as Authorization: Bearer to renew: the deviceId is kept, even if ' +
          'the token has expired. Without a known token a new device is created. Fetch a new nonce after any failure.',
        security: [{ deviceToken: [] }, {}],
        body: RegisterBody,
        response: {
          201: RegisterResponse,
          400: ErrorResponse,
          403: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const body: RegisterBody = req.body;
      const result = await registerDevice(ctx, req.log, {
        platform: body.platform,
        nonce: body.nonce,
        attestation: body.attestation,
        bearerToken: bearerToken(req),
        ip: clientIp(req, ctx.config.clientIpHeader),
      });
      return reply.status(201).send({
        deviceId: result.deviceId,
        deviceToken: result.deviceToken,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );
}
