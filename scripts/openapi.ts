/**
 * Renders the public API's OpenAPI document, exactly as the relay serves it at GET /v1/openapi.json.
 *
 * The public app is built with a stand-in context: building the routes needs the configuration's
 * shape, never a database, Core or attestation. Nothing here connects anywhere.
 * Used by scripts/export-openapi.ts (writes docs/openapi.json) and by test/docs/openapi.test.ts
 * (fails when the committed file is out of date).
 */
import { NoopAlerter } from '../src/alerts.js';
import { buildPublicApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { type Config, DEFAULT_LIMITS } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import type { CoreClient } from '../src/core/types.js';
import { createDb } from '../src/db/index.js';
import { Intakes } from '../src/intakes.js';
import { silentLogger } from '../src/logger.js';
import { NoopMetrics } from '../src/metrics.js';

export const OPENAPI_FILE = new URL('../docs/openapi.json', import.meta.url);

const notUsed = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available while rendering the OpenAPI document`);
};

function standInConfig(): Config {
  return {
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    databaseUrl: 'postgres://127.0.0.1:1/unused',
    runJobs: false,
    logLevel: 'silent',
    clientIpHeader: undefined,
    resgrid: {
      apiBase: 'http://127.0.0.1:1',
      apiKey: 'unused',
      apiKeyExpiresOn: '2099-01-01',
      callTypeName: 'unused',
      priorityId: 0,
    },
    intakesFile: undefined,
    intakesJson: '[]',
    attestation: {
      mode: 'permissive',
      androidPackageName: undefined,
      androidCertSha256: [],
      googleServiceAccountJson: undefined,
      iosTeamId: undefined,
      iosBundleId: undefined,
      iosAppAttestEnv: 'production',
    },
    statusTokenSecret: 'unused',
    phoneHashSecret: 'unused',
    adminToken: 'unused',
    auth: { enabled: false, tokenSecret: '' },
    alertWebhookUrl: undefined,
    demoDispatchAfterS: 30,
    demoCloseAfterS: 90,
    limits: { ...DEFAULT_LIMITS },
  };
}

/** The document as pretty-printed JSON with a trailing newline, as committed in docs/openapi.json. */
export async function renderOpenApi(): Promise<string> {
  const config = standInConfig();
  // A pool connects lazily; this one is never queried.
  const db = createDb(config.databaseUrl, 1);
  const core: CoreClient = {
    saveCall: notUsed('Core'),
    getCall: notUsed('Core'),
    getPendingCalls: notUsed('Core'),
    getCallTypes: notUsed('Core'),
    getCallPriorities: notUsed('Core'),
    getFieldPolicy: notUsed('Core'),
  };
  const ctx: AppContext = {
    config,
    db,
    clock: systemClock,
    log: silentLogger(),
    intakes: new Intakes([]),
    core,
    attestation: { verifyRegistration: notUsed('Attestation'), verifyRequest: notUsed('Attestation') },
    alerts: new NoopAlerter(),
    metrics: new NoopMetrics(),
  };
  const app = await buildPublicApp(ctx);
  try {
    await app.ready();
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
    await db.destroy();
  }
}
