import { buildAdminApp } from './admin/app.js';
import { createWebhookAlerter } from './alerts/webhook.js';
import { buildPublicApp } from './app.js';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createCoreClient } from './core/client.js';
import { createDb } from './db/index.js';
import { IntakeConfigError, loadIntakesFromConfig } from './intakes.js';
import { buildJobs } from './jobs/index.js';
import { startJobs } from './jobs/runner.js';
import { createLogger } from './logger.js';
import { createPromMetrics } from './metrics/prom.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  let intakes: ReturnType<typeof loadIntakesFromConfig>;
  try {
    config = loadConfig();
    intakes = loadIntakesFromConfig(config);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof IntakeConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  const clock = systemClock;
  const db = createDb(config.databaseUrl, 10, (code) =>
    log.warn({ code }, 'idle database connection closed'),
  );
  const metrics = createPromMetrics();
  const alerts = createWebhookAlerter({ db, clock, log, webhookUrl: config.alertWebhookUrl });
  const ctx: AppContext = {
    config,
    db,
    clock,
    log,
    intakes,
    metrics,
    alerts,
    core: createCoreClient(
      { apiBase: config.resgrid.apiBase, apiKey: config.resgrid.apiKey },
      { log, metrics, clock },
    ),
  };

  if (!config.alertWebhookUrl) log.warn('ALERT_WEBHOOK_URL is not set: alerts will be logged only');

  const publicApp = await buildPublicApp(ctx);
  const adminApp = await buildAdminApp(ctx);
  await publicApp.listen({ host: config.host, port: config.port });
  await adminApp.listen({ host: config.host, port: config.adminPort });

  const jobs = config.runJobs ? startJobs(buildJobs(ctx), log) : undefined;
  log.info(
    { port: config.port, adminPort: config.adminPort, jobs: config.runJobs, intakes: intakes.all.length },
    'sos-relay started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    // Stop taking requests, let in-flight requests and the in-flight delivery finish, then exit.
    await Promise.allSettled([publicApp.close(), adminApp.close()]);
    await jobs?.stop();
    await alerts.flush();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'startup failed');
  process.exit(1);
});
