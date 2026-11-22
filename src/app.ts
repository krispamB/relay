import fastifySwagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { sql } from 'kysely';
import { authPlugin } from './auth/plugin.js';
import { MINUTE } from './clock.js';
import type { AppContext } from './context.js';
import { ApiError, errors, safeError } from './errors.js';
import { METRICS } from './metrics.js';
import { devicesRoutes } from './routes/devices.js';
import { intakeRoutes } from './routes/intake.js';
import { sosRoutes } from './routes/sos.js';
import { statusRoutes } from './routes/status.js';

export type PublicApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact bytes of a JSON request body, for the attestation binding hash (PRD §7.4). */
    rawBody?: Buffer;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: accepts any Fastify instance regardless of type provider
type AnyApp = FastifyInstance<any, any, any, any, any>;

/** The caller's address: the configured edge header when set, else the socket address. */
export function clientIp(req: FastifyRequest, header: string | undefined): string {
  if (header) {
    const v = req.headers[header];
    const first = Array.isArray(v) ? v[0] : v;
    if (first && first.trim() !== '') return first.split(',')[0]!.trim();
  }
  return req.ip;
}

/** Shared Fastify options: reject unknown body fields instead of silently stripping them. */
export const AJV_OPTIONS = {
  customOptions: {
    removeAdditional: false as const,
    coerceTypes: false as const,
    useDefaults: false,
    allErrors: false,
  },
};

/** Maps ApiError and validation failures to the public error body. Never leaks internals. */
export function installErrorHandling(app: AnyApp): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSeconds !== undefined) reply.header('Retry-After', String(err.retryAfterSeconds));
      return reply.status(err.statusCode).send(err.toBody());
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      return reply
        .status(400)
        .send(errors.badRequest('invalid_request', 'The request is not valid.').toBody());
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      const status = e.statusCode === 413 || e.statusCode === 415 ? e.statusCode : 400;
      return reply
        .status(status)
        .send({ error: { code: 'invalid_request', message: 'The request is not valid.' } });
    }
    // Never log the raw error: a Postgres error's detail can quote a whole row, personal data included.
    req.log.error({ error: safeError(err) }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errors.notFound().toBody()));
}

/** Keeps the raw bytes of JSON bodies so the attestation binding can hash exactly what was sent. */
export function installRawJsonParser(app: AnyApp): void {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}

/** In-memory fixed-window limiter. Per instance: it only protects the relay itself (PRD §9.1). */
export class WindowLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Returns 0 when allowed, else the seconds until the window resets. */
  hit(key: string, nowMs: number): number {
    if (this.max <= 0) return 0;
    const entry = this.hits.get(key);
    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      if (this.hits.size > 50_000) this.sweep(nowMs);
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return 0;
    }
    entry.count += 1;
    if (entry.count <= this.max) return 0;
    return Math.max(1, Math.ceil((entry.windowStart + this.windowMs - nowMs) / 1000));
  }
  /** Gives back one hit counted in the current window (for a request that turned out not to count). */
  refund(key: string, nowMs: number): void {
    const entry = this.hits.get(key);
    if (entry && nowMs - entry.windowStart < this.windowMs && entry.count > 0) entry.count -= 1;
  }
  private sweep(nowMs: number): void {
    for (const [k, v] of this.hits) if (nowMs - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export async function buildPublicApp(ctx: AppContext): Promise<PublicApp> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    bodyLimit: 16 * 1024,
    ajv: AJV_OPTIONS,
    // During shutdown, finish or refuse the connection: the app retries a dropped connection but not a 503.
    return503OnClosing: false,
    // The edge terminates TLS; the client address comes from CLIENT_IP_HEADER, not from proxy trust.
    trustProxy: false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  installRawJsonParser(app);
  installErrorHandling(app);

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'SOS Relay public API', version: '1.0.0' },
      components: {
        securitySchemes: {
          deviceToken: { type: 'http', scheme: 'bearer' },
          // The signed-in user's access token: the SOS routes and the authenticated auth routes.
          accessToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });

  const ipLimiter = new WindowLimiter(ctx.config.limits.requestsPerIpPerMinute, MINUTE);
  app.addHook('onRequest', async (req) => {
    if (req.url === '/healthz') return;
    const retry = ipLimiter.hit(clientIp(req, ctx.config.clientIpHeader), ctx.clock.now().getTime());
    if (retry > 0) {
      ctx.metrics.inc(METRICS.rateLimited, { rule: 'requests_per_ip' });
      throw errors.rateLimited(retry);
    }
  });

  app.get('/healthz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await sql`select 1`.execute(ctx.db);
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await intakeRoutes(app, ctx);
  await devicesRoutes(app, ctx);
  await sosRoutes(app, ctx);
  await statusRoutes(app, ctx);

  // Encapsulated: its own error handler. Registered after the per-IP limiter hook, which it inherits.
  await app.register(authPlugin, { ctx });

  return app;
}
