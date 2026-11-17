/** Environment configuration. See sos-relay-PRD.md §13.1. Fails fast with every problem listed. */

export type AttestationMode = 'enforce' | 'permissive';

export interface Limits {
  sosPerDevicePer24h: number;
  sosPerPhonePer24h: number;
  sosPerIpPerHour: number;
  registrationsPerIpPerHour: number;
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
  attestation: {
    mode: AttestationMode;
    androidPackageName: string | undefined;
    androidCertSha256: string[];
    googleServiceAccountJson: string | undefined;
    iosTeamId: string | undefined;
    iosBundleId: string | undefined;
    iosAppAttestEnv: 'production' | 'development';
  };
  statusTokenSecret: string;
  phoneHashSecret: string;
  adminToken: string;
  alertWebhookUrl: string | undefined;
  demoDispatchAfterS: number;
  demoCloseAfterS: number;
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  sosPerDevicePer24h: 3,
  sosPerPhonePer24h: 3,
  sosPerIpPerHour: 10,
  registrationsPerIpPerHour: 10,
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
  sosPerDevicePer24h: 'LIMIT_SOS_PER_DEVICE_PER_24H',
  sosPerPhonePer24h: 'LIMIT_SOS_PER_PHONE_PER_24H',
  sosPerIpPerHour: 'LIMIT_SOS_PER_IP_PER_HOUR',
  registrationsPerIpPerHour: 'LIMIT_REGISTRATIONS_PER_IP_PER_HOUR',
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

  const modeRaw = get('ATTESTATION_MODE') ?? 'enforce';
  if (modeRaw !== 'enforce' && modeRaw !== 'permissive') {
    problems.push('ATTESTATION_MODE must be "enforce" or "permissive"');
  }
  const mode = (modeRaw === 'permissive' ? 'permissive' : 'enforce') as AttestationMode;
  if (mode === 'permissive' && nodeEnv === 'production' && !bool('ALLOW_PERMISSIVE_IN_PRODUCTION', false)) {
    problems.push(
      'ATTESTATION_MODE=permissive is refused when NODE_ENV=production (set ALLOW_PERMISSIVE_IN_PRODUCTION=true to override)',
    );
  }

  const attestation: Config['attestation'] = {
    mode,
    androidPackageName: get('ANDROID_PACKAGE_NAME'),
    androidCertSha256: (get('ANDROID_CERT_SHA256') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    googleServiceAccountJson: get('GOOGLE_SERVICE_ACCOUNT_JSON'),
    iosTeamId: get('IOS_TEAM_ID'),
    iosBundleId: get('IOS_BUNDLE_ID'),
    iosAppAttestEnv: get('IOS_APP_ATTEST_ENV') === 'development' ? 'development' : 'production',
  };
  if (mode === 'enforce') {
    // In enforce mode a platform with missing config simply cannot attest; require at least one platform.
    const android =
      attestation.androidPackageName &&
      attestation.androidCertSha256.length > 0 &&
      attestation.googleServiceAccountJson;
    const ios = attestation.iosTeamId && attestation.iosBundleId;
    if (!android && !ios) {
      problems.push(
        'ATTESTATION_MODE=enforce needs Android (ANDROID_PACKAGE_NAME, ANDROID_CERT_SHA256, GOOGLE_SERVICE_ACCOUNT_JSON) or iOS (IOS_TEAM_ID, IOS_BUNDLE_ID) settings',
      );
    }
  }
  if (attestation.googleServiceAccountJson) {
    try {
      JSON.parse(attestation.googleServiceAccountJson);
    } catch {
      problems.push('GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON');
    }
  }

  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof Limits)[]) {
    limits[key] = int(LIMIT_ENV[key], DEFAULT_LIMITS[key]);
  }

  const alertWebhookUrl = get('ALERT_WEBHOOK_URL');
  if (alertWebhookUrl && !/^https?:\/\//.test(alertWebhookUrl)) {
    problems.push('ALERT_WEBHOOK_URL must be an http(s) URL');
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
    attestation,
    statusTokenSecret: secret('STATUS_TOKEN_SECRET'),
    phoneHashSecret: secret('PHONE_HASH_SECRET'),
    adminToken: secret('ADMIN_TOKEN'),
    alertWebhookUrl,
    demoDispatchAfterS: int('DEMO_DISPATCH_AFTER_S', 30, 1),
    demoCloseAfterS: int('DEMO_CLOSE_AFTER_S', 90, 1),
    limits,
  };
  if (!config.intakesFile && !config.intakesJson) problems.push('INTAKES_FILE or INTAKES_JSON is required');
  if (config.port === config.adminPort) problems.push('PORT and ADMIN_PORT must differ');
  if (config.demoCloseAfterS <= config.demoDispatchAfterS) {
    problems.push('DEMO_CLOSE_AFTER_S must be greater than DEMO_DISPATCH_AFTER_S');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
