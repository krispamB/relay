/**
 * Review reproduction: an open DEMO submission makes the user's next REAL SOS a 409 that hands
 * back the demo receipt. The app (sos-app-PRD §7.1, 409 row) stores that receipt and shows its
 * status, which the demo timetable walks to "dispatched" without anyone having been told.
 * Regression test: failed until the one-open rule keeps demo and real submissions apart.
 */
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { scriptedCore } from '../delivery/fixtures.js';
import { closeTestDb, DEMO_INTAKE_CODE, resetDb, TEST_INTAKE_CODE } from '../helpers/context.js';
import { caller, type Harness, harness } from '../sos/helpers.js';

let h: Harness | undefined;
beforeEach(() => resetDb());
afterEach(async () => {
  await h?.app.close();
  h = undefined;
});
afterAll(() => closeTestDb());

it('a real SOS is not answered with the receipt of an open demo submission', async () => {
  h = await harness({ core: scriptedCore({ kind: 'ok', data: { callId: '901' } }) });
  const d = await caller(h);

  // A reviewer / smoke test from this phone: demo SOS, received at once, open for ~90 s.
  const demo = await d.send({ intakeCode: DEMO_INTAKE_CODE });
  expect(demo.status).toBe(201);
  expect(demo.body.status).toBe('received');

  // A real emergency from the same phone, seconds later.
  const real = await d.send({ intakeCode: TEST_INTAKE_CODE });

  // Today: 409 carrying the DEMO receipt, which the app will show as this SOS's status.
  expect(real.body.receiptId).not.toBe(demo.body.receiptId);
  expect(real.status).not.toBe(409);
});
