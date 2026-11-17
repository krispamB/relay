import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { AJV_OPTIONS, installErrorHandling } from '../app.js';
import type { AppContext } from '../context.js';
import { safeEqual } from '../crypto.js';
import { adminRoutes } from './routes.js';

export type AdminApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

/** The admin server. Separate port, never exposed publicly (PRD §11.1). Every route needs the admin token. */
export async function buildAdminApp(ctx: AppContext): Promise<AdminApp> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    bodyLimit: 16 * 1024,
    ajv: AJV_OPTIONS,
  }).withTypeProvider<TypeBoxTypeProvider>();

  installErrorHandling(app);

  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === '' || !safeEqual(token, ctx.config.adminToken)) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Admin token required.' } });
    }
  });

  await adminRoutes(app, ctx);
  return app;
}
