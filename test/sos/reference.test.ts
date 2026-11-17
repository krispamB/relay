import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, scriptedCore } from '../delivery/fixtures.js';
import { closeTestDb, resetDb } from '../helpers/context.js';
import { device, type Harness, harness } from './helpers.js';

const references = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('../../src/ids.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ids.js')>();
  return { ...orig, newReference: () => references.queue.shift() ?? orig.newReference() };
});

let h: Harness | undefined;
beforeEach(() => resetDb());
afterEach(async () => {
  await h?.app.close();
  h = undefined;
});
afterAll(() => closeTestDb());

describe('reference uniqueness (PRD §7.4)', () => {
  it('draws a new reference when the first one is already taken', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    references.queue.push('SOS-AAAA');
    const first = await (await device(h)).send();
    expect(first.body.reference).toBe('SOS-AAAA');

    references.queue.push('SOS-AAAA', 'SOS-AAAA', 'SOS-BBBB');
    const second = await (await device(h)).send();
    expect(second.status).toBe(201);
    expect(second.body.reference).toBe('SOS-BBBB');
  });

  it('gives up with a 500 after repeated collisions, persisting nothing new', async () => {
    h = await harness({ core: scriptedCore(ok()) });
    references.queue.push('SOS-CCCC');
    await (await device(h)).send();
    references.queue.push(...Array(10).fill('SOS-CCCC'));
    const res = await (await device(h)).send();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } });
    references.queue.length = 0;
  });
});
