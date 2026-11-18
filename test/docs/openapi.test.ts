import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, renderOpenApi } from '../../scripts/openapi.js';
import { buildPublicApp } from '../../src/app.js';
import { createTestContext, testConfig } from '../helpers/context.js';

type Operation = { tags?: string[]; security?: unknown[] };
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
};

const AUTH_OPERATIONS: [method: string, path: string][] = [
  ['post', '/v1/auth/signup'],
  ['post', '/v1/auth/signin'],
  ['post', '/v1/auth/refresh'],
  ['post', '/v1/auth/signout'],
  ['get', '/v1/me'],
];

const SOS_OPERATIONS: [method: string, path: string][] = [
  ['get', '/v1/intake/{intakeCode}'],
  ['get', '/v1/devices/nonce'],
  ['post', '/v1/devices/register'],
  ['post', '/v1/sos'],
  ['get', '/v1/sos/{receiptId}/status'],
];

async function committed(): Promise<Doc> {
  return JSON.parse(await readFile(OPENAPI_FILE, 'utf8')) as Doc;
}

describe('docs/openapi.json', () => {
  it('matches the document the code produces (run `npm run openapi` to regenerate)', async () => {
    const committedText = await readFile(OPENAPI_FILE, 'utf8');
    expect(committedText).toBe(await renderOpenApi());
  });

  it('is what the relay serves at GET /v1/openapi.json when auth is enabled', async () => {
    const base = testConfig();
    const app = await buildPublicApp(
      createTestContext({ config: { ...base, auth: { ...base.auth, enabled: true } } }),
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(JSON.parse(await readFile(OPENAPI_FILE, 'utf8')));
    } finally {
      await app.close();
    }
  });

  it('documents the auth endpoints under the auth tag', async () => {
    const doc = await committed();
    for (const [method, path] of AUTH_OPERATIONS) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(op?.tags, `${method.toUpperCase()} ${path} tags`).toEqual(['auth']);
    }
  });

  it('keeps the accessToken scheme apart from the deviceToken scheme', async () => {
    const doc = await committed();
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['accessToken', 'deviceToken']);
    expect(doc.paths['/v1/me']?.get?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/auth/signout']?.post?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/sos']?.post?.security).toEqual([{ deviceToken: [] }]);
  });

  it('leaves the SOS operations out of the auth tag', async () => {
    const doc = await committed();
    for (const [method, path] of SOS_OPERATIONS) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(op?.tags ?? []).not.toContain('auth');
    }
  });

  it('is the document without auth routes when auth is disabled', async () => {
    const base = testConfig();
    const app = await buildPublicApp(
      createTestContext({ config: { ...base, auth: { ...base.auth, enabled: false } } }),
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      const doc = res.json() as Doc;
      for (const [, path] of AUTH_OPERATIONS) expect(doc.paths[path]).toBeUndefined();
      expect(Object.keys(doc.components.securitySchemes)).toEqual(['deviceToken']);
    } finally {
      await app.close();
    }
  });
});
