import type { Alerter } from './alerts.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { CoreClient } from './core/types.js';
import type { Db } from './db/index.js';
import type { Intakes } from './intakes.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

/** Everything a route or job needs. Built once in main.ts; built with fakes in tests. */
export interface AppContext {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  intakes: Intakes;
  core: CoreClient;
  alerts: Alerter;
  metrics: Metrics;
}
