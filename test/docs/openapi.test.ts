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
  ['post', '/v1/sos'],
  ['get', '/v1/sos/{receiptId}/status'],
  ['post', '/v1/sos/{receiptId}/recording'],
];

async function committed(): Promise<Doc> {
  return JSON.parse(await readFile(OPENAPI_FILE, 'utf8')) as Doc;
}

describe('docs/openapi.json', () => {
  it('matches the document the code produces (run `npm run openapi` to regenerate)', async () => {
    const committedText = await readFile(OPENAPI_FILE, 'utf8');
    expect(committedText).toBe(await renderOpenApi());
  });

  it('is what the relay serves at GET /v1/openapi.json', async () => {
    const app = await buildPublicApp(createTestContext({ config: testConfig() }));
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(JSON.parse(await readFile(OPENAPI_FILE, 'utf8')));
    } finally {
      await app.close();
    }
  });

  it('is browsable as Swagger UI at /v1/docs, which loads the same document, and adds no paths to it', async () => {
    const app = await buildPublicApp(createTestContext({ config: testConfig() }));
    try {
      const page = await app.inject({ method: 'GET', url: '/v1/docs/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.body).toContain('swagger-ui');
      // Static assets come with a CSP, as the page is served from the public relay.
      const asset = await app.inject({ method: 'GET', url: '/v1/docs/static/swagger-ui-bundle.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-security-policy']).toBeDefined();
      const spec = await app.inject({ method: 'GET', url: '/v1/docs/json' });
      expect(spec.json()).toEqual(JSON.parse(await readFile(OPENAPI_FILE, 'utf8')));
      expect(Object.keys((spec.json() as Doc).paths).some((p) => p.startsWith('/v1/docs'))).toBe(false);
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

  it('secures the SOS routes and the authenticated auth routes with the access token', async () => {
    const doc = await committed();
    expect(doc.paths['/v1/me']?.get?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/auth/signout']?.post?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/sos']?.post?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/sos/{receiptId}/status']?.get?.security).toEqual([{ accessToken: [] }]);
    expect(doc.paths['/v1/sos/{receiptId}/recording']?.post?.security).toEqual([{ accessToken: [] }]);
  });

  it('describes the recording upload as a raw audio/mp4 body', async () => {
    const doc = await committed();
    const op = doc.paths['/v1/sos/{receiptId}/recording']?.post as
      | { requestBody?: { content?: Record<string, unknown> } }
      | undefined;
    expect(Object.keys(op?.requestBody?.content ?? {})).toEqual(['audio/mp4']);
  });

  it('leaves the SOS operations out of the auth tag', async () => {
    const doc = await committed();
    for (const [method, path] of SOS_OPERATIONS) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(op?.tags ?? []).not.toContain('auth');
    }
  });
});
