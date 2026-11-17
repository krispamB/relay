import { Type } from '@sinclair/typebox';
import { type PublicApp, WindowLimiter } from '../app.js';
import type { AppContext } from '../context.js';
import { safeEqual, statusTokenFor } from '../crypto.js';
import { errors } from '../errors.js';
import { RECEIPT_ID_PATTERN } from '../ids.js';
import { METRICS } from '../metrics.js';

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
});

const StatusResponse = Type.Object({
  status: Type.Union(
    [
      Type.Literal('queued'),
      Type.Literal('received'),
      Type.Literal('dispatched'),
      Type.Literal('closed'),
      Type.Literal('failed'),
    ],
    { description: 'Where the SOS is now.' },
  ),
  reference: Type.String({ description: 'Short code the caller can quote, such as SOS-7KQ2.' }),
  updatedAt: Type.String({ format: 'date-time', description: 'Time of the last status change.' }),
});

const receiptIdRe = new RegExp(RECEIPT_ID_PATTERN);

/** PRD §7.5. Reads the database only; never touches ctx.core. */
export async function statusRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  const intervalS = ctx.config.limits.statusPollMinIntervalS;
  // One hit allowed per window; max 0 disables the limiter.
  const limiter = new WindowLimiter(intervalS > 0 ? 1 : 0, intervalS * 1000);

  app.get(
    '/v1/sos/:receiptId/status',
    {
      schema: {
        operationId: 'getSosStatus',
        summary: 'Status of one SOS. Needs the X-Status-Token returned when the SOS was accepted.',
        // No pattern and no required header here: a validation failure would be a 400 and tell a
        // prober something different from the 404 every other bad request gets.
        params: Type.Object({ receiptId: Type.String() }),
        headers: Type.Object({
          'x-status-token': Type.Optional(
            Type.String({ description: 'The status token returned with the receipt.' }),
          ),
        }),
        response: {
          200: StatusResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req) => {
      const { receiptId } = req.params;
      const token = req.headers['x-status-token'];
      // Always derive and compare, so a malformed id costs the same as a well-formed one.
      const expected = statusTokenFor(ctx.config.statusTokenSecret, receiptId);
      const tokenOk = typeof token === 'string' && safeEqual(token, expected);
      if (!tokenOk || !receiptIdRe.test(receiptId)) throw errors.notFound();

      // Only a caller holding a valid token reaches the limiter, so a stranger cannot use up
      // someone else's allowance.
      const retry = limiter.hit(receiptId, ctx.clock.now().getTime());
      if (retry > 0) {
        ctx.metrics.inc(METRICS.rateLimited, { rule: 'status_poll' });
        throw errors.rateLimited(retry);
      }

      const sub = await ctx.db
        .selectFrom('submissions')
        .select(['status', 'reference', 'accepted_at'])
        .where('id', '=', receiptId)
        .executeTakeFirst();
      if (!sub) throw errors.notFound();

      const last = await ctx.db
        .selectFrom('submission_events')
        .select((eb) => eb.fn.max('at').as('at'))
        .where('submission_id', '=', receiptId)
        .executeTakeFirst();

      return {
        status: sub.status,
        reference: sub.reference,
        updatedAt: (last?.at ?? sub.accepted_at).toISOString(),
      };
    },
  );
}
