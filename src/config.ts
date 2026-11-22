/** Environment configuration. See sos-relay-PRD.md §13.1. Fails fast with every problem listed. */

export interface Limits {
  sosPerUserPer24h: number;
  sosPerPhonePer24h: number;
  sosPerIpPerHour: number;
  intakeBreakerCount: number;
  intakeBreakerWindowS: number;
  statusPollMinIntervalS: number;
  requestsPerIpPerMinute: number;
  hoaxStrikesToBlock: number;
  strikeTtlDays: number;
  blockTtlDays: number;
  queueDepthWarn: number;
  oldestQueuedWarnS: number;
}

export interface Config {
  nodeEnv: string;
  host: string;
  port: number;
  adminPort: number;
  databaseUrl: string;
  runJobs: boolean;
  logLevel: string;
  clientIpHeader: string | undefined;
  resgrid: {
    apiBase: string;
    apiKey: string;
    /** YYYY-MM-DD */
    apiKeyExpiresOn: string;
    callTypeName: string;
    priorityId: number;
  };
  /** Path to the intakes JSON file. One of intakesFile / intakesJson is set. */
  intakesFile: string | undefined;
  /** The intakes JSON inline, for platforms without a writable file system (Railway). */
  intakesJson: string | undefined;
  phoneHashSecret: string;
  /** Sign-up, sign-in and the session. Always on: the SOS routes need the signed-in user. */
  auth: {
    /** At least 32 bytes. Signs access tokens and derives the other auth keys. */
    tokenSecret: string;
  };
  /** The Nature of every SOS call sent to Core (docs/live-sos-plan.md §3.2, D6). */
  sosNatureText: string;
  /** Voice recordings one SOS may hold (docs/live-sos-plan.md D8). Ships as 1. */
  recordingsPerSos: number;
  adminToken: string;
  alertWebhookUrl: string | undefined;
  demoDispatchAfterS: number;
  demoCloseAfterS: number;
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  sosPerUserPer24h: 3,
  sosPerPhonePer24h: 3,
  sosPerIpPerHour: 10,
  intakeBreakerCount: 30,
  intakeBreakerWindowS: 600,
  statusPollMinIntervalS: 5,
  requestsPerIpPerMinute: 120,
  hoaxStrikesToBlock: 2,
  strikeTtlDays: 30,
  blockTtlDays: 30,
  queueDepthWarn: 10,
  oldestQueuedWarnS: 300,
};

const LIMIT_ENV: Record<keyof Limits, string> = {
  sosPerUserPer24h: 'LIMIT_SOS_PER_USER_PER_24H',
  sosPerPhonePer24h: 'LIMIT_SOS_PER_PHONE_PER_24H',
  sosPerIpPerHour: 'LIMIT_SOS_PER_IP_PER_HOUR',
  intakeBreakerCount: 'LIMIT_INTAKE_BREAKER_COUNT',
  intakeBreakerWindowS: 'LIMIT_INTAKE_BREAKER_WINDOW_S',
  statusPollMinIntervalS: 'LIMIT_STATUS_POLL_MIN_INTERVAL_S',
  requestsPerIpPerMinute: 'LIMIT_REQUESTS_PER_IP_PER_MINUTE',
  hoaxStrikesToBlock: 'HOAX_STRIKES_TO_BLOCK',
  strikeTtlDays: 'STRIKE_TTL_DAYS',
  blockTtlDays: 'BLOCK_TTL_DAYS',
  queueDepthWarn: 'QUEUE_DEPTH_WARN',
  oldestQueuedWarnS: 'OLDEST_QUEUED_WARN_S',
};

/** The recording carries what happened; the dispatcher sees this until it is attached. */
export const DEFAULT_SOS_NATURE_TEXT = 'SOS – caller recording to follow';
/** Upper bound on SOS_NATURE_TEXT, in characters. */
export const MAX_SOS_NATURE_TEXT = 200;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const req = (name: string): string => {
    const v = get(name);
    if (v === undefined) problems.push(`${name} is required`);
    return v ?? '';
  };
  const int = (name: string, def: number, min = 0): number => {
    const v = get(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
      problems.push(`${name} must be an integer >= ${min}`);
      return def;
    }
    return n;
  };
  const bool = (name: string, def: boolean): boolean => {
    const v = get(name);
    if (v === undefined) return def;
    if (v === 'true') return true;
    if (v === 'false') return false;
    problems.push(`${name} must be "true" or "false"`);
    return def;
  };
  const secret = (name: string): string => {
    const v = req(name);
    if (v && Buffer.byteLength(v) < 32) problems.push(`${name} must be at least 32 bytes`);
    return v;
  };

  const nodeEnv = get('NODE_ENV') ?? 'development';

  const apiBase = req('RESGRID_API_BASE').replace(/\/+$/, '');
  if (apiBase && !/^https?:\/\//.test(apiBase)) problems.push('RESGRID_API_BASE must be an http(s) URL');

  const apiKey = req('RESGRID_API_KEY');
  if (apiKey && (!apiKey.startsWith('rgk_') || apiKey.length < 40 || apiKey.length > 100)) {
    problems.push('RESGRID_API_KEY must start with "rgk_" and be 40 to 100 characters');
  }

  const apiKeyExpiresOn = req('RESGRID_API_KEY_EXPIRES_ON');
  if (apiKeyExpiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(apiKeyExpiresOn)) {
    problems.push('RESGRID_API_KEY_EXPIRES_ON must be a date in YYYY-MM-DD form');
  } else if (apiKeyExpiresOn && Number.isNaN(new Date(`${apiKeyExpiresOn}T00:00:00Z`).getTime())) {
    problems.push('RESGRID_API_KEY_EXPIRES_ON is not a real date');
  }

  const priorityRaw = req('RESGRID_PRIORITY_ID');
  const priorityId = Number(priorityRaw);
  if (priorityRaw && !Number.isInteger(priorityId)) problems.push('RESGRID_PRIORITY_ID must be an integer');

  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof Limits)[]) {
    limits[key] = int(LIMIT_ENV[key], DEFAULT_LIMITS[key]);
  }

  const alertWebhookUrl = get('ALERT_WEBHOOK_URL');
  if (alertWebhookUrl && !/^https?:\/\//.test(alertWebhookUrl)) {
    problems.push('ALERT_WEBHOOK_URL must be an http(s) URL');
  }

  const sosNatureText = get('SOS_NATURE_TEXT') ?? DEFAULT_SOS_NATURE_TEXT;
  if ([...sosNatureText].length > MAX_SOS_NATURE_TEXT || /\p{Cc}/u.test(sosNatureText)) {
    problems.push(
      `SOS_NATURE_TEXT must be at most ${MAX_SOS_NATURE_TEXT} characters, with no control characters`,
    );
  }

  const config: Config = {
    nodeEnv,
    host: get('HOST') ?? '::',
    port: int('PORT', 3000, 1),
    adminPort: int('ADMIN_PORT', 3001, 1),
    databaseUrl: req('DATABASE_URL'),
    runJobs: bool('RUN_JOBS', true),
    logLevel: get('LOG_LEVEL') ?? 'info',
    clientIpHeader: get('CLIENT_IP_HEADER')?.toLowerCase(),
    resgrid: {
      apiBase,
      apiKey,
      apiKeyExpiresOn,
      callTypeName: req('RESGRID_CALL_TYPE_NAME'),
      priorityId,
    },
    intakesFile: get('INTAKES_FILE'),
    intakesJson: get('INTAKES_JSON'),
    phoneHashSecret: secret('PHONE_HASH_SECRET'),
    adminToken: secret('ADMIN_TOKEN'),
    auth: { tokenSecret: secret('AUTH_TOKEN_SECRET') },
    sosNatureText,
    recordingsPerSos: int('RECORDINGS_PER_SOS', 1, 1),
    alertWebhookUrl,
    demoDispatchAfterS: int('DEMO_DISPATCH_AFTER_S', 30, 1),
    demoCloseAfterS: int('DEMO_CLOSE_AFTER_S', 90, 1),
    limits,
  };
  if (!config.intakesFile && !config.intakesJson) problems.push('INTAKES_FILE or INTAKES_JSON is required');
  if (nodeEnv === 'production' && !config.clientIpHeader && !bool('ALLOW_SOCKET_IP_IN_PRODUCTION', false)) {
    problems.push(
      'CLIENT_IP_HEADER is required when NODE_ENV=production: behind a proxy every caller would otherwise share one IP and one rate limit (set ALLOW_SOCKET_IP_IN_PRODUCTION=true if the relay is reached directly)',
    );
  }
  if (config.port === config.adminPort) problems.push('PORT and ADMIN_PORT must differ');
  if (config.demoCloseAfterS <= config.demoDispatchAfterS) {
    problems.push('DEMO_CLOSE_AFTER_S must be greater than DEMO_DISPATCH_AFTER_S');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
