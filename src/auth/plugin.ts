/**
 * The auth feature as an encapsulated Fastify plugin (docs/auth-implementation-plan.md, "Decisions").
 * src/app.ts registers it only when `config.auth.enabled`; with auth off no auth route exists.
 *
 * The plugin has its own error handler, so auth routes answer with the contract's error bodies
 * (docs/auth-contract.md §2) while the SOS routes keep the relay's. It does not set a not-found
 * handler: an unknown /v1/auth path is still the relay's 404 `not_found`.
 */
import type { PublicApp } from '../app.js';
import type { AppContext } from '../context.js';
import { ApiError, safeError } from '../errors.js';
import { AuthError, authErrors } from './errors.js';
import { meRoutes } from './routes/me.js';
import { refreshRoutes } from './routes/refresh.js';
import { signinRoutes } from './routes/signin.js';
import { signoutRoutes } from './routes/signout.js';
import { signupRoutes } from './routes/signup.js';

/** Maps anything thrown inside the plugin to an AuthError. Never leaks internals. */
function toAuthError(err: unknown): AuthError | undefined {
  if (err instanceof AuthError) return err;
  // The relay's per-IP limiter runs as a root hook, before the plugin's routes.
  if (err instanceof ApiError && err.code === 'rate_limited') {
    return authErrors.rateLimited(err.retryAfterSeconds ?? 1);
  }
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (status === 413 || e?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return authErrors.payloadTooLarge();
  // Invalid JSON, an unsupported content type, a bad content-length: all "not the JSON the contract wants".
  if (status !== undefined && status >= 400 && status < 500) return authErrors.malformedRequest();
  return undefined;
}

export async function authPlugin(app: PublicApp, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;

  // Auth bodies are validated by hand (src/auth/validate.ts): the contract wants every invalid field
  // listed, with its own codes. A `schema.body` on an auth route is therefore documentation only.
  app.setValidatorCompiler(() => (data) => ({ value: data }));

  app.setErrorHandler((err: unknown, req, reply) => {
    const authError = toAuthError(err);
    if (authError) {
      if (authError.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(authError.retryAfterSeconds));
      }
      return reply.status(authError.status).send(authError.toBody());
    }
    // Never log the raw error: a Postgres error's detail can quote a whole row, personal data included.
    req.log.error({ error: safeError(err) }, 'unhandled error');
    return reply.status(500).send(authErrors.internalError().toBody());
  });

  await signupRoutes(app, ctx);
  await signinRoutes(app, ctx);
  await refreshRoutes(app, ctx);
  await signoutRoutes(app, ctx);
  await meRoutes(app, ctx);
}
