import { Type } from '@sinclair/typebox';
import type { PublicApp } from '../app.js';
import type { AppContext } from '../context.js';
import { errors } from '../errors.js';
import { getState, unavailableReason } from '../state.js';

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
});

const IntakeResponse = Type.Object({
  intakeCode: Type.String(),
  displayName: Type.String(),
  emergencyPhone: Type.String(),
  natures: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
  requireVerifiedPhone: Type.Boolean(),
  available: Type.Boolean({ description: 'False while the relay cannot take an SOS for this intake.' }),
  demo: Type.Boolean(),
  required: Type.Object({
    location: Type.Boolean(),
    address: Type.Boolean(),
    name: Type.Boolean(),
  }),
});

/** PRD §7.1. No auth. */
export async function intakeRoutes(app: PublicApp, ctx: AppContext): Promise<void> {
  app.get(
    '/v1/intake/:intakeCode',
    {
      schema: {
        operationId: 'getIntake',
        summary: 'Describe an intake: department, natures, availability and required fields.',
        params: Type.Object({ intakeCode: Type.String() }),
        response: {
          200: IntakeResponse,
          404: ErrorResponse,
          410: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req) => {
      const intake = ctx.intakes.get(req.params.intakeCode);
      if (!intake) throw errors.notFound();
      if (!intake.enabled) throw errors.gone();

      let available = true;
      let required = { location: false, address: false, name: false };
      if (!intake.demo) {
        const state = await getState(ctx.db);
        available = unavailableReason(state, ctx.clock.now()) === undefined;
        // PRD §13.3: the relay fills placeholders for address and name itself.
        required = { location: state.required_location, address: false, name: false };
      }
      return {
        intakeCode: intake.code,
        displayName: intake.displayName,
        emergencyPhone: intake.emergencyPhone,
        natures: intake.natures.map((n) => ({ id: n.id, label: n.label })),
        requireVerifiedPhone: false,
        available,
        demo: intake.demo,
        required,
      };
    },
  );
}
