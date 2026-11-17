import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../../src/app.js';
import { DAY } from '../../src/clock.js';
import { parseIntakes } from '../../src/intakes.js';
import { pauseDelivery } from '../../src/state.js';
import {
  closeTestDb,
  createTestContext,
  DEMO_INTAKE_CODE,
  markHealthy,
  resetDb,
  TEST_INTAKE_CODE,
} from '../helpers/context.js';

beforeEach(() => resetDb());
afterAll(() => closeTestDb());

async function setup() {
  const ctx = createTestContext();
  await markHealthy(ctx);
  const app = await buildPublicApp(ctx);
  const get = (code: string) => app.inject({ method: 'GET', url: `/v1/intake/${code}` });
  return { ctx, app, get };
}

describe('GET /v1/intake/:intakeCode', () => {
  it('returns the PRD §7.1 body for the real intake', async () => {
    const { get } = await setup();
    const res = await get(TEST_INTAKE_CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      intakeCode: TEST_INTAKE_CODE,
      displayName: 'Test Fire Service',
      emergencyPhone: '112',
      natures: [
        { id: 'medical', label: 'Medical emergency' },
        { id: 'fire', label: 'Fire' },
      ],
      requireVerifiedPhone: false,
      available: true,
      demo: false,
      required: { location: false, address: false, name: false },
    });
  });

  it('returns the demo intake, always available, nothing required', async () => {
    const { get } = await setup();
    const res = await get(DEMO_INTAKE_CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      intakeCode: DEMO_INTAKE_CODE,
      demo: true,
      available: true,
      requireVerifiedPhone: false,
      required: { location: false, address: false, name: false },
    });
  });

  it('404 for an unknown code', async () => {
    const { get } = await setup();
    const res = await get('NOPE-NOPE');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('410 for a disabled intake', async () => {
    const ctx = createTestContext({
      intakes: parseIntakes([
        {
          code: 'OFF-INTAKE',
          displayName: 'Off',
          emergencyPhone: '112',
          natures: [{ id: 'medical', label: 'Medical' }],
          enabled: false,
        },
      ]),
    });
    const app = await buildPublicApp(ctx);
    const res = await app.inject({ method: 'GET', url: '/v1/intake/OFF-INTAKE' });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('intake_disabled');
  });

  describe('available', () => {
    it('is false when paused, but the demo intake stays available', async () => {
      const { ctx, get } = await setup();
      await pauseDelivery(ctx.db, ctx.clock.now(), 'test');
      expect((await get(TEST_INTAKE_CODE)).json().available).toBe(false);
      expect((await get(DEMO_INTAKE_CODE)).json().available).toBe(true);
    });

    it('is false when the check is unhealthy, but the demo intake stays available', async () => {
      const { ctx, get } = await setup();
      await ctx.db
        .updateTable('relay_state')
        .set({ check_status: 'unhealthy' })
        .where('id', '=', 1)
        .execute();
      expect((await get(TEST_INTAKE_CODE)).json().available).toBe(false);
      expect((await get(DEMO_INTAKE_CODE)).json().available).toBe(true);
    });

    it('is false when no check has passed in 24 hours, but the demo intake stays available', async () => {
      const { ctx, get } = await setup();
      ctx.clock.advance(DAY - 1000);
      expect((await get(TEST_INTAKE_CODE)).json().available).toBe(true);
      ctx.clock.advance(2000);
      expect((await get(TEST_INTAKE_CODE)).json().available).toBe(false);
      expect((await get(DEMO_INTAKE_CODE)).json().available).toBe(true);
    });

    it('is false when no check has ever passed', async () => {
      const ctx = createTestContext();
      const app = await buildPublicApp(ctx);
      const res = await app.inject({ method: 'GET', url: `/v1/intake/${TEST_INTAKE_CODE}` });
      expect(res.json().available).toBe(false);
    });
  });

  describe('required', () => {
    it('location follows relay_state; address and name stay false', async () => {
      const { ctx, get } = await setup();
      await ctx.db
        .updateTable('relay_state')
        .set({ required_location: true, required_address: true, required_name: true })
        .where('id', '=', 1)
        .execute();
      expect((await get(TEST_INTAKE_CODE)).json().required).toEqual({
        location: true,
        address: false,
        name: false,
      });
      expect((await get(DEMO_INTAKE_CODE)).json().required).toEqual({
        location: false,
        address: false,
        name: false,
      });
      await ctx.db.updateTable('relay_state').set({ required_location: false }).where('id', '=', 1).execute();
      expect((await get(TEST_INTAKE_CODE)).json().required.location).toBe(false);
    });
  });
});
