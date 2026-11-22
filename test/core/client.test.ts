import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import {
  buildSaveCallBody,
  createCoreClient,
  errorMessage,
  mapCallState,
  parseRetryAfter,
  SAVE_CALL_FIELDS,
} from '../../src/core/client.js';
import type { CoreClient, SaveCallInput } from '../../src/core/types.js';
import { type Labels, METRICS, type MetricName, type Metrics } from '../../src/metrics.js';

const API_KEY = `rgk_AbCdEfGh_${'k'.repeat(43)}`;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (req: Seen, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler;
const seen: Seen[] = [];

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

function envelope(extra: Record<string, unknown>) {
  return { PageSize: 0, Page: 0, Version: 'v4', RequestId: 'req-123', ...extra };
}

class RecordingMetrics implements Metrics {
  readonly incs: { name: MetricName; labels?: Labels }[] = [];
  readonly observed: { name: MetricName; labels?: Labels }[] = [];
  inc(name: MetricName, labels?: Labels) {
    this.incs.push({ name, labels });
  }
  observe(name: MetricName, _s: number, labels?: Labels) {
    this.observed.push({ name, labels });
  }
  set() {}
}

let logLines: string[];
let metrics: RecordingMetrics;
let client: CoreClient;

function makeClient(clock = new FakeClock()): CoreClient {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  return createCoreClient(
    { apiBase: `${base}/`, apiKey: API_KEY },
    { log: pino({ level: 'debug' }, stream), metrics, clock },
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  logLines = [];
  metrics = new RecordingMetrics();
  client = makeClient();
  handler = (_req, res) => reply(res, 500);
});

const call: SaveCallInput = {
  Priority: 3,
  Type: 'Public SOS',
  Name: '[PUBLIC SOS] Medical emergency',
  Nature: 'Medical emergency',
  Geolocation: '6.524400,3.379200',
  Address: '12 Marina Rd',
  ContactName: 'Ade',
  ContactInfo: '+2348012345678',
  ExternalId: 'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD',
  ReferenceId: 'SOS-7KQ2',
  Note: 'note',
};

describe('buildSaveCallBody (allowlist)', () => {
  it('contains only the twelve allowed keys, even when forbidden keys are smuggled in', () => {
    const smuggled = {
      ...call,
      LinkedCallId: '',
      ProtocolIds: [],
      IndoorMapZoneId: null,
      DispatchList: '0',
      DispatchOn: '2026-01-01',
      DispatchOnUtc: '2026-01-01',
      DepartmentId: 41,
      UdfValues: [],
      ContactId: 1,
      AdditionalContactIds: [],
      SubjectIdentifiers: [],
      Part2ConsentOnFile: true,
      IncidentId: 'x',
      DestinationPoiId: 1,
      IndoorMapFloorId: 1,
      What3Words: 'a.b.c',
      CheckInTimersEnabled: true,
      CallFormData: '{}',
      IsPending: false,
      isPending: false,
      name: 'lowercase',
    } as unknown as SaveCallInput;
    const body = buildSaveCallBody(smuggled);
    const allowed = new Set<string>(SAVE_CALL_FIELDS);
    for (const k of Object.keys(body)) expect(allowed.has(k), `unexpected key ${k}`).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...SAVE_CALL_FIELDS].sort());
    expect(body.IsPending).toBe(true);
  });

  it('has exactly the twelve fields of integration.md §4.2', () => {
    expect([...SAVE_CALL_FIELDS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('omits empty, null and undefined values instead of sending them', () => {
    const body = buildSaveCallBody({
      Priority: 3,
      Name: 'n',
      Nature: 'x',
      Type: '',
      Geolocation: undefined,
      Address: '   ',
      ContactName: null as unknown as string,
      Note: undefined,
    });
    expect(body).toEqual({ IsPending: true, Priority: 3, Name: 'n', Nature: 'x' });
    const json = JSON.stringify(body);
    expect(json).not.toContain('null');
    expect(json).not.toContain('""');
  });
});

describe('mapCallState (integration.md §5.3)', () => {
  const cases: [number, string, boolean][] = [
    [8, 'received', false],
    [0, 'dispatched', false],
    [1, 'closed', false],
    [2, 'closed', false],
    [3, 'closed', true],
    [4, 'closed', false],
    [5, 'closed', false],
    [6, 'closed', false],
    [7, 'closed', true],
  ];
  it.each(cases)('State %i → %s (hoax %s)', (state, status, hoax) => {
    expect(mapCallState({ Status: 'success', Data: { State: state } })).toEqual({
      notFound: false,
      state,
      status,
      hoax,
    });
  });
  it('not_found → closed', () => {
    expect(mapCallState({ Status: 'not_found', Data: null })).toEqual({
      notFound: true,
      status: 'closed',
      hoax: false,
    });
  });
  it('an unknown state keeps the last known status', () => {
    expect(mapCallState({ Status: 'success', Data: { State: 42 } })).toEqual({
      notFound: false,
      state: 42,
      status: undefined,
      hoax: false,
    });
    expect(mapCallState({ Status: 'success', Data: {} }).status).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Tue, 17 Nov 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
  it('reads error bodies defensively', () => {
    expect(errorMessage('')).toBe('');
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage('"a json string"')).toBe('a json string');
    expect(errorMessage('{"Message":"boom"}')).toBe('boom');
    expect(errorMessage('"unterminated')).toBe('"unterminated');
    expect(errorMessage('x'.repeat(900))).toHaveLength(500);
  });
});

describe('saveCall request', () => {
  it('posts to /api/v4/Calls/SaveCall with the key, idempotency key and IsPending, and no Authorization', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Id: '48213', Status: 'created' }));
    const r = await client.saveCall(call, 'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD');
    expect(r).toEqual({ kind: 'ok', data: { callId: '48213' }, requestId: 'req-123' });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v4/Calls/SaveCall');
    expect(req.headers['x-resgrid-apikey']).toBe(API_KEY);
    expect(req.headers['idempotency-key']).toBe('sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['x-resgrid-systemapikey']).toBeUndefined();
    const body = JSON.parse(req.body);
    expect(body.IsPending).toBe(true);
    const allowed = new Set<string>(SAVE_CALL_FIELDS);
    for (const k of Object.keys(body)) expect(allowed.has(k)).toBe(true);
  });

  it('reads requests never carry Authorization either', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'success', Data: { Rules: [] } }));
    await client.getFieldPolicy();
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers['x-resgrid-apikey']).toBe(API_KEY);
    expect(seen[0]!.url).toBe('/api/v4/Calls/GetNewCallFieldPolicy');
  });

  it('logs the RequestId and never the key; emits call and latency metrics', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Id: 7, Status: 'created' }));
    expect(await client.saveCall(call, 'sos_X')).toMatchObject({ kind: 'ok', data: { callId: '7' } });
    const all = logLines.join('');
    expect(all).toContain('req-123');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('+2348012345678');
    expect(metrics.incs).toContainEqual({
      name: METRICS.coreCalls,
      labels: { endpoint: 'SaveCall', result: 'ok' },
    });
    expect(metrics.observed).toContainEqual({ name: METRICS.coreLatency, labels: { endpoint: 'SaveCall' } });
  });
});

describe('saveCall results (integration.md §4.6)', () => {
  it('201 with Id → ok', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Id: '1', Status: 'created' }));
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'ok', data: { callId: '1' } });
  });
  it('200 with Id → ok', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Id: '2', Status: 'success' }));
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'ok', data: { callId: '2' } });
  });
  it('success without Id → retryable', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Status: 'created' }));
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable' });
  });
  it('success with invalid JSON → retryable', async () => {
    handler = (_r, res) => reply(res, 201, '{not json');
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable' });
  });
  it('400 field policy → rejected with the message', async () => {
    handler = (_r, res) =>
      reply(res, 400, 'Required call fields are missing: address', { 'content-type': 'text/plain' });
    expect(await client.saveCall(call, 's')).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      message: 'Required call fields are missing: address',
    });
  });
  it('400 empty body → rejected with an empty message', async () => {
    handler = (_r, res) => reply(res, 400);
    expect(await client.saveCall(call, 's')).toEqual({ kind: 'rejected', httpStatus: 400, message: '' });
  });
  it('400 JSON-string body → rejected with the unwrapped string, cut to 500 characters', async () => {
    handler = (_r, res) => reply(res, 400, JSON.stringify('y'.repeat(800)));
    const r = await client.saveCall(call, 's');
    expect(r).toMatchObject({ kind: 'rejected', httpStatus: 400 });
    expect(r.kind === 'rejected' && r.message).toBe('y'.repeat(500));
  });
  it.each([401, 403])('%i → auth', async (status) => {
    handler = (_r, res) => reply(res, status);
    expect(await client.saveCall(call, 's')).toEqual({ kind: 'auth', httpStatus: status });
  });
  it('409 → conflict', async () => {
    handler = (_r, res) => reply(res, 409);
    expect(await client.saveCall(call, 's')).toEqual({ kind: 'conflict' });
  });
  it('415 and other 4xx → rejected', async () => {
    handler = (_r, res) => reply(res, 415, 'unsupported');
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'rejected', httpStatus: 415 });
    handler = (_r, res) => reply(res, 422, '');
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'rejected', httpStatus: 422 });
  });
  it('429 with Retry-After → retryable with retryAfterSeconds', async () => {
    handler = (_r, res) => reply(res, 429, '', { 'retry-after': '42' });
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable', retryAfterSeconds: 42 });
  });
  it('429 with an HTTP-date Retry-After uses the clock', async () => {
    client = makeClient(new FakeClock('2026-11-17T12:00:00Z'));
    handler = (_r, res) => reply(res, 429, '', { 'retry-after': 'Tue, 17 Nov 2026 12:01:00 GMT' });
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable', retryAfterSeconds: 60 });
  });
  it('429 without Retry-After → retryable without retryAfterSeconds', async () => {
    handler = (_r, res) => reply(res, 429);
    const r = await client.saveCall(call, 's');
    expect(r.kind).toBe('retryable');
    expect(r.kind === 'retryable' && r.retryAfterSeconds).toBeUndefined();
  });
  it.each([500, 502, 503])('%i → retryable', async (status) => {
    handler = (_r, res) => reply(res, status, 'oops');
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable', reason: `HTTP ${status}` });
  });
  it('timeout waiting for headers → retryable, within the given budget', async () => {
    handler = () => {
      /* never answers */
    };
    const t0 = performance.now();
    const r = await client.saveCall(call, 's', { timeoutMs: 200 });
    expect(r).toEqual({ kind: 'retryable', reason: 'timeout' });
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it('timeout while the body trickles → retryable', async () => {
    handler = (_r, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.write('{"Id":');
    };
    const r = await client.saveCall(call, 's', { timeoutMs: 200 });
    expect(r).toEqual({ kind: 'retryable', reason: 'timeout' });
  });
  it('connection refused → retryable', async () => {
    const c = createCoreClient(
      { apiBase: 'http://127.0.0.1:1', apiKey: API_KEY },
      { log: pino({ level: 'silent' }), metrics },
    );
    expect(await c.saveCall(call, 's')).toMatchObject({ kind: 'retryable' });
  });
  it('connection reset → retryable', async () => {
    handler = (_r, res) => res.socket?.destroy();
    expect(await client.saveCall(call, 's')).toMatchObject({ kind: 'retryable' });
  });
});

describe('reads', () => {
  it('GetCall reads the envelope, not only the HTTP code', async () => {
    handler = (r, res) =>
      r.url === '/api/v4/Calls/GetCall?callId=48213'
        ? reply(res, 200, envelope({ Status: 'success', Data: { CallId: '48213', State: 0 } }))
        : reply(res, 404);
    expect(await client.getCall('48213')).toEqual({
      kind: 'ok',
      requestId: 'req-123',
      data: { notFound: false, state: 0, status: 'dispatched', hoax: false },
    });
    expect(seen[0]!.url).not.toContain('departmentId');
  });
  it.each([3, 7])('GetCall State %i is a hoax signal', async (state) => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'success', Data: { State: state } }));
    expect(await client.getCall('1')).toMatchObject({ kind: 'ok', data: { status: 'closed', hoax: true } });
  });
  it('GetCall not_found (HTTP 200) → closed', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'not_found', Data: null }));
    expect(await client.getCall('999')).toMatchObject({
      kind: 'ok',
      data: { notFound: true, status: 'closed' },
    });
  });
  it('GetCall unknown state → ok with status undefined', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'success', Data: { State: 99 } }));
    const r = await client.getCall('1');
    expect(r).toMatchObject({ kind: 'ok', data: { state: 99, notFound: false } });
    expect(r.kind === 'ok' && r.data.status).toBeUndefined();
  });
  it('GetCall 401 → auth; 400 → rejected; 503 → retryable; bad JSON → retryable', async () => {
    handler = (_r, res) => reply(res, 401);
    expect(await client.getCall('1')).toEqual({ kind: 'auth', httpStatus: 401 });
    handler = (_r, res) => reply(res, 400);
    expect(await client.getCall('x')).toMatchObject({ kind: 'rejected', httpStatus: 400 });
    handler = (_r, res) => reply(res, 503);
    expect(await client.getCall('1')).toMatchObject({ kind: 'retryable' });
    handler = (_r, res) => reply(res, 200, '<html>');
    expect(await client.getCall('1')).toMatchObject({ kind: 'retryable' });
  });
  it('GetPendingCalls returns ids; not_found → empty list', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [
            { CallId: '1', State: 8 },
            { CallId: 2, State: 8 },
          ],
        }),
      );
    expect(await client.getPendingCalls()).toMatchObject({ kind: 'ok', data: { callIds: ['1', '2'] } });
    expect(seen[0]!.url).toBe('/api/v4/Calls/GetPendingCalls');
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'not_found', Data: [] }));
    expect(await client.getPendingCalls()).toMatchObject({ kind: 'ok', data: { callIds: [] } });
  });
  it('GetAllCallTypes returns names without "No Type"', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [
            { Id: '0', Name: 'No Type', BaseType: 0 },
            { Id: '12', Name: 'Public SOS', BaseType: 0 },
          ],
        }),
      );
    expect(await client.getCallTypes()).toMatchObject({ kind: 'ok', data: { names: ['Public SOS'] } });
    expect(seen[0]!.url).toBe('/api/v4/CallTypes/GetAllCallTypes');
    handler = (_r, res) =>
      reply(res, 200, envelope({ Status: 'not_found', Data: [{ Id: '0', Name: 'No Type' }] }));
    expect(await client.getCallTypes()).toMatchObject({ kind: 'ok', data: { names: [] } });
  });
  it('GetAllCallPriorites (misspelled) returns ids and deleted flags', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [
            { Id: 3, Name: 'High', IsDeleted: false },
            { Id: 4, Name: 'Old', IsDeleted: true },
          ],
        }),
      );
    expect(await client.getCallPriorities()).toMatchObject({
      kind: 'ok',
      data: {
        priorities: [
          { id: 3, isDeleted: false },
          { id: 4, isDeleted: true },
        ],
      },
    });
    expect(seen[0]!.url).toBe('/api/v4/CallPriorities/GetAllCallPriorites');
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'not_found', Data: [] }));
    expect(await client.getCallPriorities()).toMatchObject({ kind: 'ok', data: { priorities: [] } });
  });
  it('GetNewCallFieldPolicy returns only Required keys', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: {
            Rules: [
              { Key: 'address', Visible: true, Required: true },
              { Key: 'incidentId', Visible: false, Required: false },
            ],
          },
        }),
      );
    expect(await client.getFieldPolicy()).toMatchObject({ kind: 'ok', data: { requiredKeys: ['address'] } });
    handler = (_r, res) => reply(res, 403);
    expect(await client.getFieldPolicy()).toEqual({ kind: 'auth', httpStatus: 403 });
  });
  it('an unexpected envelope Status → retryable', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'failure' }));
    expect(await client.getPendingCalls()).toMatchObject({ kind: 'retryable' });
  });
});

describe('saveCallFile (CallFiles/SaveCallFile)', () => {
  const audio = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x01, 0x80]);
  const file = { callId: '48213', name: 'SOS-7KQ2-1.m4a', data: audio };

  it('posts { CallId, UserId, Type: 1, Name, Data } with Data base64, and returns the attachment id', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Status: 'created', Id: '9001' }));
    const r = await client.saveCallFile(file);
    expect(r).toEqual({ kind: 'ok', requestId: 'req-123', data: { fileId: '9001' } });

    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('/api/v4/CallFiles/SaveCallFile');
    expect(s.headers['x-resgrid-apikey']).toBe(API_KEY);
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(s.body) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['CallId', 'Data', 'Name', 'Type', 'UserId']);
    expect(sent.CallId).toBe('48213');
    expect(sent.Type).toBe(1);
    expect(sent.Name).toBe('SOS-7KQ2-1.m4a');
    expect(typeof sent.UserId).toBe('string');
    expect((sent.UserId as string).length).toBeGreaterThan(0);
    // Independent of the client's own encoder: these are the known base64 of the twelve bytes.
    expect(sent.Data).toBe('AAAAGGZ0eXD//gGA');
  });

  it('accepts a numeric Id in the 201 body', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Status: 'created', Id: 77 }));
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'ok', data: { fileId: '77' } });
  });

  it('201 without an Id → retryable', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Status: 'created' }));
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'retryable' });
  });

  // The v4 swagger declares only 200 / 201 and 400 ProblemDetails for SaveCallFile; Core answers a call
  // that is not active or pending with that 400.
  it('HTTP 400 → call_closed', async () => {
    handler = (_r, res) => reply(res, 400, '{"title":"Bad Request","status":400}');
    expect(await client.saveCallFile(file)).toEqual({ kind: 'call_closed' });
    expect(metrics.incs).toContainEqual({
      name: METRICS.coreCalls,
      labels: { endpoint: 'SaveCallFile', result: 'call_closed' },
    });
  });
  it.each([404, 410])('HTTP %i is not declared by Core → rejected, not call_closed', async (status) => {
    handler = (_r, res) => reply(res, status);
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'rejected', httpStatus: status });
  });
  it('401 / 403 → auth, 409 → conflict, 413 → rejected', async () => {
    handler = (_r, res) => reply(res, 401);
    expect(await client.saveCallFile(file)).toEqual({ kind: 'auth', httpStatus: 401 });
    handler = (_r, res) => reply(res, 403);
    expect(await client.saveCallFile(file)).toEqual({ kind: 'auth', httpStatus: 403 });
    handler = (_r, res) => reply(res, 409);
    expect(await client.saveCallFile(file)).toEqual({ kind: 'conflict' });
    handler = (_r, res) => reply(res, 413, 'too big');
    expect(await client.saveCallFile(file)).toEqual({
      kind: 'rejected',
      httpStatus: 413,
      message: 'too big',
    });
  });
  it('429 carries Retry-After; 5xx, a dropped connection and bad JSON are retryable', async () => {
    handler = (_r, res) => reply(res, 429, undefined, { 'retry-after': '7' });
    expect(await client.saveCallFile(file)).toEqual({
      kind: 'retryable',
      reason: 'HTTP 429',
      retryAfterSeconds: 7,
    });
    handler = (_r, res) => reply(res, 503);
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'retryable' });
    handler = (_r, res) => res.socket?.destroy();
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'retryable' });
    handler = (_r, res) => reply(res, 201, 'not json');
    expect(await client.saveCallFile(file)).toMatchObject({ kind: 'retryable' });
  });
  it('honours opts.timeoutMs', async () => {
    handler = () => {};
    expect(await client.saveCallFile(file, { timeoutMs: 100 })).toEqual({
      kind: 'retryable',
      reason: 'timeout',
    });
  });
  it('never logs the file bytes, in any outcome', async () => {
    handler = (_r, res) => reply(res, 201, envelope({ Status: 'created', Id: '9001' }));
    await client.saveCallFile(file);
    handler = (_r, res) => reply(res, 400);
    await client.saveCallFile(file);
    handler = (_r, res) => reply(res, 503);
    await client.saveCallFile(file);
    const logs = logLines.join('');
    expect(logs).toContain('SaveCallFile');
    expect(logs).not.toContain('AAAAGGZ0eXD//gGA');
    expect(logs).not.toContain('"Data"');
  });
});

describe('getAllUnitStatuses (UnitStatus/GetAllUnitStatuses)', () => {
  it('maps Core fields to CoreUnitStatus', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [
            {
              UnitId: 214,
              Name: 'Engine 1',
              Type: 'Engine',
              State: 'En Route',
              DestinationType: 2,
              DestinationId: 48213,
              Latitude: 6.5244,
              Longitude: 3.3792,
              Timestamp: '2026-11-22T11:15:30',
              TimestampUtc: '2026-11-22T10:15:30Z',
            },
          ],
        }),
      );
    const r = await client.getAllUnitStatuses();
    expect(r).toEqual({
      kind: 'ok',
      requestId: 'req-123',
      data: {
        units: [
          {
            unitId: '214',
            unitType: 'Engine',
            statusText: 'En Route',
            destinationType: 2,
            destinationId: '48213',
            latitude: 6.5244,
            longitude: 3.3792,
            timestamp: '2026-11-22T10:15:30.000Z',
          },
        ],
      },
    });
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe('/api/v4/UnitStatus/GetAllUnitStatuses');
    expect(seen[0]!.headers['x-resgrid-apikey']).toBe(API_KEY);
  });

  it('tolerates numbers as strings, nulls, blanks and missing fields', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [
            {
              UnitId: '9',
              Type: null,
              State: '',
              DestinationType: '2',
              DestinationId: '48213',
              Latitude: '6.5',
              Longitude: ' 3.25 ',
              TimestampUtc: '2026-11-22T10:15:30+01:00',
            },
            { UnitId: 10, DestinationType: null, DestinationId: null, Latitude: null, Longitude: 'abc' },
            { UnitId: 11, DestinationType: 0, DestinationId: '', TimestampUtc: 'not a date' },
          ],
        }),
      );
    const r = await client.getAllUnitStatuses();
    expect(r.kind === 'ok' && r.data.units).toEqual([
      {
        unitId: '9',
        unitType: null,
        statusText: null,
        destinationType: 2,
        destinationId: '48213',
        latitude: 6.5,
        longitude: 3.25,
        timestamp: '2026-11-22T09:15:30.000Z',
      },
      {
        unitId: '10',
        unitType: null,
        statusText: null,
        destinationType: null,
        destinationId: null,
        latitude: null,
        longitude: null,
        timestamp: null,
      },
      {
        unitId: '11',
        unitType: null,
        statusText: null,
        destinationType: 0,
        destinationId: null,
        latitude: null,
        longitude: null,
        timestamp: null,
      },
    ]);
  });

  it('reads TimestampUtc (never the department-local Timestamp), without a zone as UTC', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({
          Status: 'success',
          Data: [{ UnitId: 1, Timestamp: '2026-11-22T11:15:30', TimestampUtc: '2026-11-22T10:15:30' }],
        }),
      );
    const r = await client.getAllUnitStatuses();
    expect(r.kind === 'ok' && r.data.units[0]?.timestamp).toBe('2026-11-22T10:15:30.000Z');
  });

  it('skips rows with no UnitId or that are not objects', async () => {
    handler = (_r, res) =>
      reply(
        res,
        200,
        envelope({ Status: 'success', Data: [null, 'x', { Type: 'Engine' }, { UnitId: '' }, { UnitId: 5 }] }),
      );
    const r = await client.getAllUnitStatuses();
    expect(r.kind === 'ok' && r.data.units.map((u) => u.unitId)).toEqual(['5']);
  });

  it('not_found (HTTP 200, empty list) → no units', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'not_found', Data: [] }));
    expect(await client.getAllUnitStatuses()).toMatchObject({ kind: 'ok', data: { units: [] } });
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'not_found', Data: null }));
    expect(await client.getAllUnitStatuses()).toMatchObject({ kind: 'ok', data: { units: [] } });
  });

  it('success with Data that is not an array → retryable', async () => {
    handler = (_r, res) => reply(res, 200, envelope({ Status: 'success', Data: { UnitId: 1 } }));
    expect(await client.getAllUnitStatuses()).toMatchObject({ kind: 'retryable' });
  });

  it('401 / 403 → auth; 503 → retryable', async () => {
    handler = (_r, res) => reply(res, 403);
    expect(await client.getAllUnitStatuses()).toEqual({ kind: 'auth', httpStatus: 403 });
    handler = (_r, res) => reply(res, 503);
    expect(await client.getAllUnitStatuses()).toMatchObject({ kind: 'retryable' });
  });
});
