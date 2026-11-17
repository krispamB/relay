/** TypeBox schemas for `POST /v1/sos`. sos-relay-PRD.md §7, §7.4. They also drive the OpenAPI document. */
import { type Static, Type } from '@sinclair/typebox';
import { UUID_PATTERN } from '../ids.js';

/** Upper bounds applied after sanitising (PRD §7.4), in Unicode code points. */
export const MAX_ADDRESS = 500;
export const MAX_NAME = 100;
export const MAX_DETAILS = 1000;

export const SosLocation = Type.Object(
  {
    lat: Type.Number({ description: 'Latitude in degrees, -90 to 90.' }),
    lon: Type.Number({ description: 'Longitude in degrees, -180 to 180.' }),
    accuracyM: Type.Optional(Type.Number({ description: 'Horizontal accuracy in metres.' })),
    capturedAt: Type.String({
      format: 'date-time',
      description: 'When the fix was taken (RFC 3339). At most 10 minutes old and not in the future.',
    }),
    source: Type.Union([Type.Literal('gps'), Type.Literal('network'), Type.Literal('last_known')]),
  },
  {
    additionalProperties: false,
    description:
      'A location that is out of range, 0,0, stale or in the future is dropped when an address is given, and is a 400 otherwise.',
  },
);

export const SosBody = Type.Object(
  {
    intakeCode: Type.String({ minLength: 1, maxLength: 64 }),
    nature: Type.String({ minLength: 1, maxLength: 40, description: "One of the intake's nature ids." }),
    phone: Type.String({
      pattern: '^\\+[1-9][0-9]{1,14}$',
      description: 'Callback number in E.164, valid per libphonenumber-js.',
    }),
    location: Type.Optional(SosLocation),
    address: Type.Optional(
      Type.String({
        description: `Up to ${MAX_ADDRESS} characters after sanitising. Required when there is no usable location.`,
      }),
    ),
    name: Type.Optional(Type.String({ description: `Up to ${MAX_NAME} characters after sanitising.` })),
    details: Type.Optional(Type.String({ description: `Up to ${MAX_DETAILS} characters after sanitising.` })),
  },
  { additionalProperties: false },
);
export type SosBody = Static<typeof SosBody>;

export const SosHeaders = Type.Object({
  'idempotency-key': Type.String({
    pattern: UUID_PATTERN,
    description: 'UUID. One per SOS, reused on every retry of it.',
  }),
  'x-attestation': Type.Optional(
    Type.String({
      maxLength: 16384,
      description: 'Fresh per attempt. See docs/attestation-contract.md.',
    }),
  ),
});
export type SosHeaders = Static<typeof SosHeaders>;

export const SubmissionStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('received'),
  Type.Literal('dispatched'),
  Type.Literal('closed'),
  Type.Literal('failed'),
]);

const receiptFields = {
  receiptId: Type.String({ description: '`sos_` + ULID.' }),
  statusToken: Type.String({ description: 'Send as `X-Status-Token` to the status endpoint.' }),
  reference: Type.String({ description: '`SOS-` + 4 characters.' }),
  status: SubmissionStatusSchema,
  submittedAt: Type.String({ format: 'date-time' }),
};

export const SosReceipt = Type.Object(receiptFields);
export type SosReceipt = Static<typeof SosReceipt>;

export const ErrorObject = Type.Object({
  code: Type.String(),
  message: Type.String(),
  retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});

const errorResponse = (description: string) => Type.Object({ error: ErrorObject }, { description });

export const SosResponses = {
  201: Type.Object(receiptFields, {
    description:
      'Core created the pending call (`received`), Core rejected it for good (`failed`), or a replay of an SOS that is no longer queued. ' +
      'A replay of an SOS that was answered 503 after it was saved returns `failed`.',
  }),
  202: Type.Object(receiptFields, {
    description:
      'Saved; delivery is being retried (`queued`) after a timeout, network error, 409, 429 or 5xx from Core. Also a replay of an SOS still queued.',
  }),
  400: errorResponse('Headers or body not valid. Do not retry.'),
  401: errorResponse('Device token missing, invalid or expired. Re-register, then retry with the same key.'),
  403: errorResponse('Not allowed. No reason is given.'),
  404: errorResponse('Unknown intake.'),
  409: Type.Object(
    { error: ErrorObject, ...receiptFields },
    { description: 'An SOS from this device is already open; its receipt and status token are returned.' },
  ),
  410: errorResponse('Intake disabled.'),
  429: errorResponse('Rate limited. `Retry-After` matches `retryAfterSeconds`.'),
  503: errorResponse(
    'Cannot take an SOS right now: delivery is paused or the relay cannot verify its Core configuration (code `unavailable`), ' +
      'or the whole-intake breaker tripped (code `intake_busy`). Nothing will be delivered: the SOS was either not saved, or saved ' +
      "and marked failed because Core refused the relay's API key during this request. Show the emergency phone number; do not " +
      'auto-retry. `Retry-After` matches `retryAfterSeconds`.',
  ),
};
