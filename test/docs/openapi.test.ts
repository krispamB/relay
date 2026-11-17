import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, renderOpenApi } from '../../scripts/openapi.js';
import { buildPublicApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';

describe('docs/openapi.json', () => {
  it('matches the document the code produces (run `npm run openapi` to regenerate)', async () => {
    const committed = await readFile(OPENAPI_FILE, 'utf8');
    expect(committed).toBe(await renderOpenApi());
  });

  it('is what the relay serves at GET /v1/openapi.json', async () => {
    const app = await buildPublicApp(createTestContext());
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(JSON.parse(await readFile(OPENAPI_FILE, 'utf8')));
    } finally {
      await app.close();
    }
  });
});
