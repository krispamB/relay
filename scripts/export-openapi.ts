/**
 * Writes the public API's OpenAPI document to docs/openapi.json (npm run openapi).
 * The relay serves the same document at GET /v1/openapi.json; test/docs/openapi.test.ts fails when
 * the committed file is out of date, so run this after changing a route schema.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OPENAPI_FILE, renderOpenApi } from './openapi.js';

await writeFile(OPENAPI_FILE, await renderOpenApi());
console.log(`wrote ${fileURLToPath(OPENAPI_FILE)}`);
