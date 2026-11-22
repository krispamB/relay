/**
 * A mock of the Resgrid Core v4 API, as documented in integration.md.
 * It reproduces the documented behaviour, including the odd parts: success is 201, "not found" is
 * HTTP 200 with Status "not_found", fields are PascalCase, error bodies are not in the envelope,
 * and `GetAllCallPriorites` is misspelled.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type Scope = 'calls.create' | 'calls.read' | 'calls.update' | 'reference.read' | 'units.read';

/** What the relay's key holds (docs/live-sos-plan.md §2.1, minus calls.close). */
const DEFAULT_SCOPES: Scope[] = [
  'calls.create',
  'calls.read',
  'calls.update',
  'reference.read',
  'units.read',
];

const ENDPOINT_DEFS = [
  { name: 'Calls/SaveCall', method: 'POST', scope: 'calls.create' },
  { name: 'Calls/GetCall', method: 'GET', scope: 'calls.read' },
  { name: 'Calls/GetPendingCalls', method: 'GET', scope: 'calls.read' },
  { name: 'Calls/GetNewCallFieldPolicy', method: 'GET', scope: 'calls.read' },
  { name: 'CallTypes/GetAllCallTypes', method: 'GET', scope: 'reference.read' },
  { name: 'CallPriorities/GetAllCallPriorites', method: 'GET', scope: 'reference.read' },
  { name: 'CallFiles/SaveCallFile', method: 'POST', scope: 'calls.update' },
  { name: 'UnitStatus/GetAllUnitStatuses', method: 'GET', scope: 'units.read' },
] as const;

type EndpointDef = (typeof ENDPOINT_DEFS)[number];
/** An endpoint name relative to `/api/v4/` (case-insensitive when passed in), or `'*'` for all. */
export type MockEndpoint = EndpointDef['name'] | '*';

export interface CallTypeEntry {
  Id: string;
  Name: string;
  BaseType: number;
}

export interface PriorityEntry {
  Id: number;
  DepartmentId: number;
  Name: string;
  Color: string;
  Sort: number;
  IsDeleted: boolean;
  IsDefault: boolean;
  Tone: number;
  BaseType: number;
}

export interface PolicyRule {
  Key: string;
  Visible: boolean;
  Required: boolean;
}

export type DeletedCallBehavior = 'not_found' | 'last_state';

/** What is stored for a call. `Data` in GetCall is this minus the mock-only fields. */
export interface StoredCall {
  CallId: string;
  Priority: number;
  Name: string;
  Nature: string;
  /** The matched call type name, or null when `Type` was absent, unknown or "No Type". */
  Type: string | null;
  TypeId: string;
  State: number;
  Geolocation: string | null;
  Address: string | null;
  ContactName: string | null;
  ContactInfo: string | null;
  ExternalId: string | null;
  ReferenceId: string | null;
  Note: string | null;
  LoggedOnUtc: string;
  DispatchedOnUtc: string | null;
  NotesCount: number;
  // Mock-only bookkeeping, never part of an API response:
  /** The State the call was created with: 8 for IsPending=true, else 0. */
  InitialState: number;
  IsPending: boolean;
  IdempotencyKey: string | null;
  Deleted: boolean;
}

/** A file attached with SaveCallFile. The bytes are not kept, only their decoded size. */
export interface StoredCallFile {
  /** The attachment id returned by SaveCallFile. */
  Id: string;
  CallId: string;
  Name: string;
  Type: number;
  UserId: string;
  /** Decoded size of Data in bytes. */
  Size: number;
  SavedAtUtc: string;
}

/**
 * One scripted row of GetAllUnitStatuses, returned exactly as given so a test can send strings,
 * nulls or numbers. Core's fields (v4 swagger UnitStatusResultData): UnitId, Name, Type, State,
 * StateId, StateCss, StateStyle, Timestamp, TimestampUtc, DestinationId, DestinationType,
 * DestinationName, DestinationAddress, DestinationTypeName, Note, Latitude, Longitude, GroupName, GroupId.
 */
export type UnitStatusRow = Record<string, unknown>;

export interface RecordedRequest {
  seq: number;
  receivedAt: string;
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /** Parsed JSON body; the raw string when it is not valid JSON; undefined when empty. */
  body: unknown;
  rawBody: string | undefined;
  /** Canonical endpoint name, or null for unknown paths. */
  endpoint: string | null;
  /** The HTTP status sent, or null while in flight or when the connection was dropped. */
  status: number | null;
  /** True when an injected fault applied to this request. */
  faulted: boolean;
}

export interface Fault {
  /** Respond with this HTTP status instead of the real response. */
  status?: number;
  /** Body for the faulted response: a string is sent as text/plain, an object as JSON, none = empty. */
  body?: string | object;
  headers?: Record<string, string>;
  /** Sets the Retry-After header (seconds or an HTTP date). */
  retryAfter?: number | string;
  /** Wait this long first. With neither `status` nor `drop` the request is then processed normally. */
  delayMs?: number;
  /** Destroy the connection without a response. */
  drop?: boolean;
  /**
   * Process the request for real (SaveCall: create the call and complete the idempotency claim)
   * and only then fail it. Simulates "Core saved the call, but the response never arrived".
   */
  afterProcessing?: boolean;
}

export interface MockCoreOptions {
  apiKey?: string;
  scopes?: Scope[];
  /** The list GetAllUnitStatuses returns at start-up and after a reset (default none). */
  unitStatuses?: UnitStatusRow[];
  /** Names (ids are assigned from 12) or full entries. "No Type" is always added. */
  callTypes?: Array<string | { Id?: string | number; Name: string; BaseType?: number }>;
  priorities?: Array<Partial<PriorityEntry> & { Id: number; Name: string }>;
  fieldPolicy?: Array<{ Key: string; Visible?: boolean; Required?: boolean }>;
  deletedCallBehavior?: DeletedCallBehavior;
  /** How long an in-progress idempotency claim blocks retries (default 5 minutes). */
  claimTtlMs?: number;
  /** Id of the first call created (default 1000). */
  firstCallId?: number;
  /** Called with one line per handled request (no API key in it). */
  logRequest?: (line: string) => void;
  /** Used by startMockCore. Default 0 (ephemeral). */
  port?: number;
  /** Used by startMockCore. Default 127.0.0.1. */
  host?: string;
}

export interface MockCoreControl {
  /** All stored calls, oldest first. Deleted calls are left out unless asked for. */
  calls(opts?: { includeDeleted?: boolean }): StoredCall[];
  getCall(id: number | string): StoredCall | undefined;
  /** Every request received on /api/v4, oldest first. */
  requests(filter?: { endpoint?: MockEndpoint; method?: string }): RecordedRequest[];
  clearRequests(): void;
  /** Simulates a dispatcher: 0 dispatch, 1..7 close variants, 8 back to pending. Throws if unknown. */
  setCallState(id: number | string, state: number): StoredCall;
  /** Simulates a dispatcher deleting the call. See setDeletedCallBehavior. */
  deleteCall(id: number | string): void;
  setCallTypes(types: NonNullable<MockCoreOptions['callTypes']>): void;
  setPriorities(priorities: NonNullable<MockCoreOptions['priorities']>): void;
  setFieldPolicy(rules: NonNullable<MockCoreOptions['fieldPolicy']>): void;
  /** Files attached with SaveCallFile, oldest first, optionally for one call. */
  files(filter?: { callId?: string | number }): StoredCallFile[];
  /** The scripted GetAllUnitStatuses list. */
  unitStatuses(): UnitStatusRow[];
  /** Replaces the list GetAllUnitStatuses returns (empty = Core's `not_found`). */
  setUnitStatuses(rows: UnitStatusRow[]): void;
  /** Replaces the scopes granted to the key, e.g. `setScopes(['calls.read', 'reference.read'])`. */
  setScopes(scopes: Scope[]): void;
  setApiKey(key: string): void;
  /** What GetCall returns for a deleted call: 'not_found' (default) or the call with its last State. */
  setDeletedCallBehavior(mode: DeletedCallBehavior): void;
  /** Makes the next `count` (default 1) requests to `endpoint` ('*' = any) misbehave. */
  injectFault(endpoint: MockEndpoint, fault: Fault, count?: number): void;
  clearFaults(): void;
  /** Number of injected faults not yet consumed. */
  pendingFaults(): number;
  /** Back to the options given at creation: no calls, no requests, no faults, no idempotency keys. */
  reset(): void;
}

export interface MockCore {
  app: FastifyInstance;
  control: MockCoreControl;
}

export interface RunningMockCore {
  url: string;
  app: FastifyInstance;
  control: MockCoreControl;
  close(): Promise<void>;
}

export const DEFAULT_API_KEY = `rgk_AbCdEfGh_${'s'.repeat(43)}`;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Out {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function lc(s: string): string {
  return s.toLowerCase();
}

function findEndpoint(name: string): EndpointDef | undefined {
  return ENDPOINT_DEFS.find((d) => lc(d.name) === lc(name));
}

function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** A real, usable "lat,lon" point. Not "," or "0,0". */
function isRealPoint(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) return false;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(lat === 0 && lon === 0);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function redactFileData(record: RecordedRequest): void {
  const body = record.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (lc(k) === 'data' && typeof o[k] === 'string') o[k] = `[${(o[k] as string).length} base64 chars]`;
    }
    record.rawBody = JSON.stringify(o);
  } else {
    record.rawBody = undefined;
    record.body = undefined;
  }
}

/** Strict base64 (standard alphabet, padded). Core's model binder rejects anything else. */
function decodeBase64(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v === '' || v.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null;
  return Buffer.from(v, 'base64');
}

function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const base = lc(ct.split(';')[0]!.trim());
  return base === 'application/json' || base === 'text/json' || /^application\/.+\+json$/.test(base);
}

/** Property access that ignores case, like Core's JSON reader. */
class Body {
  private readonly map = new Map<string, unknown>();
  constructor(obj: Record<string, unknown>) {
    for (const [k, v] of Object.entries(obj)) this.map.set(lc(k), v);
  }
  has(name: string): boolean {
    return this.map.has(lc(name));
  }
  get(name: string): unknown {
    return this.map.get(lc(name));
  }
}

/** Keys the policy can require, mapped to how the body satisfies them. */
function missingPolicyFields(body: Body, rules: PolicyRule[]): string[] {
  const missing: string[] = [];
  const plain: Record<string, string> = {
    note: 'Note',
    externalId: 'ExternalId',
    referenceId: 'ReferenceId',
    contactInfo: 'ContactInfo',
    contactName: 'ContactName',
    address: 'Address',
    what3words: 'What3Words',
    incidentId: 'IncidentId',
    destinationPoi: 'DestinationPoiId',
  };
  const onlyWhenPresent: Record<string, string> = {
    protocols: 'ProtocolIds',
    linkedCall: 'LinkedCallId',
    indoorLocation: 'IndoorMapZoneId',
  };
  for (const rule of rules) {
    if (!rule.Required) continue;
    const key = rule.Key;
    if (key === 'geolocation') {
      if (!isRealPoint(body.get('Geolocation'))) missing.push(key);
    } else if (plain[key]) {
      if (isBlank(body.get(plain[key]))) missing.push(key);
    } else if (onlyWhenPresent[key]) {
      // Enforced only when the key is present in the body (integration.md section 4.3).
      if (body.has(onlyWhenPresent[key]) && isBlank(body.get(onlyWhenPresent[key]))) missing.push(key);
    }
    // dispatchOn, dispatchList: not enforced for pending calls. pluscode: can never be required.
  }
  return missing;
}

interface Ctx {
  record: RecordedRequest;
  startedAt: number;
}

// ---------------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------------

export function createMockCore(options: MockCoreOptions = {}): MockCore {
  const app = Fastify({
    logger: false,
    routerOptions: { caseSensitive: false },
    forceCloseConnections: true,
  });

  // --- mutable state ---
  let apiKey = options.apiKey ?? DEFAULT_API_KEY;
  let scopes = new Set<Scope>(options.scopes ?? DEFAULT_SCOPES);
  let callTypes: CallTypeEntry[] = [];
  let priorities: PriorityEntry[] = [];
  let rules: PolicyRule[] = [];
  let deletedBehavior: DeletedCallBehavior = options.deletedCallBehavior ?? 'not_found';
  const claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
  const firstCallId = options.firstCallId ?? 1000;
  let nextCallId = firstCallId;
  let calls = new Map<number, StoredCall>();
  let files: StoredCallFile[] = [];
  let nextFileId = 5000;
  /** SaveCallFile Idempotency-Key → the file id it created. */
  let fileKeys = new Map<string, string>();
  let units: UnitStatusRow[] = [];
  let requestLog: RecordedRequest[] = [];
  let seq = 0;
  let epoch = 0;
  let faults: Array<{ endpoint: string; fault: Fault; remaining: number }> = [];
  let claims = new Map<string, { state: 'in_progress' | 'done'; callId: number | null; claimedAt: number }>();
  const ctxs = new WeakMap<FastifyRequest, Ctx>();
  const sleepers = new Set<() => void>();

  // --- configuration helpers ---
  function normalizeTypes(input: NonNullable<MockCoreOptions['callTypes']>): CallTypeEntry[] {
    let nextId = 12;
    return input
      .filter((t) => (typeof t === 'string' ? t : t.Name) !== 'No Type')
      .map((t) => {
        if (typeof t === 'string') return { Id: String(nextId++), Name: t, BaseType: 0 };
        return {
          Id: t.Id !== undefined ? String(t.Id) : String(nextId++),
          Name: t.Name,
          BaseType: t.BaseType ?? 0,
        };
      });
  }
  function normalizePriorities(input: NonNullable<MockCoreOptions['priorities']>): PriorityEntry[] {
    return input.map((p, i) => ({
      DepartmentId: 41,
      Color: '#ff0000',
      Sort: i + 1,
      IsDeleted: false,
      IsDefault: false,
      Tone: 0,
      BaseType: 0,
      ...p,
    }));
  }
  function normalizeRules(input: NonNullable<MockCoreOptions['fieldPolicy']>): PolicyRule[] {
    return input.map((r) => ({ Key: r.Key, Visible: r.Visible ?? true, Required: r.Required ?? false }));
  }
  function applyInitialConfig(): void {
    apiKey = options.apiKey ?? DEFAULT_API_KEY;
    scopes = new Set<Scope>(options.scopes ?? DEFAULT_SCOPES);
    units = (options.unitStatuses ?? []).map((u) => ({ ...u }));
    callTypes = normalizeTypes(options.callTypes ?? []);
    priorities = normalizePriorities(options.priorities ?? []);
    rules = normalizeRules(options.fieldPolicy ?? []);
    deletedBehavior = options.deletedCallBehavior ?? 'not_found';
  }
  applyInitialConfig();

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      sleepers.add(done);
    });
  }
  app.addHook('onClose', async () => {
    for (const wake of [...sleepers]) wake();
  });

  // --- response building ---
  function envelope(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const trace = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`;
    return {
      PageSize: 0,
      Page: 0,
      Timestamp: new Date().toISOString(),
      Version: 'v4',
      Node: 'mock-core',
      Environment: 'Mock',
      RequestId: trace,
      Status: status,
      PreviousPageUrl: null,
      NextPageUrl: null,
      ...extra,
    };
  }

  function callData(c: StoredCall): Record<string, unknown> {
    return {
      CallId: c.CallId,
      Priority: c.Priority,
      Name: c.Name,
      Nature: c.Nature,
      Type: c.Type ?? '',
      TypeId: c.TypeId,
      State: c.State,
      Geolocation: c.Geolocation,
      Address: c.Address,
      ContactName: c.ContactName,
      ContactInfo: c.ContactInfo,
      ExternalId: c.ExternalId,
      ReferenceId: c.ReferenceId,
      Note: c.Note,
      NotesCount: c.NotesCount,
      LoggedOnUtc: c.LoggedOnUtc,
      DispatchedOnUtc: c.DispatchedOnUtc,
    };
  }

  async function send(reply: FastifyReply, out: Out): Promise<FastifyReply> {
    reply.code(out.status);
    for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
    if (out.json !== undefined)
      return reply.type('application/json; charset=utf-8').send(JSON.stringify(out.json));
    if (out.text !== undefined) return reply.type('text/plain; charset=utf-8').send(out.text);
    return reply.send();
  }

  function faultOut(f: Fault): Out {
    const headers: Record<string, string> = { ...(f.headers ?? {}) };
    if (f.retryAfter !== undefined) headers['Retry-After'] = String(f.retryAfter);
    const out: Out = { status: f.status ?? 500, headers };
    if (typeof f.body === 'string') out.text = f.body;
    else if (f.body !== undefined) out.json = f.body;
    return out;
  }

  function dropConnection(req: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    req.raw.socket.destroy();
  }

  function takeFault(def: EndpointDef): Fault | undefined {
    const idx = faults.findIndex((f) => f.endpoint === lc(def.name));
    const i = idx >= 0 ? idx : faults.findIndex((f) => f.endpoint === '*');
    const entry = faults[i];
    if (!entry) return undefined;
    entry.remaining -= 1;
    if (entry.remaining <= 0) faults.splice(i, 1);
    return entry.fault;
  }

  function authenticate(req: FastifyRequest, scope: Scope): Out | null {
    const h = req.headers;
    if (h['x-resgrid-apikey'] !== apiKey) return { status: 401 };
    // A key sent next to another credential is refused.
    if (h.authorization !== undefined || h['x-resgrid-systemapikey'] !== undefined) return { status: 401 };
    if (!scopes.has(scope)) return { status: 403 };
    return null;
  }

  function requireCtx(req: FastifyRequest): Ctx {
    const ctx = ctxs.get(req);
    if (!ctx) throw new Error('request context missing');
    return ctx;
  }

  /**
   * Wraps an endpoint: injected faults, auth, then `inner`. `inner` calls `delay()` at the point
   * where an injected delay should hold the request (after an idempotency claim, for SaveCall).
   */
  function endpoint(
    def: EndpointDef,
    inner: (req: FastifyRequest, delay: () => Promise<void>) => Promise<Out>,
  ) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const raw = req.body as Buffer | undefined;
      if (raw && raw.length > 0) {
        ctx.record.rawBody = raw.toString('utf8');
        try {
          ctx.record.body = JSON.parse(ctx.record.rawBody);
        } catch {
          ctx.record.body = ctx.record.rawBody;
        }
        // Keep the log small and free of the audio: the file's size is in control.files().
        if (def.name === 'CallFiles/SaveCallFile') redactFileData(ctx.record);
      }
      const fault = takeFault(def);
      if (fault) ctx.record.faulted = true;
      const failing = fault !== undefined && (fault.status !== undefined || fault.drop === true);

      if (fault && failing && !fault.afterProcessing) {
        if (fault.delayMs) await sleep(fault.delayMs);
        if (fault.drop) {
          dropConnection(req, reply);
          return reply;
        }
        return send(reply, faultOut(fault));
      }

      let delayed = false;
      const delay = async () => {
        if (fault?.delayMs && !delayed) {
          delayed = true;
          await sleep(fault.delayMs);
        }
      };

      const denied = authenticate(req, def.scope);
      if (denied) return send(reply, denied);

      const out = await inner(req, delay);
      // A delay-only fault on an endpoint that never reached its delay point still applies.
      await delay();

      if (fault && failing) {
        if (fault.drop) {
          dropConnection(req, reply);
          return reply;
        }
        return send(reply, faultOut(fault));
      }
      return send(reply, out);
    };
  }

  // --- request recording and logging ---
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (lc(path).startsWith('/__control')) return;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const lower = lc(path);
    const def = ENDPOINT_DEFS.find((d) => lower === lc(`/api/v4/${d.name}`));
    const record: RecordedRequest = {
      seq: ++seq,
      receivedAt: new Date().toISOString(),
      method: req.method,
      path,
      query: {},
      headers,
      body: undefined,
      rawBody: undefined,
      endpoint: def?.name ?? null,
      status: null,
      faulted: false,
    };
    requestLog.push(record);
    ctxs.set(req, { record, startedAt: Date.now() });
  });

  app.addHook('preHandler', async (req) => {
    const ctx = ctxs.get(req);
    if (ctx) {
      for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
        ctx.record.query[k] = String(v);
      }
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = ctxs.get(req);
    if (!ctx) return;
    ctx.record.status = reply.statusCode;
    options.logRequest?.(
      `${ctx.record.method} ${req.url} -> ${reply.statusCode} ${Date.now() - ctx.startedAt}ms${
        ctx.record.faulted ? ' [fault]' : ''
      }`,
    );
  });
  // A dropped connection never reaches onResponse; log it from the close event.
  app.addHook('onRequestAbort', async (req) => {
    const ctx = ctxs.get(req);
    if (ctx && ctx.record.status === null) {
      options.logRequest?.(
        `${ctx.record.method} ${req.url} -> aborted ${Date.now() - ctx.startedAt}ms${ctx.record.faulted ? ' [fault]' : ''}`,
      );
    }
  });

  // --- SaveCall ---
  const saveCallDef = ENDPOINT_DEFS[0];
  app.post(
    `/api/v4/${saveCallDef.name}`,
    endpoint(saveCallDef, async (req, delay) => {
      if (!isJsonContentType(req.headers['content-type'])) return { status: 415 };

      const buf = req.body as Buffer | undefined;
      let parsed: unknown;
      try {
        if (!buf || buf.length === 0) throw new Error('empty');
        parsed = JSON.parse(buf.toString('utf8'));
      } catch {
        return { status: 400 };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 400 };
      const body = new Body(parsed as Record<string, unknown>);

      const created = (callId: number): Out => ({
        status: 201,
        json: envelope('created', { Id: String(callId) }),
        headers: {
          Location: `http://${req.headers.host ?? 'localhost'}/api/v4/Calls/GetCall?callId=${callId}`,
        },
      });

      // Idempotency (section 4.5). The body is deliberately not compared on a repeat.
      const rawKey = req.headers['idempotency-key'];
      const key = typeof rawKey === 'string' && rawKey.trim() !== '' ? rawKey.trim() : null;
      if (key) {
        const claim = claims.get(key);
        if (claim) {
          if (claim.state === 'done' && claim.callId !== null) return created(claim.callId);
          if (claim.state === 'in_progress' && Date.now() - claim.claimedAt < claimTtlMs)
            return { status: 409 };
          // A claim held by a crashed request is released after the TTL: process as new.
        }
        claims.set(key, { state: 'in_progress', callId: null, claimedAt: Date.now() });
      }
      const release = () => {
        if (key) claims.delete(key);
      };
      const myEpoch = epoch;

      try {
        await delay();
        if (myEpoch !== epoch) return { status: 503 }; // the mock was reset while this was in flight

        // Validation: Priority, Name, Nature.
        const priority = body.get('Priority');
        const priorityOk =
          (typeof priority === 'number' && Number.isInteger(priority)) ||
          (typeof priority === 'string' && /^-?\d+$/.test(priority.trim()));
        const name = body.get('Name');
        const nature = body.get('Nature');
        if (
          !priorityOk ||
          typeof name !== 'string' ||
          name.trim() === '' ||
          typeof nature !== 'string' ||
          nature.trim() === ''
        ) {
          release();
          return { status: 400 };
        }

        // Field policy (section 7).
        const missing = missingPolicyFields(body, rules);
        if (missing.length > 0) {
          release();
          return { status: 400, text: `Required call fields are missing: ${missing.join(', ')}` };
        }

        const isPending = body.get('IsPending') === true || body.get('IsPending') === 'true';
        const typeName = body.get('Type');
        const matchedType =
          typeof typeName === 'string' ? callTypes.find((t) => t.Name === typeName) : undefined;
        const now = new Date().toISOString();
        const id = nextCallId++;
        const call: StoredCall = {
          CallId: String(id),
          Priority: Number(typeof priority === 'string' ? priority.trim() : priority),
          Name: name,
          Nature: nature,
          Type: matchedType?.Name ?? null,
          TypeId: matchedType?.Id ?? '0',
          State: isPending ? 8 : 0,
          Geolocation: strOrNull(body.get('Geolocation')),
          Address: strOrNull(body.get('Address')),
          ContactName: strOrNull(body.get('ContactName')),
          ContactInfo: strOrNull(body.get('ContactInfo')),
          ExternalId: strOrNull(body.get('ExternalId')),
          ReferenceId: strOrNull(body.get('ReferenceId')),
          Note: strOrNull(body.get('Note')),
          LoggedOnUtc: now,
          DispatchedOnUtc: isPending ? null : now,
          NotesCount: 0,
          InitialState: isPending ? 8 : 0,
          IsPending: isPending,
          IdempotencyKey: key,
          Deleted: false,
        };
        calls.set(id, call);
        if (key) claims.set(key, { state: 'done', callId: id, claimedAt: Date.now() });
        return created(id);
      } catch (err) {
        release();
        throw err;
      }
    }),
  );

  // --- GetCall ---
  const getCallDef = ENDPOINT_DEFS[1];
  app.get(
    `/api/v4/${getCallDef.name}`,
    endpoint(getCallDef, async (req, delay) => {
      await delay();
      const q = (req.query ?? {}) as Record<string, unknown>;
      const k = Object.keys(q).find((x) => lc(x) === 'callid');
      const raw = k !== undefined ? q[k] : undefined;
      if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return { status: 400 };
      const call = calls.get(Number(raw.trim()));
      if (!call || (call.Deleted && deletedBehavior === 'not_found')) {
        return { status: 200, json: envelope('not_found', { Data: null }) };
      }
      return { status: 200, json: envelope('success', { Data: callData(call) }) };
    }),
  );

  // --- GetPendingCalls ---
  const pendingDef = ENDPOINT_DEFS[2];
  app.get(
    `/api/v4/${pendingDef.name}`,
    endpoint(pendingDef, async (_req, delay) => {
      await delay();
      const pending = [...calls.values()]
        .filter((c) => c.State === 8 && !c.Deleted)
        .sort((a, b) => Number(a.CallId) - Number(b.CallId));
      if (pending.length === 0) return { status: 200, json: envelope('not_found', { Data: [] }) };
      return { status: 200, json: envelope('success', { Data: pending.map(callData) }) };
    }),
  );

  // --- GetNewCallFieldPolicy ---
  const policyDef = ENDPOINT_DEFS[3];
  app.get(
    `/api/v4/${policyDef.name}`,
    endpoint(policyDef, async (_req, delay) => {
      await delay();
      return { status: 200, json: envelope('success', { Data: { Rules: rules } }) };
    }),
  );

  // --- Reference data ---
  const typesDef = ENDPOINT_DEFS[4];
  app.get(
    `/api/v4/${typesDef.name}`,
    endpoint(typesDef, async (_req, delay) => {
      await delay();
      const data = [{ Id: '0', Name: 'No Type', BaseType: 0 }, ...callTypes];
      return {
        status: 200,
        json: envelope(callTypes.length === 0 ? 'not_found' : 'success', { Data: data }),
      };
    }),
  );
  const prioDef = ENDPOINT_DEFS[5];
  app.get(
    `/api/v4/${prioDef.name}`,
    endpoint(prioDef, async (_req, delay) => {
      await delay();
      return {
        status: 200,
        json: envelope(priorities.length === 0 ? 'not_found' : 'success', { Data: priorities }),
      };
    }),
  );

  // --- SaveCallFile ---
  // Measured against a live Core (live checklist, 2026-11-22):
  // - Idempotency-Key is honoured: the same key returns the same Id, and only one file is stored.
  // - A call that does not exist answers HTTP 200, Status "not_found", Id null.
  // Not yet measured: a closed call. The mock answers it with the swagger's 400 ProblemDetails; the
  // relay's client reads both answers as "closed".
  const fileDef = ENDPOINT_DEFS[6];
  app.post(
    `/api/v4/${fileDef.name}`,
    endpoint(fileDef, async (req, delay) => {
      if (!isJsonContentType(req.headers['content-type'])) return { status: 415 };
      const buf = req.body as Buffer | undefined;
      let parsed: unknown;
      try {
        if (!buf || buf.length === 0) throw new Error('empty');
        parsed = JSON.parse(buf.toString('utf8'));
      } catch {
        return { status: 400 };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 400 };
      const body = new Body(parsed as Record<string, unknown>);

      await delay();

      const callIdRaw = body.get('CallId');
      const callIdText = typeof callIdRaw === 'number' ? String(callIdRaw) : callIdRaw;
      const userId = body.get('UserId');
      const name = body.get('Name');
      const type = body.get('Type');
      const data = decodeBase64(body.get('Data'));
      if (
        typeof callIdText !== 'string' ||
        !/^-?\d+$/.test(callIdText.trim()) ||
        typeof userId !== 'string' ||
        userId.trim() === '' ||
        typeof name !== 'string' ||
        name.trim() === '' ||
        typeof type !== 'number' ||
        !Number.isInteger(type) ||
        data === null
      ) {
        return { status: 400 };
      }
      const call = calls.get(Number(callIdText.trim()));
      if (!call || call.Deleted) return { status: 200, json: envelope('not_found', { Id: null }) };
      const rawKey = req.headers['idempotency-key'];
      const key = typeof rawKey === 'string' && rawKey.trim() !== '' ? rawKey.trim() : null;
      const known = key === null ? undefined : fileKeys.get(key);
      if (known !== undefined) return { status: 201, json: envelope('created', { Id: known }) };
      if (call.State !== 0 && call.State !== 8) {
        return {
          status: 400,
          json: {
            type: null,
            title: 'Bad Request',
            status: 400,
            detail: 'The call is not active or pending.',
          },
        };
      }
      const id = String(nextFileId++);
      files.push({
        Id: id,
        CallId: call.CallId,
        Name: name,
        Type: type,
        UserId: userId,
        Size: data.length,
        SavedAtUtc: new Date().toISOString(),
      });
      if (key !== null) fileKeys.set(key, id);
      return { status: 201, json: envelope('created', { Id: id }) };
    }),
  );

  // --- GetAllUnitStatuses ---
  const unitsDef = ENDPOINT_DEFS[7];
  app.get(
    `/api/v4/${unitsDef.name}`,
    endpoint(unitsDef, async (_req, delay) => {
      await delay();
      return {
        status: 200,
        json: envelope(units.length === 0 ? 'not_found' : 'success', { Data: units }),
      };
    }),
  );

  // Any other /api/v4 path: the key only works on scoped endpoints, so it is ignored and the request gets 401.
  app.setNotFoundHandler(async (req, reply) => {
    if (lc(req.url).startsWith('/api/v4/')) return send(reply, { status: 401 });
    return send(reply, { status: 404, json: { error: 'not found' } });
  });

  // --- control handle ---
  function callOrThrow(id: number | string): StoredCall {
    const c = calls.get(Number(id));
    if (!c) throw new Error(`mock-core: no call with id ${id}`);
    return c;
  }

  const control: MockCoreControl = {
    calls: (opts) =>
      [...calls.values()].filter((c) => opts?.includeDeleted || !c.Deleted).map((c) => ({ ...c })),
    getCall: (id) => {
      const c = calls.get(Number(id));
      return c ? { ...c } : undefined;
    },
    requests: (filter) =>
      requestLog.filter(
        (r) =>
          (!filter?.endpoint ||
            filter.endpoint === '*' ||
            r.endpoint === findEndpoint(filter.endpoint)?.name) &&
          (!filter?.method || r.method === filter.method.toUpperCase()),
      ),
    clearRequests: () => {
      requestLog = [];
    },
    setCallState: (id, state) => {
      if (!Number.isInteger(state)) throw new Error('mock-core: state must be an integer');
      const c = callOrThrow(id);
      c.State = state;
      if (state === 0 && c.DispatchedOnUtc === null) c.DispatchedOnUtc = new Date().toISOString();
      return { ...c };
    },
    deleteCall: (id) => {
      callOrThrow(id).Deleted = true;
    },
    setCallTypes: (types) => {
      callTypes = normalizeTypes(types);
    },
    setPriorities: (p) => {
      priorities = normalizePriorities(p);
    },
    setFieldPolicy: (r) => {
      rules = normalizeRules(r);
    },
    files: (filter) =>
      files
        .filter((f) => filter?.callId === undefined || f.CallId === String(filter.callId))
        .map((f) => ({ ...f })),
    unitStatuses: () => units.map((u) => ({ ...u })),
    setUnitStatuses: (rows) => {
      if (!Array.isArray(rows) || rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) {
        throw new Error('mock-core: unit statuses must be an array of objects');
      }
      units = rows.map((r) => ({ ...r }));
    },
    setScopes: (s) => {
      scopes = new Set(s);
    },
    setApiKey: (key) => {
      apiKey = key;
    },
    setDeletedCallBehavior: (mode) => {
      deletedBehavior = mode;
    },
    injectFault: (endpointName, fault, count = 1) => {
      let name = '*';
      if (endpointName !== '*') {
        const def = findEndpoint(endpointName);
        if (!def) throw new Error(`mock-core: unknown endpoint ${endpointName}`);
        name = lc(def.name);
      }
      if (fault.status === undefined && fault.delayMs === undefined && !fault.drop) {
        throw new Error('mock-core: a fault needs status, delayMs or drop');
      }
      faults.push({ endpoint: name, fault, remaining: count });
    },
    clearFaults: () => {
      faults = [];
    },
    pendingFaults: () => faults.reduce((n, f) => n + f.remaining, 0),
    reset: () => {
      epoch += 1;
      calls = new Map();
      files = [];
      fileKeys = new Map();
      nextFileId = 5000;
      nextCallId = firstCallId;
      requestLog = [];
      faults = [];
      claims = new Map();
      applyInitialConfig();
    },
  };

  registerControlRoutes(app, control, {
    snapshot: () => ({
      apiKeySet: apiKey !== '',
      scopes: [...scopes],
      callTypes,
      priorities,
      fieldPolicy: { Rules: rules },
      deletedCallBehavior: deletedBehavior,
      calls: calls.size,
      files: files.length,
      unitStatuses: units.length,
      requests: requestLog.length,
      pendingFaults: control.pendingFaults(),
    }),
  });

  return { app, control };
}

// ---------------------------------------------------------------------------------------------
// Control over HTTP: /__control/...
// ---------------------------------------------------------------------------------------------

function registerControlRoutes(
  app: FastifyInstance,
  control: MockCoreControl,
  extra: { snapshot: () => unknown },
): void {
  const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: message });

  function json(req: FastifyRequest): { ok: true; value: unknown } | { ok: false } {
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { ok: false };
    }
  }
  function obj(req: FastifyRequest): Record<string, unknown> | null {
    const r = json(req);
    if (!r.ok || typeof r.value !== 'object' || r.value === null || Array.isArray(r.value)) return null;
    return r.value as Record<string, unknown>;
  }
  /** Runs `fn`, turning a thrown Error into a 400 (bad input or unknown id). */
  async function guard(reply: FastifyReply, fn: () => unknown) {
    try {
      const result = fn();
      return reply.send(result ?? { ok: true });
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : String(err));
    }
  }

  app.get('/__control/state', async () => extra.snapshot());
  app.post('/__control/reset', async (_req, reply) => guard(reply, () => control.reset()));

  app.get('/__control/calls', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return control.calls({ includeDeleted: q.includeDeleted === 'true' });
  });
  app.get('/__control/calls/:id', async (req, reply) => {
    const call = control.getCall((req.params as { id: string }).id);
    return call ?? reply.code(404).send({ error: 'no such call' });
  });
  app.post('/__control/calls/:id/state', async (req, reply) => {
    const b = obj(req);
    if (!b || typeof b.state !== 'number') return bad(reply, 'body must be {"state": <integer>}');
    return guard(reply, () => control.setCallState((req.params as { id: string }).id, b.state as number));
  });
  app.delete('/__control/calls/:id', async (req, reply) =>
    guard(reply, () => control.deleteCall((req.params as { id: string }).id)),
  );

  app.get('/__control/requests', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const filter: { endpoint?: MockEndpoint; method?: string } = {};
    if (q.endpoint) filter.endpoint = q.endpoint as MockEndpoint;
    if (q.method) filter.method = q.method;
    // The API key is redacted in this view; the in-process handle returns it as received.
    return control.requests(filter).map((r) => ({
      ...r,
      headers: Object.fromEntries(
        Object.entries(r.headers).map(([k, v]) => [
          k,
          k === 'x-resgrid-apikey' || k === 'authorization' ? '[redacted]' : v,
        ]),
      ),
    }));
  });
  app.delete('/__control/requests', async (_req, reply) => guard(reply, () => control.clearRequests()));

  app.put('/__control/call-types', async (req, reply) => {
    const r = json(req);
    if (!r.ok || !Array.isArray(r.value))
      return bad(reply, 'body must be an array of names or {Id, Name, BaseType}');
    return guard(reply, () => control.setCallTypes(r.value as never));
  });
  app.put('/__control/priorities', async (req, reply) => {
    const r = json(req);
    if (!r.ok || !Array.isArray(r.value)) return bad(reply, 'body must be an array of {Id, Name, ...}');
    return guard(reply, () => control.setPriorities(r.value as never));
  });
  app.put('/__control/field-policy', async (req, reply) => {
    const r = json(req);
    const rulesIn = r.ok
      ? Array.isArray(r.value)
        ? r.value
        : (r.value as { Rules?: unknown }).Rules
      : undefined;
    if (!Array.isArray(rulesIn)) return bad(reply, 'body must be an array of rules or {"Rules": [...]}');
    return guard(reply, () => control.setFieldPolicy(rulesIn as never));
  });
  app.get('/__control/files', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return control.files(q.callId === undefined ? undefined : { callId: q.callId });
  });
  app.put('/__control/unit-statuses', async (req, reply) => {
    const r = json(req);
    const list = r.ok
      ? Array.isArray(r.value)
        ? r.value
        : (r.value as { Units?: unknown }).Units
      : undefined;
    if (!Array.isArray(list)) return bad(reply, 'body must be an array of unit rows or {"Units": [...]}');
    return guard(reply, () => control.setUnitStatuses(list as UnitStatusRow[]));
  });
  app.put('/__control/scopes', async (req, reply) => {
    const r = json(req);
    const list = r.ok
      ? Array.isArray(r.value)
        ? r.value
        : (r.value as { scopes?: unknown }).scopes
      : undefined;
    if (!Array.isArray(list)) return bad(reply, 'body must be an array of scopes or {"scopes": [...]}');
    return guard(reply, () => control.setScopes(list as Scope[]));
  });
  app.put('/__control/api-key', async (req, reply) => {
    const b = obj(req);
    if (!b || typeof b.apiKey !== 'string') return bad(reply, 'body must be {"apiKey": "<key>"}');
    return guard(reply, () => control.setApiKey(b.apiKey as string));
  });
  app.put('/__control/deleted-call-behavior', async (req, reply) => {
    const b = obj(req);
    if (!b || (b.mode !== 'not_found' && b.mode !== 'last_state')) {
      return bad(reply, 'body must be {"mode": "not_found" | "last_state"}');
    }
    return guard(reply, () => control.setDeletedCallBehavior(b.mode as DeletedCallBehavior));
  });

  app.post('/__control/faults', async (req, reply) => {
    const b = obj(req);
    if (!b || typeof b.endpoint !== 'string') return bad(reply, 'body must include "endpoint" (or "*")');
    const { endpoint, count, ...fault } = b;
    return guard(reply, () =>
      control.injectFault(endpoint as MockEndpoint, fault as Fault, typeof count === 'number' ? count : 1),
    );
  });
  app.delete('/__control/faults', async (_req, reply) => guard(reply, () => control.clearFaults()));
}

// ---------------------------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------------------------

export async function startMockCore(options: MockCoreOptions = {}): Promise<RunningMockCore> {
  const { app, control } = createMockCore(options);
  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock-core: no listening address');
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${urlHost}:${addr.port}`,
    app,
    control,
    close: () => app.close(),
  };
}
