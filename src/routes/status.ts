import { Type } from '@sinclair/typebox';
import { type PublicApp, WindowLimiter } from '../app.js';
import { deriveAuthKeys } from '../auth/keys.js';
import type { AppContext } from '../context.js';
import { errors } from '../errors.js';
import { RECEIPT_ID_PATTERN } from '../ids.js';
import { readSnapshot } from '../live/read.js';
import { LiveSnapshotSchema } from '../live/snapshot.js';
import { METRICS } from '../metrics.js';
import { requireCaller } from '../sos/caller.js';

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
});

const receiptIdRe = new RegExp(RECEIPT_ID_PATTERN);

/**
 * PRD §7.5; docs/live-sos-plan.md §3.3. Reads the database only; never touches ctx.core.
 * Returns the same live snapshot as the socket (plan §5.3, src/live/read.ts).
 * Authenticated by the owner's access token. Someone else's receipt is the same 404 as an unknown
 * one, so receipt ids cannot be probed.
 */
export async function statusRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const keys = deriveAuthKeys(ctx.config.auth.tokenSecret);
  const intervalS = ctx.config.limits.statusPollMinIntervalS;
  // One hit allowed per window; max 0 disables the limiter.
  const limiter = new WindowLimiter(intervalS > 0 ? 1 : 0, intervalS * 1000);

  app.get(
    '/v1/sos/:receiptId/status',
    {
      schema: {
        operationId: 'getSosStatus',
        summary: "Status of one of the signed-in user's SOS.",
        security: [{ accessToken: [] }],
        // No pattern here: a validation failure would be a 400 and tell a prober something
        // different from the 404 every other bad request gets.
        params: Type.Object({ receiptId: Type.String() }),
        response: {
          200: LiveSnapshotSchema,
          401: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req) => {
      const { receiptId } = req.params;
      const caller = await requireCaller(ctx, keys, req);
      if (!receiptIdRe.test(receiptId)) throw errors.notFound();

      // One read for existence and ownership: another user's SOS is not found.
      const snapshot = await readSnapshot(ctx.db, receiptId, caller.userId, ctx.clock.now());
      if (!snapshot) throw errors.notFound();

      // Only the owner reaches the limiter, so a stranger cannot use up someone else's allowance.
      const retry = limiter.hit(receiptId, ctx.clock.now().getTime());
      if (retry > 0) {
        ctx.metrics.inc(METRICS.rateLimited, { rule: 'status_poll' });
        throw errors.rateLimited(retry);
      }
      return snapshot;
    },
  );
}
