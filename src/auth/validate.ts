/**
 * Hand-written request validators for the auth endpoints (docs/auth-contract.md §1, §4).
 *
 * Why not Fastify schemas: the contract wants EVERY invalid field in one answer, with its own field
 * codes, while the relay's AJV setup stops at the first error and answers with the relay's codes.
 *
 * Rules, where the contract leaves room:
 * - The body is not an object, or a field has the wrong JSON type → `malformed_request`. That wins over
 *   any field error found elsewhere in the same body. Contract §4.3 is the exception: a `refreshToken`
 *   that is "missing or not a string" is `validation_failed` (`required` / `invalid_value`), and refresh
 *   follows the same rule.
 * - `required` means the key is absent. A present but empty string is judged by its own rule:
 *   `too_short` for fullName and password, `invalid_phone`, `invalid_email`, `invalid_value`.
 * - UNKNOWN FIELDS (contract §1: `400 validation_failed`) are listed as `{ field: <name>, code:
 *   'invalid_value' }`, nested ones as `device.<name>`. The contract has no `unknown_field` code, and
 *   `invalid_value` is the generic "this is not an accepted value" code. At most MAX_UNKNOWN_FIELDS are
 *   listed and each name is cut to MAX_UNKNOWN_NAME characters, so a hostile body cannot make the
 *   response grow with it.
 * - Fields are listed in the contract's order, then unknown fields in the order they were sent.
 * - Lengths count characters (Unicode code points), not UTF-16 units or bytes.
 * - A body is read with own-property checks only, so `__proto__` or inherited names are never fields.
 */
import { UUID_PATTERN } from '../ids.js';
import { authErrors, type FieldError, type FieldErrorCode } from './errors.js';

/** Unicode control characters (Cc), NUL included. */
const CONTROL = /\p{Cc}/u;

export interface SignupInput {
  /** Trimmed. */
  fullName: string;
  phone: string;
  /** Trimmed and lowercased. */
  email: string;
  /** As sent: never trimmed. */
  password: string;
  device: { platform: 'ios' | 'android'; appVersion: string; installId: string };
}

export interface RefreshBody {
  refreshToken: string;
}

const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const UUID = new RegExp(UUID_PATTERN);
const MAX_EMAIL = 254;
const MAX_UNKNOWN_FIELDS = 16;
const MAX_UNKNOWN_NAME = 64;

type Obj = Record<string, unknown>;

/** The length in characters (code points). */
function length(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const has = (o: Obj, key: string): boolean => Object.hasOwn(o, key);

/** Collects the field errors of one body. */
class Collector {
  readonly fields: FieldError[] = [];
  private unknown = 0;

  add(field: string, code: FieldErrorCode): void {
    this.fields.push({ field, code });
  }

  /** Unknown fields go last, so they are added after every known one. */
  unknownFields(o: Obj, known: readonly string[], prefix: string): void {
    for (const key of Object.keys(o)) {
      if (known.includes(key)) continue;
      if (this.unknown++ >= MAX_UNKNOWN_FIELDS) continue;
      this.add(`${prefix}${[...key].slice(0, MAX_UNKNOWN_NAME).join('')}`, 'invalid_value');
    }
  }

  fail(): never {
    throw authErrors.validationFailed(this.fields);
  }
}

/** The string at `key`, or undefined when the key is absent. Another JSON type → malformed_request. */
function readString(o: Obj, key: string): string | undefined {
  if (!has(o, key)) return undefined;
  const v = o[key];
  if (typeof v !== 'string') throw authErrors.malformedRequest();
  return v;
}

/** Adds `required` for an absent value, else the code of the first rule the value breaks (if any). */
function check(
  c: Collector,
  field: string,
  value: string | undefined,
  rule: (v: string) => FieldErrorCode | undefined,
): void {
  if (value === undefined) c.add(field, 'required');
  else {
    const code = rule(value);
    if (code) c.add(field, code);
  }
}

function textLength(min: number, max: number): (s: string) => FieldErrorCode | undefined {
  return (s) => {
    const n = length(s);
    if (n < min) return 'too_short';
    if (n > max) return 'too_long';
    return undefined;
  };
}

function validEmail(email: string): boolean {
  if (/[\s\p{Cc}]/u.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return false;
  return domain.split('.').every((label) => label.length > 0);
}

const SIGNUP_FIELDS = ['fullName', 'phone', 'email', 'password', 'device'] as const;
const DEVICE_FIELDS = ['platform', 'appVersion', 'installId'] as const;

/**
 * Validates a sign-up body and returns it normalised, or throws an AuthError:
 * `malformed_request`, or `validation_failed` listing every invalid field.
 */
export function validateSignup(body: unknown): SignupInput {
  if (!isObject(body)) throw authErrors.malformedRequest();

  // Pass 1: JSON types. Throws malformed_request, which wins over any field error.
  const fullName = readString(body, 'fullName')?.trim();
  const phone = readString(body, 'phone');
  const email = readString(body, 'email')?.trim().toLowerCase();
  const password = readString(body, 'password');
  let device: Obj | undefined;
  if (has(body, 'device')) {
    if (!isObject(body.device)) throw authErrors.malformedRequest();
    device = body.device;
  }
  const platform = device && readString(device, 'platform');
  const appVersion = device && readString(device, 'appVersion');
  const installId = device && readString(device, 'installId');

  // Pass 2: the field rules, in the contract's order.
  const c = new Collector();
  // Control characters (NUL above all) cannot be stored in Postgres text and are never a real name.
  check(c, 'fullName', fullName, (v) => (CONTROL.test(v) ? 'invalid_value' : textLength(1, 100)(v)));
  check(c, 'phone', phone, (v) => (PHONE_PATTERN.test(v) ? undefined : 'invalid_phone'));
  check(c, 'email', email, (v) =>
    length(v) > MAX_EMAIL ? 'too_long' : validEmail(v) ? undefined : 'invalid_email',
  );
  check(c, 'password', password, textLength(8, 128));
  if (device === undefined) c.add('device', 'required');
  else {
    check(c, 'device.platform', platform, (v) =>
      v === 'ios' || v === 'android' ? undefined : 'invalid_value',
    );
    check(c, 'device.appVersion', appVersion, (v) =>
      CONTROL.test(v) ? 'invalid_value' : length(v) <= 32 ? undefined : 'too_long',
    );
    check(c, 'device.installId', installId, (v) => (UUID.test(v) ? undefined : 'invalid_value'));
  }
  c.unknownFields(body, SIGNUP_FIELDS, '');
  if (device) c.unknownFields(device, DEVICE_FIELDS, 'device.');
  if (c.fields.length > 0) c.fail();

  return {
    fullName: fullName as string,
    phone: phone as string,
    email: email as string,
    password: password as string,
    device: {
      platform: platform as 'ios' | 'android',
      appVersion: appVersion as string,
      installId: installId as string,
    },
  };
}

/** `{ refreshToken: string }`, for refresh and sign-out. An empty string is left to the endpoint. */
function validateTokenBody(body: unknown): RefreshBody {
  if (!isObject(body)) throw authErrors.malformedRequest();
  const c = new Collector();
  const token = body.refreshToken;
  if (!has(body, 'refreshToken')) c.add('refreshToken', 'required');
  else if (typeof token !== 'string') c.add('refreshToken', 'invalid_value');
  c.unknownFields(body, ['refreshToken'], '');
  if (c.fields.length > 0) c.fail();
  return { refreshToken: token as string };
}

export function validateRefreshBody(body: unknown): RefreshBody {
  return validateTokenBody(body);
}

export function validateSignoutBody(body: unknown): RefreshBody {
  return validateTokenBody(body);
}
