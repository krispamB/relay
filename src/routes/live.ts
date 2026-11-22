/**
 * GET /v1/live, the live status socket (docs/live-sos-plan.md §5.2; docs/app-api-contract.md §5).
 * The behaviour is in src/live/socket.ts; this file wires it into Fastify.
 *
 * - The upgrade is always accepted. A missing, bad or revoked token is answered on the socket with a
 *   close code (4001, 4003), which a React Native client can read; it cannot read an HTTP status.
 * - Frames over 8 KB are refused by ws itself, which closes 1009.
 * - On app close (deploys, SIGTERM) every socket is closed 1012 and the listener stopped, before
 *   main.ts destroys the pool.
 */
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { PublicApp } from '../app.js';
import { bearerToken } from '../auth/requireUser.js';
import type { AppContext } from '../context.js';
import { safeError } from '../errors.js';
import { CLOSE, MAX_MESSAGE_BYTES } from '../live/protocol.js';
import { LiveHub, type LiveOptions } from '../live/socket.js';

export async function liveRoutes(
  app: PublicApp,
  ctx: AppContext,
  options: Partial<LiveOptions> = {},
): Promise<LiveHub> {
  const hub = new LiveHub(ctx, options);

  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
    errorHandler: (error, socket, req) => {
      req.log.warn({ error: safeError(error) }, 'live socket error');
      socket.terminate();
    },
    preClose: async function (this: FastifyInstance) {
      await hub.close();
      const server = this.websocketServer;
      // Anything the hub did not hold (a socket mid-upgrade) is closed the same way.
      for (const client of server.clients) client.close(CLOSE.restart, 'restarting');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });

  app.get('/v1/live', { websocket: true, schema: { hide: true } }, (socket, req) => {
    hub.accept(socket, bearerToken(req));
  });

  return hub;
}
