/**
 * The auth plugin: its error handler, the contract's body rules and its mounting switch.
 *
 * The four route modules are stubs that register nothing yet, so this file replaces them with
 * test-only routes (vi.mock). The real buildPublicApp, plugin and error handler run around them.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { closeTestDb, createTestContext, resetDb, testConfig } from '../helpers/context.js';

vi.mock('../../src/auth/routes/signup.js', async () => {
  const { validateSignup } = await import('../../src/auth/validate.js');
  return {
    signupRoutes: async (app: FastifyInstance) => {
      app.post('/v1/auth/signup', async (req, reply) => reply.status(201).send(validateSignup(req.body)));
      // A body schema is documentation only inside the auth plugin: nothing validates it.
      app.post(
        '/v1/auth/_documented',
        {
          schema: {
            tags: ['auth'],
            summary: 'test',
            security: [{ accessToken: [] }],
            body: Type.Object({ a: Type.String() }, { additionalProperties: false }),
          },
        },
        async (req) => ({ got: req.body }),
      );
    },
  };
});

vi.mock('../../src/auth/routes/refresh.js', async () => {
  const { validateRefreshBody } = await import('../../src/auth/validate.js');
  const { authErrors } = await import('../../src/auth/errors.js');
  return {
    refreshRoutes: async (app: FastifyInstance) => {
      app.post('/v1/auth/refresh', async (req) => validateRefreshBody(req.body));
      app.get('/v1/auth/_throw/:name', async (req) => {
        const { name } = req.params as { name: string };
        const make: Record<string, () => Error> = {
          email_taken: () => authErrors.emailTaken(),
          phone_taken: () => authErrors.phoneTaken(),
          idempotency_key_reused: () => authErrors.idempotencyKeyReused(),
          invalid_refresh_token: () => authErrors.invalidRefreshToken(),
          session_revoked: () => authErrors.sessionRevoked(),
          token_expired: () => authErrors.tokenExpired(),
          invalid_token: () => authErrors.invalidToken(),
          rate_limited: () => authErrors.rateLimited(42),
          unavailable_known: () => authErrors.unavailable(17),
          unavailable_unknown: () => authErrors.unavailable(),
          internal_error: () => authErrors.internalError(),
          boom: () => new Error('SECRET row detail: ada@example.com'),
          db: () => Object.assign(new Error('duplicate key value (ada@example.com)'), { code: '23505' }),
          teapot: () => Object.assign(new Error('x'), { statusCode: 418 }),
        };
        throw (make[name] ?? (() => new Error('unknown test route')))();
      });
    },
  };
});

vi.mock('../../src/auth/routes/signout.js', async () => {
  const { validateSignoutBody } = await import('../../src/auth/validate.js');
  return {
    signoutRoutes: async (app: FastifyInstance) => {
      app.post('/v1/auth/signout', async (req) => validateSignoutBody(req.body));
    },
  };
});

vi.mock('../../src/auth/routes/me.js', () => ({ meRoutes: async () => {} }));

const AUTH_ON = { enabled: true, tokenSecret: 'auth-token-secret-for-tests-0123456789ab' };

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

const open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function setup(opts: { auth?: boolean; perIp?: number } = {}) {
  const base = testConfig();
  const config = {
    ...base,
    auth: opts.auth === false ? { ...base.auth, enabled: false } : AUTH_ON,
    limits: { ...base.limits, ...(opts.perIp === undefined ? {} : { requestsPerIpPerMinute: opts.perIp }) },
  };
  const ctx = createTestContext({ config });
  const app = await buildPublicApp(ctx);
  open.push(app);
  return { ctx, app };
}

const validBody = () => ({
  fullName: 'Ada Okafor',
  phone: '+2348031234567',
  email: 'ADA@example.com',
  password: 'correct horse battery staple',
  device: { platform: 'ios', appVersion: '0.3.0', installId: '5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b' },
});

/** A JSON object of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const prefix = '{"a":"';
  const suffix = '"}';
  return `${prefix}${'x'.repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

const post = (
  app: FastifyInstance,
  url: string,
  payload: string | object,
  contentType = 'application/json',
) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': contentType },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

describe('auth disabled (the default)', () => {
  it.each([
    ['POST', '/v1/auth/signup'],
    ['POST', '/v1/auth/refresh'],
    ['POST', '/v1/auth/signout'],
    ['GET', '/v1/auth/anything'],
  ])('%s %s is the relay 404', async (method, url) => {
    const { app } = await setup({ auth: false });
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('keeps the relay error handling for the SOS routes', async () => {
    const { app } = await setup({ auth: false });
    const res = await post(app, '/v1/devices/register', '{');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });
});

describe('auth enabled', () => {
  it('serves the routes the plugin mounts, with the contract content type', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/signup', validBody());
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.json().email).toBe('ada@example.com');
  });

  it('answers an unknown /v1/auth path with the relay 404 (not an auth code)', async () => {
    const { app } = await setup();
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: '/v1/auth/nope',
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });

  it('keeps the relay error body on the SOS routes outside the plugin', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/devices/register', '{');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('does not run Fastify body schema validation on its routes', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/_documented', { a: 5, extra: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ got: { a: 5, extra: true } });
  });

  it('documents its routes in OpenAPI under the auth tag with the accessToken bearer scheme', async () => {
    const { app } = await setup();
    await app.ready();
    const doc = app.swagger() as {
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    const op = doc.paths['/v1/auth/_documented']?.post;
    expect(op?.tags).toEqual(['auth']);
    expect(op?.security).toEqual([{ accessToken: [] }]);
    expect(doc.components.securitySchemes).toMatchObject({
      deviceToken: { type: 'http', scheme: 'bearer' },
      accessToken: { type: 'http', scheme: 'bearer' },
    });
  });
});

describe('auth enabled: malformed requests', () => {
  it.each([
    ['invalid JSON', '{', 'application/json'],
    ['truncated JSON', '{"fullName":"Ada"', 'application/json'],
    ['JSON that is not an object', '[1,2]', 'application/json'],
    ['the JSON value null', 'null', 'application/json'],
    ['an empty body', '', 'application/json'],
    ['a text/plain body', 'hello', 'text/plain'],
    ['a form body', 'a=1', 'application/x-www-form-urlencoded'],
  ])('%s → 400 malformed_request', async (_name, payload, contentType) => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/signup', payload, contentType);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
    expect(res.json().error).not.toHaveProperty('fields');
  });

  it('a POST with no body and no content type → 400 malformed_request', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/signup' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
  });

  it('a wrong JSON type for a field → 400 malformed_request', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/signup', { ...validBody(), phone: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
  });
});

describe('auth enabled: validation_failed over HTTP', () => {
  it('lists every invalid field in the contract body', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/signup', {
      ...validBody(),
      phone: '0803',
      password: 'short',
      role: 'admin',
      device: { platform: 'beos', appVersion: '1', installId: 'x', os: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: expect.any(String),
        fields: [
          { field: 'phone', code: 'invalid_phone' },
          { field: 'password', code: 'too_short' },
          { field: 'device.platform', code: 'invalid_value' },
          { field: 'device.installId', code: 'invalid_value' },
          { field: 'role', code: 'invalid_value' },
          { field: 'device.os', code: 'invalid_value' },
        ],
      },
    });
  });

  it('refresh and signout: a missing refreshToken is validation_failed', async () => {
    const { app } = await setup();
    for (const url of ['/v1/auth/refresh', '/v1/auth/signout']) {
      const res = await post(app, url, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({
        code: 'validation_failed',
        message: expect.any(String),
        fields: [{ field: 'refreshToken', code: 'required' }],
      });
    }
  });
});

describe('auth enabled: body size', () => {
  it('16 385 bytes → 413 payload_too_large', async () => {
    const { app } = await setup();
    const body = jsonOfSize(16_385);
    expect(Buffer.byteLength(body)).toBe(16_385);
    const res = await post(app, '/v1/auth/signup', body);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: 'payload_too_large', message: expect.any(String) } });
  });

  it('16 384 bytes is still read (and here fails validation for its unknown field)', async () => {
    const { app } = await setup();
    const body = jsonOfSize(16_384);
    expect(Buffer.byteLength(body)).toBe(16_384);
    const res = await post(app, '/v1/auth/signup', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('a larger body is refused before parsing, even when it is not JSON', async () => {
    const { app } = await setup();
    const res = await post(app, '/v1/auth/signup', 'x'.repeat(20_000));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });
});

describe('auth enabled: the plugin error handler', () => {
  it.each([
    ['email_taken', 409],
    ['phone_taken', 409],
    ['idempotency_key_reused', 422],
    ['invalid_refresh_token', 401],
    ['session_revoked', 401],
    ['token_expired', 401],
    ['invalid_token', 401],
    ['internal_error', 500],
  ])('maps AuthError %s to %i with the contract body', async (code, status) => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/v1/auth/_throw/${code}` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('429 carries retryAfterSeconds and Retry-After', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/_throw/rate_limited' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toEqual({
      code: 'rate_limited',
      message: expect.any(String),
      retryAfterSeconds: 42,
    });
    expect(res.headers['retry-after']).toBe('42');
  });

  it('503 carries retryAfterSeconds and Retry-After when known, neither when not', async () => {
    const { app } = await setup();
    const known = await app.inject({ method: 'GET', url: '/v1/auth/_throw/unavailable_known' });
    expect(known.statusCode).toBe(503);
    expect(known.json().error).toEqual({
      code: 'unavailable',
      message: expect.any(String),
      retryAfterSeconds: 17,
    });
    expect(known.headers['retry-after']).toBe('17');

    const unknown = await app.inject({ method: 'GET', url: '/v1/auth/_throw/unavailable_unknown' });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error).toEqual({ code: 'unavailable', message: expect.any(String) });
    expect(unknown.headers['retry-after']).toBeUndefined();
  });

  it.each(['boom', 'db'])(
    'an unexpected error (%s) is a generic 500 internal_error that leaks nothing',
    async (name) => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: `/v1/auth/_throw/${name}` });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'internal_error', message: expect.any(String) } });
      expect(res.body).not.toContain('ada@example.com');
      expect(res.body).not.toContain('SECRET');
    },
  );

  it('any other client error from Fastify is a 400 malformed_request', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/_throw/teapot' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('malformed_request');
  });

  it('the relay per-IP limiter answers inside the plugin with the auth rate_limited body', async () => {
    const { app } = await setup({ perIp: 2 });
    const headers = { 'x-real-ip': '203.0.113.9' };
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/_throw/token_expired', headers })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/_throw/token_expired', headers })).statusCode,
    ).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/v1/auth/_throw/token_expired', headers });
    expect(res.statusCode).toBe(429);
    const error = res.json().error;
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(error.retryAfterSeconds)).toBe(true);
    expect(res.headers['retry-after']).toBe(String(error.retryAfterSeconds));
  });
});
