import { describe, expect, it } from 'vitest';
import { AuthError, type FieldError } from '../../src/auth/errors.js';
import { validateRefreshBody, validateSignoutBody, validateSignup } from '../../src/auth/validate.js';

const INSTALL_ID = '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b';

function valid(): Record<string, unknown> {
  return {
    fullName: 'Ada Okafor',
    phone: '+2348031234567',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
    device: { platform: 'android', appVersion: '0.3.0', installId: INSTALL_ID },
  };
}

/** A valid body with one change applied. `undefined` deletes the key. */
function withChange(path: string, value: unknown): Record<string, unknown> {
  const body = valid();
  const parts = path.split('.');
  let target = body as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) target = target[p] as Record<string, unknown>;
  const last = parts.at(-1) as string;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return body;
}

function caught(fn: () => unknown): AuthError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    return err as AuthError;
  }
  throw new Error('expected an AuthError, nothing was thrown');
}

function fieldsOf(body: unknown): FieldError[] {
  const err = caught(() => validateSignup(body));
  expect(err.status).toBe(400);
  expect(err.code).toBe('validation_failed');
  return err.fields ?? [];
}

const chars = (n: number, c = 'a') => c.repeat(n);

describe('validateSignup: a valid body', () => {
  it('is accepted and normalised: fullName trimmed, email trimmed and lowercased', () => {
    const body = withChange('fullName', '  Ada Okafor \n');
    body.email = '  ADA@Example.COM ';
    expect(validateSignup(body)).toEqual({
      fullName: 'Ada Okafor',
      phone: '+2348031234567',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
      device: { platform: 'android', appVersion: '0.3.0', installId: INSTALL_ID },
    });
  });

  it('keeps the password and the phone number exactly as sent', () => {
    const body = withChange('password', '  spaces are part of it  ');
    expect(validateSignup(body).password).toBe('  spaces are part of it  ');
  });

  it.each([
    ['ios platform', 'device.platform', 'ios'],
    ['an upper-case installId', 'device.installId', INSTALL_ID.toUpperCase()],
    ['a UUID v1 installId', 'device.installId', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['a 7-digit phone', 'phone', '+1234567'],
    ['a 15-digit phone', 'phone', '+123456789012345'],
    ['a 1-character name', 'fullName', 'A'],
    ['a 100-character name', 'fullName', chars(100)],
    ['a 100-character name padded with spaces', 'fullName', ` ${chars(100)} `],
    ['100 emoji as the name (200 UTF-16 units)', 'fullName', '😀'.repeat(100)],
    ['an 8-character password', 'password', chars(8)],
    ['a 128-character password', 'password', chars(128)],
    ['128 emoji as the password', 'password', '😀'.repeat(128)],
    ['a 254-character email', 'email', `${chars(242)}@example.com`],
    ['a 32-character appVersion', 'device.appVersion', chars(32)],
    ['an empty appVersion (the contract sets only a maximum)', 'device.appVersion', ''],
  ])('accepts %s', (_name, path, value) => {
    expect(() => validateSignup(withChange(path, value))).not.toThrow();
  });
});

describe('validateSignup: one error code per field', () => {
  const cases: [string, string, unknown, FieldError][] = [
    // required: the key is absent
    ['fullName', 'fullName', undefined, { field: 'fullName', code: 'required' }],
    ['phone', 'phone', undefined, { field: 'phone', code: 'required' }],
    ['email', 'email', undefined, { field: 'email', code: 'required' }],
    ['password', 'password', undefined, { field: 'password', code: 'required' }],
    ['device', 'device', undefined, { field: 'device', code: 'required' }],
    ['device.platform', 'device.platform', undefined, { field: 'device.platform', code: 'required' }],
    ['device.appVersion', 'device.appVersion', undefined, { field: 'device.appVersion', code: 'required' }],
    ['device.installId', 'device.installId', undefined, { field: 'device.installId', code: 'required' }],
    // too_short
    ['fullName empty', 'fullName', '', { field: 'fullName', code: 'too_short' }],
    ['fullName blank', 'fullName', ' \t\n ', { field: 'fullName', code: 'too_short' }],
    ['password empty', 'password', '', { field: 'password', code: 'too_short' }],
    ['password of 7', 'password', chars(7), { field: 'password', code: 'too_short' }],
    ['password of 7 emoji', 'password', '😀'.repeat(7), { field: 'password', code: 'too_short' }],
    // too_long
    ['fullName of 101', 'fullName', chars(101), { field: 'fullName', code: 'too_long' }],
    ['fullName of 101 emoji', 'fullName', '😀'.repeat(101), { field: 'fullName', code: 'too_long' }],
    ['password of 129', 'password', chars(129), { field: 'password', code: 'too_long' }],
    ['password of 129 emoji', 'password', '😀'.repeat(129), { field: 'password', code: 'too_long' }],
    ['email of 255', 'email', `${chars(243)}@example.com`, { field: 'email', code: 'too_long' }],
    ['appVersion of 33', 'device.appVersion', chars(33), { field: 'device.appVersion', code: 'too_long' }],
    // invalid_phone
    ['phone empty', 'phone', '', { field: 'phone', code: 'invalid_phone' }],
    ['phone without +', 'phone', '2348031234567', { field: 'phone', code: 'invalid_phone' }],
    ['phone starting 0', 'phone', '+0348031234567', { field: 'phone', code: 'invalid_phone' }],
    ['phone of 6 digits', 'phone', '+123456', { field: 'phone', code: 'invalid_phone' }],
    ['phone of 16 digits', 'phone', '+1234567890123456', { field: 'phone', code: 'invalid_phone' }],
    ['phone with spaces', 'phone', '+234 803 123 4567', { field: 'phone', code: 'invalid_phone' }],
    ['phone with dashes', 'phone', '+234-803-123-4567', { field: 'phone', code: 'invalid_phone' }],
    ['phone with letters', 'phone', '+23480312345a7', { field: 'phone', code: 'invalid_phone' }],
    ['phone with a trailing newline', 'phone', '+2348031234567\n', { field: 'phone', code: 'invalid_phone' }],
    ['phone with Arabic-Indic digits', 'phone', '+٢٣٤٨٠٣١٢٣٤٥٦٧', { field: 'phone', code: 'invalid_phone' }],
    // invalid_email
    ['email empty', 'email', '', { field: 'email', code: 'invalid_email' }],
    ['email blank', 'email', '   ', { field: 'email', code: 'invalid_email' }],
    ['email without @', 'email', 'ada.example.com', { field: 'email', code: 'invalid_email' }],
    ['email with two @', 'email', 'ada@@example.com', { field: 'email', code: 'invalid_email' }],
    ['email with two @ apart', 'email', 'a@b@example.com', { field: 'email', code: 'invalid_email' }],
    ['email without local part', 'email', '@example.com', { field: 'email', code: 'invalid_email' }],
    ['email without domain', 'email', 'ada@', { field: 'email', code: 'invalid_email' }],
    ['email domain without a dot', 'email', 'ada@example', { field: 'email', code: 'invalid_email' }],
    [
      'email domain starting with a dot',
      'email',
      'ada@.example.com',
      { field: 'email', code: 'invalid_email' },
    ],
    [
      'email domain ending with a dot',
      'email',
      'ada@example.com.',
      { field: 'email', code: 'invalid_email' },
    ],
    [
      'email domain with an empty label',
      'email',
      'ada@example..com',
      { field: 'email', code: 'invalid_email' },
    ],
    [
      'email with a space inside',
      'email',
      'ada okafor@example.com',
      { field: 'email', code: 'invalid_email' },
    ],
    ['email with a tab inside', 'email', 'ada@exa\tmple.com', { field: 'email', code: 'invalid_email' }],
    // invalid_value
    ['platform unknown', 'device.platform', 'windows', { field: 'device.platform', code: 'invalid_value' }],
    ['platform wrong case', 'device.platform', 'iOS', { field: 'device.platform', code: 'invalid_value' }],
    ['platform empty', 'device.platform', '', { field: 'device.platform', code: 'invalid_value' }],
    [
      'installId not a UUID',
      'device.installId',
      'not-a-uuid',
      { field: 'device.installId', code: 'invalid_value' },
    ],
    ['installId empty', 'device.installId', '', { field: 'device.installId', code: 'invalid_value' }],
    [
      'installId with a trailing newline',
      'device.installId',
      `${INSTALL_ID}\n`,
      { field: 'device.installId', code: 'invalid_value' },
    ],
    [
      'installId without dashes',
      'device.installId',
      INSTALL_ID.replaceAll('-', ''),
      { field: 'device.installId', code: 'invalid_value' },
    ],
  ];

  it.each(cases)('%s', (_name, path, value, expected) => {
    expect(fieldsOf(withChange(path, value))).toEqual([expected]);
  });
});

describe('validateSignup: several invalid fields', () => {
  it('reports every one, in the contract order', () => {
    const body = {
      fullName: ' ',
      phone: '0803',
      email: 'nope',
      password: 'short',
      device: { platform: 'beos', appVersion: chars(40), installId: 'x' },
    };
    expect(fieldsOf(body)).toEqual([
      { field: 'fullName', code: 'too_short' },
      { field: 'phone', code: 'invalid_phone' },
      { field: 'email', code: 'invalid_email' },
      { field: 'password', code: 'too_short' },
      { field: 'device.platform', code: 'invalid_value' },
      { field: 'device.appVersion', code: 'too_long' },
      { field: 'device.installId', code: 'invalid_value' },
    ]);
  });

  it('reports a body of only {} as every field required, with device as one entry', () => {
    expect(fieldsOf({})).toEqual([
      { field: 'fullName', code: 'required' },
      { field: 'phone', code: 'required' },
      { field: 'email', code: 'required' },
      { field: 'password', code: 'required' },
      { field: 'device', code: 'required' },
    ]);
  });

  it('reports an empty device object as its three fields required', () => {
    expect(fieldsOf({ ...valid(), device: {} })).toEqual([
      { field: 'device.platform', code: 'required' },
      { field: 'device.appVersion', code: 'required' },
      { field: 'device.installId', code: 'required' },
    ]);
  });

  it('mixes required, a bad value and a nested error', () => {
    const body = withChange('phone', undefined);
    body.email = 'bad';
    (body.device as Record<string, unknown>).installId = 'bad';
    expect(fieldsOf(body)).toEqual([
      { field: 'phone', code: 'required' },
      { field: 'email', code: 'invalid_email' },
      { field: 'device.installId', code: 'invalid_value' },
    ]);
  });
});

describe('validateSignup: unknown fields (code: invalid_value)', () => {
  it('refuses an unknown top-level field', () => {
    expect(fieldsOf({ ...valid(), role: 'admin' })).toEqual([{ field: 'role', code: 'invalid_value' }]);
  });

  it('refuses an unknown field inside device, named with the device. prefix', () => {
    const body = valid();
    (body.device as Record<string, unknown>).os = '17';
    expect(fieldsOf(body)).toEqual([{ field: 'device.os', code: 'invalid_value' }]);
  });

  it('lists unknown fields together with the other invalid fields', () => {
    const body = withChange('phone', 'x');
    body.extra = 1;
    (body.device as Record<string, unknown>).os = 1;
    expect(fieldsOf(body)).toEqual([
      { field: 'phone', code: 'invalid_phone' },
      { field: 'extra', code: 'invalid_value' },
      { field: 'device.os', code: 'invalid_value' },
    ]);
  });

  it('refuses a field the other endpoints use', () => {
    expect(fieldsOf({ ...valid(), refreshToken: 'rt_x' })).toEqual([
      { field: 'refreshToken', code: 'invalid_value' },
    ]);
  });

  it('reports an own "__proto__" key from the JSON parser', () => {
    const body = JSON.parse(
      `{"__proto__":{"admin":true},"fullName":"Ada","phone":"+2348031234567","email":"a@b.co","password":"12345678","device":{"platform":"ios","appVersion":"1","installId":"${INSTALL_ID}"}}`,
    );
    expect(fieldsOf(body)).toEqual([{ field: '__proto__', code: 'invalid_value' }]);
  });

  it('does not read inherited properties as present fields', () => {
    const body = Object.create({ fullName: 'Ada' }) as Record<string, unknown>;
    expect(fieldsOf(body)).toContainEqual({ field: 'fullName', code: 'required' });
  });

  it('truncates a long unknown field name and caps the number of unknown fields echoed', () => {
    const body = valid();
    body[chars(500)] = 1;
    for (let i = 0; i < 100; i++) body[`extra${i}`] = i;
    const fields = fieldsOf(body);
    expect(fields.every((f) => f.code === 'invalid_value')).toBe(true);
    expect(fields.length).toBe(16);
    expect(fields[0]?.field).toBe(chars(64));
  });
});

describe('validateSignup: malformed_request', () => {
  const malformed = (body: unknown) => {
    const err = caught(() => validateSignup(body));
    expect(err.status).toBe(400);
    expect(err.code).toBe('malformed_request');
    expect(err.fields).toBeUndefined();
  };

  it.each([
    ['undefined (no body)', undefined],
    ['null', null],
    ['an array', [valid()]],
    ['a string', 'ada'],
    ['a number', 5],
    ['a boolean', true],
  ])('a body that is %s', (_name, body) => malformed(body));

  it.each([
    ['fullName: number', 'fullName', 5],
    ['fullName: null', 'fullName', null],
    ['phone: number', 'phone', 2348031234567],
    ['email: array', 'email', ['ada@example.com']],
    ['password: object', 'password', { a: 1 }],
    ['password: boolean', 'password', true],
    ['device: string', 'device', 'android'],
    ['device: null', 'device', null],
    ['device: array', 'device', []],
    ['device.platform: number', 'device.platform', 1],
    ['device.appVersion: number', 'device.appVersion', 3],
    ['device.installId: object', 'device.installId', {}],
  ])('a wrong JSON type: %s', (_name, path, value) => malformed(withChange(path, value)));

  it('wins over validation errors elsewhere in the same body', () => {
    const body = withChange('fullName', 5);
    body.phone = 'bad';
    malformed(body);
  });
});

describe.each([
  ['validateRefreshBody', validateRefreshBody],
  ['validateSignoutBody', validateSignoutBody],
])('%s', (_name, validate) => {
  const failure = (body: unknown) => caught(() => validate(body));

  it('accepts { refreshToken: string } and returns it as sent', () => {
    expect(validate({ refreshToken: 'rt_abc' })).toEqual({ refreshToken: 'rt_abc' });
  });

  it('reports a missing refreshToken as required', () => {
    const err = failure({});
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toEqual([{ field: 'refreshToken', code: 'required' }]);
  });

  it.each([
    ['a number', 5],
    ['null', null],
    ['an object', {}],
    ['an array', ['rt_a']],
    ['a boolean', false],
  ])('reports a refreshToken that is %s as invalid_value (the contract: "not a string")', (_n, value) => {
    const err = failure({ refreshToken: value });
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toEqual([{ field: 'refreshToken', code: 'invalid_value' }]);
  });

  it('refuses an unknown field', () => {
    const err = failure({ refreshToken: 'rt_a', device: {} });
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toEqual([{ field: 'device', code: 'invalid_value' }]);
  });

  it('lists a missing refreshToken and an unknown field together', () => {
    expect(failure({ token: 'x' }).fields).toEqual([
      { field: 'refreshToken', code: 'required' },
      { field: 'token', code: 'invalid_value' },
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'rt_abc'],
  ])('a body that is %s is malformed_request', (_n, body) => {
    const err = failure(body);
    expect(err.status).toBe(400);
    expect(err.code).toBe('malformed_request');
  });

  it('leaves an empty string to the endpoint, which answers it like any unknown token', () => {
    expect(validate({ refreshToken: '' })).toEqual({ refreshToken: '' });
  });
});

describe('validateSignup: control characters (Postgres text cannot hold NUL)', () => {
  it.each([
    ['fullName', 'Ada\u0000'],
    ['fullName', 'Ada\u0007Okafor'],
    ['device.appVersion', '0.3.0\u0000'],
  ])('%s with a control character is invalid_value', (field, value) => {
    expect(fieldsOf(withChange(field, value))).toEqual([{ field, code: 'invalid_value' }]);
  });
});
