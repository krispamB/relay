/**
 * HTTP client for Resgrid Core's v4 API. integration.md is the specification (§1 to §9).
 *
 * The client never throws: every outcome, including network failures and malformed bodies,
 * comes back as a CoreResult.
 */
import { performance } from 'node:perf_hooks';
import { request } from 'undici';
import { type Clock, systemClock } from '../clock.js';
import type { Logger } from '../logger.js';
import { METRICS, type Metrics } from '../metrics.js';
import type {
  CallPriority,
  CallStateResult,
  CoreClient,
  CoreResult,
  CoreUnitStatus,
  SaveCallInput,
} from './types.js';

export const SAVE_CALL_TIMEOUT_MS = 6000;
export const READ_TIMEOUT_MS = 5000;
/** A recording is far bigger than a SaveCall body, so it gets longer. */
export const SAVE_CALL_FILE_TIMEOUT_MS = 20000;
const CALL_CLOSED_STATUSES: ReadonlySet<number> = new Set([400, 404, 410]);
/** Core ignores SaveCallFile's UserId (the file is recorded under the department's managing user) but requires the field. */
export const SAVE_CALL_FILE_USER_ID = '00000000-0000-0000-0000-000000000000';

/** integration.md §4.2: the only keys that may ever appear in a SaveCall body. */
export const SAVE_CALL_FIELDS = [
  'IsPending',
  'Priority',
  'Type',
  'Name',
  'Nature',
  'Geolocation',
  'Address',
  'ContactName',
  'ContactInfo',
  'ExternalId',
  'ReferenceId',
  'Note',
] as const;

export type SaveCallField = (typeof SAVE_CALL_FIELDS)[number];

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Builds the SaveCall JSON body from the allowlist (integration.md §4.2, §4.3).
 * Any key outside the twelve is dropped, empty values are left out entirely, and IsPending is always true.
 */
export function buildSaveCallBody(call: SaveCallInput): Record<SaveCallField, unknown> {
  const source = call as unknown as Record<string, unknown>;
  const body: Partial<Record<SaveCallField, unknown>> = { IsPending: true };
  for (const key of SAVE_CALL_FIELDS) {
    if (key === 'IsPending') continue;
    const v = source[key];
    if (!isEmpty(v)) body[key] = v;
  }
  return body as Record<SaveCallField, unknown>;
}

const STATE_TO_STATUS: Readonly<Record<number, NonNullable<CallStateResult['status']>>> = {
  8: 'received',
  0: 'dispatched',
  1: 'closed',
  2: 'closed',
  3: 'closed',
  4: 'closed',
  5: 'closed',
  6: 'closed',
  7: 'closed',
};

const HOAX_STATES = new Set([3, 7]);

/** integration.md §5.3. Takes the parsed GetCall envelope. */
export function mapCallState(envelope: { Status?: unknown; Data?: unknown }): CallStateResult {
  if (envelope.Status === 'not_found') return { notFound: true, status: 'closed', hoax: false };
  const data = envelope.Data;
  const raw = isObject(data) ? data.State : undefined;
  const state =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : undefined;
  if (state === undefined || !Number.isInteger(state)) {
    return { notFound: false, hoax: false, status: undefined };
  }
  return { notFound: false, state, status: STATE_TO_STATUS[state], hoax: HOAX_STATES.has(state) };
}

/** Parses Retry-After: delta-seconds or an HTTP date. Returns whole seconds, or undefined. */
export function parseRetryAfter(value: string | string[] | undefined, now: Date): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** Error bodies are not in the envelope: empty, plain text, or a JSON string (integration.md §3). */
export function errorMessage(text: string): string {
  const t = text.trim();
  let msg = t;
  if (t.startsWith('"') || t.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') msg = parsed;
      else if (isObject(parsed)) {
        const m = parsed.Message ?? parsed.message ?? parsed.title;
        if (typeof m === 'string') msg = m;
      }
    } catch {
      // Not JSON after all: keep the raw text.
    }
  }
  return msg.slice(0, 500);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A string or number id as a non-empty string, else null. */
function idOrNull(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  return textOrNull(v);
}

/** A finite number, or a string holding one; anything else is null. */
function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ISO 8601 (UTC) for a Core timestamp. A value with no zone is read as UTC. Unparseable → null. */
function isoOrNull(v: unknown): string | null {
  const t = textOrNull(v);
  if (t === null) return null;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(t);
  const ms = Date.parse(hasZone ? t : `${t}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** One GetAllUnitStatuses row (integration of sos-app-PRD.md §15.4). Null when the row has no UnitId. */
export function mapUnitStatus(row: unknown): CoreUnitStatus | null {
  if (!isObject(row)) return null;
  const unitId = idOrNull(row.UnitId);
  if (unitId === null) return null;
  const destinationType = numberOrNull(row.DestinationType);
  return {
    unitId,
    unitType: textOrNull(row.Type),
    statusText: textOrNull(row.State),
    destinationType: destinationType !== null && Number.isInteger(destinationType) ? destinationType : null,
    destinationId: idOrNull(row.DestinationId),
    latitude: numberOrNull(row.Latitude),
    longitude: numberOrNull(row.Longitude),
    timestamp: isoOrNull(row.Timestamp),
  };
}

type Endpoint =
  | 'SaveCall'
  | 'SaveCallFile'
  | 'GetAllUnitStatuses'
  | 'GetCall'
  | 'GetPendingCalls'
  | 'GetNewCallFieldPolicy'
  | 'GetAllCallTypes'
  | 'GetAllCallPriorites';

type Raw =
  | {
      type: 'response';
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      text: string;
    }
  | { type: 'error'; reason: string };

export interface CoreClientConfig {
  apiBase: string;
  apiKey: string;
}

export interface CoreClientDeps {
  log: Logger;
  metrics: Metrics;
  /** Only used to turn an HTTP-date Retry-After into seconds. */
  clock?: Clock;
}

export function createCoreClient(cfg: CoreClientConfig, deps: CoreClientDeps): CoreClient {
  const base = `${cfg.apiBase.replace(/\/+$/, '')}/api/v4/`;
  const clock = deps.clock ?? systemClock;

  async function send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; idempotencyKey?: string; timeoutMs: number },
  ): Promise<Raw> {
    // Built from scratch on every call: exactly these headers, never Authorization.
    const headers: Record<string, string> = {
      'X-Resgrid-ApiKey': cfg.apiKey,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey !== undefined) headers['Idempotency-Key'] = init.idempotencyKey;

    if (!(init.timeoutMs > 0)) return { type: 'error', reason: 'timeout' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), init.timeoutMs);
    try {
      const res = await request(base + path, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
        headersTimeout: init.timeoutMs,
        bodyTimeout: init.timeoutMs,
      });
      const text = await res.body.text();
      return { type: 'response', statusCode: res.statusCode, headers: res.headers, text };
    } catch (err) {
      if (controller.signal.aborted) return { type: 'error', reason: 'timeout' };
      const e = err as { code?: unknown; name?: unknown };
      const code = typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'error';
      if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
        return { type: 'error', reason: 'timeout' };
      }
      return { type: 'error', reason: `network: ${code}` };
    } finally {
      clearTimeout(timer);
    }
  }

  function headerRequestId(raw: Raw): string | undefined {
    if (raw.type !== 'response') return undefined;
    const h = raw.headers['x-request-id'] ?? raw.headers['request-id'];
    return Array.isArray(h) ? h[0] : h;
  }

  /** Mapping of integration.md §4.6 for every status that is not a success. */
  function classifyFailure(raw: Raw): CoreResult<never> {
    if (raw.type === 'error') return { kind: 'retryable', reason: raw.reason };
    const s = raw.statusCode;
    if (s === 401 || s === 403) return { kind: 'auth', httpStatus: s };
    if (s === 409) return { kind: 'conflict' };
    if (s === 429) {
      const retryAfterSeconds = parseRetryAfter(raw.headers['retry-after'], clock.now());
      return retryAfterSeconds === undefined
        ? { kind: 'retryable', reason: 'HTTP 429' }
        : { kind: 'retryable', reason: 'HTTP 429', retryAfterSeconds };
    }
    if (s >= 400 && s < 500) return { kind: 'rejected', httpStatus: s, message: errorMessage(raw.text) };
    // 5xx, and anything unexpected (1xx/3xx): the outcome is unknown, so retry with the same key.
    return { kind: 'retryable', reason: `HTTP ${s}` };
  }

  function parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * `onFailure` lets an endpoint turn a failure status into its own outcome (for example SaveCallFile's
   * `call_closed`) before the generic classification of integration.md §4.6 applies.
   */
  async function call<T, X extends { kind: string } = never>(
    endpoint: Endpoint,
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; idempotencyKey?: string; timeoutMs: number },
    onSuccess: (statusCode: number, json: Record<string, unknown>) => CoreResult<T>,
    logFields: Record<string, unknown> = {},
    onFailure?: (statusCode: number) => X | undefined,
  ): Promise<CoreResult<T> | X> {
    const started = performance.now();
    const raw = await send(path, init);
    const seconds = (performance.now() - started) / 1000;

    let result: CoreResult<T> | X;
    let requestId: string | undefined;
    if (raw.type === 'response' && raw.statusCode >= 200 && raw.statusCode < 300) {
      const json = parseJson(raw.text);
      if (!isObject(json)) {
        result = { kind: 'retryable', reason: `HTTP ${raw.statusCode} with invalid JSON` };
      } else {
        if (typeof json.RequestId === 'string') requestId = json.RequestId;
        result = onSuccess(raw.statusCode, json);
      }
    } else {
      const custom = raw.type === 'response' ? onFailure?.(raw.statusCode) : undefined;
      result = custom ?? classifyFailure(raw);
    }
    requestId ??= headerRequestId(raw);
    if (result.kind === 'ok' && requestId !== undefined) result = { ...(result as CoreResult<T>), requestId } as CoreResult<T>;

    deps.metrics.inc(METRICS.coreCalls, { endpoint, result: result.kind });
    deps.metrics.observe(METRICS.coreLatency, seconds, { endpoint });
    const fields = {
      ...logFields,
      endpoint,
      httpStatus: raw.type === 'response' ? raw.statusCode : undefined,
      result: result.kind,
      reason: result.kind === 'retryable' ? (result as { reason: string }).reason : undefined,
      requestId,
      durationMs: Math.round(seconds * 1000),
    };
    if (result.kind === 'ok') deps.log.info(fields, 'core call');
    else if (result.kind === 'auth' || result.kind === 'rejected') deps.log.error(fields, 'core call failed');
    else deps.log.warn(fields, 'core call failed');
    return result;
  }

  /** Envelope reads: 200 with Status success / not_found (integration.md §3). */
  function read<T>(
    endpoint: Endpoint,
    path: string,
    onEnvelope: (json: Record<string, unknown>) => CoreResult<T>,
    logFields?: Record<string, unknown>,
  ): Promise<CoreResult<T>> {
    return call(
      endpoint,
      path,
      { method: 'GET', timeoutMs: READ_TIMEOUT_MS },
      (_statusCode, json) => {
        if (json.Status !== 'success' && json.Status !== 'not_found') {
          return {
            kind: 'retryable',
            reason: `unexpected envelope Status ${String(json.Status).slice(0, 40)}`,
          };
        }
        return onEnvelope(json);
      },
      logFields,
    );
  }

  return {
    saveCall(input, submissionId, opts) {
      const body = JSON.stringify(buildSaveCallBody(input));
      return call(
        'SaveCall',
        'Calls/SaveCall',
        {
          method: 'POST',
          body,
          idempotencyKey: submissionId,
          timeoutMs: opts?.timeoutMs ?? SAVE_CALL_TIMEOUT_MS,
        },
        (statusCode, json) => {
          if (statusCode !== 200 && statusCode !== 201) {
            return { kind: 'retryable', reason: `unexpected HTTP ${statusCode}` };
          }
          const id = json.Id;
          if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
            return { kind: 'retryable', reason: 'success without Id' };
          }
          return { kind: 'ok', data: { callId: String(id) } };
        },
        { receiptId: submissionId },
      );
    },

    getCall(callId) {
      return read(
        'GetCall',
        `Calls/GetCall?callId=${encodeURIComponent(callId)}`,
        (json) => {
          if (json.Status === 'success' && !isObject(json.Data)) {
            return { kind: 'retryable', reason: 'success without Data' };
          }
          return { kind: 'ok', data: mapCallState(json) };
        },
        { callId },
      );
    },

    getPendingCalls() {
      return read('GetPendingCalls', 'Calls/GetPendingCalls', (json) => {
        const data = json.Data;
        if (json.Status === 'not_found' || data === null || data === undefined) {
          return { kind: 'ok', data: { callIds: [] } };
        }
        if (!Array.isArray(data)) return { kind: 'retryable', reason: 'Data is not an array' };
        const callIds: string[] = [];
        for (const c of data) {
          const id = isObject(c) ? c.CallId : undefined;
          if (typeof id === 'string' || typeof id === 'number') callIds.push(String(id));
        }
        return { kind: 'ok', data: { callIds } };
      });
    },

    getCallTypes() {
      return read('GetAllCallTypes', 'CallTypes/GetAllCallTypes', (json) => {
        if (json.Status === 'success' && !Array.isArray(json.Data)) {
          return { kind: 'retryable', reason: 'Data is not an array' };
        }
        const data = Array.isArray(json.Data) ? json.Data : [];
        const names: string[] = [];
        for (const t of data) {
          if (!isObject(t) || typeof t.Name !== 'string') continue;
          // "No Type" (id 0) is always present and is not a real type (integration.md §6.1).
          if (String(t.Id) === '0') continue;
          names.push(t.Name);
        }
        return { kind: 'ok', data: { names } };
      });
    },

    getCallPriorities() {
      return read('GetAllCallPriorites', 'CallPriorities/GetAllCallPriorites', (json) => {
        if (json.Status === 'success' && !Array.isArray(json.Data)) {
          return { kind: 'retryable', reason: 'Data is not an array' };
        }
        const data = Array.isArray(json.Data) ? json.Data : [];
        const priorities: CallPriority[] = [];
        for (const p of data) {
          if (!isObject(p)) continue;
          const id = typeof p.Id === 'number' ? p.Id : Number(p.Id);
          if (!Number.isInteger(id)) continue;
          priorities.push({ id, isDeleted: p.IsDeleted === true });
        }
        return { kind: 'ok', data: { priorities } };
      });
    },

    saveCallFile(input, opts) {
      // The body holds the audio. It is never logged: logFields below names the call and file only.
      const body = JSON.stringify({
        CallId: input.callId,
        UserId: SAVE_CALL_FILE_USER_ID,
        Type: 1,
        Name: input.name,
        Data: input.data.toString('base64'),
      });
      return call(
        'SaveCallFile',
        'CallFiles/SaveCallFile',
        { method: 'POST', body, timeoutMs: opts?.timeoutMs ?? SAVE_CALL_FILE_TIMEOUT_MS },
        (statusCode, json) => {
          if (statusCode !== 200 && statusCode !== 201) {
            return { kind: 'retryable', reason: `unexpected HTTP ${statusCode}` };
          }
          const id = json.Id;
          if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
            return { kind: 'retryable', reason: 'success without Id' };
          }
          return { kind: 'ok', data: { fileId: String(id) } };
        },
        { callId: input.callId, bytes: input.data.length },
        // Core's answer for a call that is not active or pending is not documented. 400 (refused) and
        // 404 / 410 (call gone) are read as closed; the live checklist prints the real answer.
        (statusCode) => (CALL_CLOSED_STATUSES.has(statusCode) ? { kind: 'call_closed' as const } : undefined),
      );
    },

    getAllUnitStatuses() {
      return read('GetAllUnitStatuses', 'UnitStatus/GetAllUnitStatuses', (json) => {
        if (json.Status === 'success' && !Array.isArray(json.Data)) {
          return { kind: 'retryable', reason: 'Data is not an array' };
        }
        const data = Array.isArray(json.Data) ? json.Data : [];
        const units: CoreUnitStatus[] = [];
        for (const row of data) {
          const unit = mapUnitStatus(row);
          if (unit !== null) units.push(unit);
        }
        return { kind: 'ok', data: { units } };
      });
    },

    getFieldPolicy() {
      return read('GetNewCallFieldPolicy', 'Calls/GetNewCallFieldPolicy', (json) => {
        if (json.Status === 'not_found') return { kind: 'ok', data: { requiredKeys: [] } };
        if (!isObject(json.Data)) return { kind: 'retryable', reason: 'success without Data' };
        const rules = json.Data.Rules;
        if (rules !== undefined && rules !== null && !Array.isArray(rules)) {
          return { kind: 'retryable', reason: 'Rules is not an array' };
        }
        const requiredKeys: string[] = [];
        for (const r of rules ?? []) {
          if (isObject(r) && r.Required === true && typeof r.Key === 'string') requiredKeys.push(r.Key);
        }
        return { kind: 'ok', data: { requiredKeys } };
      });
    },
  };
}
