import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_API_KEY, type RunningMockCore, startMockCore } from './server.js';

let mock: RunningMockCore;

beforeAll(async () => {
  mock = await startMockCore({
    callTypes: ['Public SOS'],
    priorities: [{ Id: 3, Name: 'High' }],
  });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.control.reset();
  mock.control.setCallTypes(['Public SOS']);
  mock.control.setPriorities([{ Id: 3, Name: 'High' }]);
});

const baseHeaders = () => ({ 'X-Resgrid-ApiKey': DEFAULT_API_KEY });

async function api(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await fetch(`${mock.url}/api/v4/${path}`, {
    ...init,
    headers: { ...baseHeaders(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, text, json };
}

const validBody = {
  IsPending: true,
  Priority: 3,
  Type: 'Public SOS',
  Name: '[PUBLIC SOS] Medical emergency',
  Nature: 'Man collapsed',
  Geolocation: '6.524400,3.379200',
  Address: '12 Marina Rd',
  ContactName: 'Ade',
  ContactInfo: '+2348012345678',
  ExternalId: 'sos_1',
  ReferenceId: 'SOS-7KQ2',
  Note: 'note',
};

function save(body: unknown = validBody, headers: Record<string, string> = {}) {
  return api('Calls/SaveCall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('authentication', () => {
  it('rejects a missing or wrong key with 401 and an empty body', async () => {
    const none = await fetch(`${mock.url}/api/v4/Calls/GetPendingCalls`);
    expect(none.status).toBe(401);
    expect(await none.text()).toBe('');
    const wrong = await api('Calls/GetPendingCalls', { headers: { 'X-Resgrid-ApiKey': 'rgk_nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toBe('');
  });

  it('rejects the key when Authorization or X-Resgrid-SystemApiKey is also sent', async () => {
    expect((await api('Calls/GetPendingCalls', { headers: { Authorization: 'Bearer x' } })).status).toBe(401);
    expect((await api('Calls/GetPendingCalls', { headers: { 'X-Resgrid-SystemApiKey': 'x' } })).status).toBe(
      401,
    );
  });

  it('returns 403 when the key lacks the endpoint scope', async () => {
    mock.control.setScopes(['calls.read', 'reference.read']);
    expect((await save()).status).toBe(403);
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
    mock.control.setScopes(['calls.create']);
    expect((await api('Calls/GetPendingCalls')).status).toBe(403);
    expect((await api('CallTypes/GetAllCallTypes')).status).toBe(403);
  });

  it('checks auth before anything else and creates nothing on failure', async () => {
    mock.control.setScopes(['calls.read']);
    await save();
    expect(mock.control.calls()).toHaveLength(0);
  });

  it('gives 401 on a path that is not one of the scoped endpoints', async () => {
    expect((await api('Departments/GetDepartment')).status).toBe(401);
  });

  it('accepts a changed key and refuses the old one', async () => {
    // Built at run time, like DEFAULT_API_KEY: no key-shaped literal in the source.
    const newKey = `rgk_NewKey00_${'n'.repeat(43)}`;
    mock.control.setApiKey(newKey);
    expect((await api('Calls/GetPendingCalls')).status).toBe(401);
    expect((await api('Calls/GetPendingCalls', { headers: { 'X-Resgrid-ApiKey': newKey } })).status).toBe(
      200,
    );
  });
});

describe('SaveCall', () => {
  it('creates a pending call: 201, string Id, envelope, Location, State 8', async () => {
    const res = await save();
    expect(res.status).toBe(201);
    expect(res.json?.Status).toBe('created');
    expect(typeof res.json?.Id).toBe('string');
    expect(res.json?.Version).toBe('v4');
    expect(res.json).toHaveProperty('RequestId');
    expect(res.headers.get('location')).toContain(`/api/v4/Calls/GetCall?callId=${res.json?.Id}`);
    const calls = mock.control.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      State: 8,
      InitialState: 8,
      Name: validBody.Name,
      ExternalId: 'sos_1',
      ReferenceId: 'SOS-7KQ2',
      Type: 'Public SOS',
      Priority: 3,
    });
  });

  it('creates an ACTIVE call (State 0) when IsPending is not true, and records it', async () => {
    const { IsPending: _omit, ...body } = validBody;
    await save(body);
    await save({ ...validBody, IsPending: false });
    expect(mock.control.calls().map((c) => c.InitialState)).toEqual([0, 0]);
  });

  it.each([
    ['Priority', { Priority: undefined }],
    ['Priority empty', { Priority: '' }],
    ['Name', { Name: undefined }],
    ['Name empty', { Name: '' }],
    ['Nature', { Nature: undefined }],
    ['Nature empty', { Nature: '' }],
  ])('returns 400 with an empty body when %s is missing', async (_label, patch) => {
    const res = await save({ ...validBody, ...patch });
    expect(res.status).toBe(400);
    expect(res.text).toBe('');
    expect(mock.control.calls()).toHaveLength(0);
  });

  it('returns 400 for malformed JSON and for an empty body', async () => {
    const bad = await api('Calls/SaveCall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const empty = await api('Calls/SaveCall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(empty.status).toBe(400);
  });

  it('returns 415 when the content type is not JSON', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await api('Calls/SaveCall', {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(415);
    }
    expect(mock.control.calls()).toHaveLength(0);
  });

  it('silently drops an unknown or wrongly-cased call type name', async () => {
    await save({ ...validBody, Type: 'Public sos' });
    await save({ ...validBody, Type: 'Nope' });
    const calls = mock.control.calls();
    expect(calls.map((c) => c.Type)).toEqual([null, null]);
    expect(calls.map((c) => c.TypeId)).toEqual(['0', '0']);
  });

  it('records each request with method, path, headers and parsed body', async () => {
    await save(validBody, { 'Idempotency-Key': 'k1' });
    const [r] = mock.control.requests({ endpoint: 'Calls/SaveCall' });
    expect(r).toMatchObject({ method: 'POST', path: '/api/v4/Calls/SaveCall', status: 201 });
    expect(r?.headers['idempotency-key']).toBe('k1');
    expect(r?.headers.authorization).toBeUndefined();
    expect(r?.body).toEqual(validBody);
  });
});

describe('field policy', () => {
  it('serves the rules, empty by default', async () => {
    const res = await api('Calls/GetNewCallFieldPolicy');
    expect(res.json?.Data).toEqual({ Rules: [] });
    mock.control.setFieldPolicy([
      { Key: 'address', Required: true },
      { Key: 'incidentId', Visible: false },
    ]);
    const res2 = await api('Calls/GetNewCallFieldPolicy');
    expect(res2.json?.Data.Rules).toEqual([
      { Key: 'address', Visible: true, Required: true },
      { Key: 'incidentId', Visible: false, Required: false },
    ]);
  });

  it('returns 400 "Required call fields are missing: address" when address is required and absent', async () => {
    mock.control.setFieldPolicy([{ Key: 'address', Required: true }]);
    const { Address: _a, ...body } = validBody;
    const res = await save(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe('Required call fields are missing: address');
    expect(mock.control.calls()).toHaveLength(0);
    expect((await save(validBody)).status).toBe(201);
  });

  it('lists every missing key, comma separated, in rule order', async () => {
    mock.control.setFieldPolicy([
      { Key: 'contactName', Required: true },
      { Key: 'geolocation', Required: true },
      { Key: 'note', Required: true },
    ]);
    const res = await save({ ...validBody, ContactName: undefined, Geolocation: '0,0' });
    expect(res.text).toBe('Required call fields are missing: contactName, geolocation');
    const res2 = await save({ ...validBody, ContactName: undefined, Geolocation: ',', Note: undefined });
    expect(res2.text).toBe('Required call fields are missing: contactName, geolocation, note');
  });

  it('enforces LinkedCallId only when the key is present in the body', async () => {
    mock.control.setFieldPolicy([{ Key: 'linkedCall', Required: true }]);
    expect((await save(validBody)).status).toBe(201); // omitted: skipped
    const blank = await save({ ...validBody, LinkedCallId: '' });
    expect(blank.status).toBe(400);
    expect(blank.text).toBe('Required call fields are missing: linkedCall');
    expect((await save({ ...validBody, LinkedCallId: '12' })).status).toBe(201);
  });

  it('applies the same present-only rule to ProtocolIds and IndoorMapZoneId', async () => {
    mock.control.setFieldPolicy([
      { Key: 'protocols', Required: true },
      { Key: 'indoorLocation', Required: true },
    ]);
    expect((await save(validBody)).status).toBe(201);
    const res = await save({ ...validBody, ProtocolIds: [], IndoorMapZoneId: null });
    expect(res.text).toBe('Required call fields are missing: protocols, indoorLocation');
  });

  it('never enforces dispatchOn, dispatchList or pluscode for a pending call', async () => {
    mock.control.setFieldPolicy([
      { Key: 'dispatchOn', Required: true },
      { Key: 'dispatchList', Required: true },
      { Key: 'pluscode', Required: true },
    ]);
    expect((await save(validBody)).status).toBe(201);
  });

  it('always fails keys the relay cannot satisfy', async () => {
    mock.control.setFieldPolicy([{ Key: 'what3words', Required: true }]);
    expect((await save(validBody)).text).toBe('Required call fields are missing: what3words');
  });
});

describe('idempotency', () => {
  it('returns 201 with the same Id and creates nothing on a repeat', async () => {
    const first = await save(validBody, { 'Idempotency-Key': 'sos_A' });
    const again = await save(validBody, { 'Idempotency-Key': 'sos_A' });
    expect(again.status).toBe(201);
    expect(again.json?.Id).toBe(first.json?.Id);
    expect(mock.control.calls()).toHaveLength(1);
    expect(again.headers.get('location')).toContain(String(first.json?.Id));
  });

  it('does not compare the body on a repeat, nor validate it', async () => {
    const first = await save(validBody, { 'Idempotency-Key': 'sos_B' });
    const again = await save({ ...validBody, Name: 'Something else' }, { 'Idempotency-Key': 'sos_B' });
    expect(again.json?.Id).toBe(first.json?.Id);
    expect(mock.control.calls()[0]?.Name).toBe(validBody.Name);
  });

  it('creates a second call for a different key', async () => {
    await save(validBody, { 'Idempotency-Key': 'sos_C' });
    await save(validBody, { 'Idempotency-Key': 'sos_D' });
    expect(mock.control.calls()).toHaveLength(2);
  });

  it('returns 409 with an empty body while the first request is still in progress', async () => {
    mock.control.injectFault('Calls/SaveCall', { delayMs: 400 });
    const slow = save(validBody, { 'Idempotency-Key': 'sos_E' });
    await new Promise((r) => setTimeout(r, 100));
    const second = await save(validBody, { 'Idempotency-Key': 'sos_E' });
    expect(second.status).toBe(409);
    expect(second.text).toBe('');
    const first = await slow;
    expect(first.status).toBe(201);
    const third = await save(validBody, { 'Idempotency-Key': 'sos_E' });
    expect(third.status).toBe(201);
    expect(third.json?.Id).toBe(first.json?.Id);
    expect(mock.control.calls()).toHaveLength(1);
  });

  it('processes a request as new when it failed before saving (validation error)', async () => {
    const bad = await save({ ...validBody, Name: '' }, { 'Idempotency-Key': 'sos_F' });
    expect(bad.status).toBe(400);
    const ok = await save(validBody, { 'Idempotency-Key': 'sos_F' });
    expect(ok.status).toBe(201);
  });

  it('processes as new when the request failed before saving (injected 503)', async () => {
    mock.control.injectFault('Calls/SaveCall', { status: 503 });
    expect((await save(validBody, { 'Idempotency-Key': 'sos_G' })).status).toBe(503);
    expect(mock.control.calls()).toHaveLength(0);
    expect((await save(validBody, { 'Idempotency-Key': 'sos_G' })).status).toBe(201);
    expect(mock.control.calls()).toHaveLength(1);
  });

  it('finishes the same call when the first request saved and then failed', async () => {
    mock.control.injectFault('Calls/SaveCall', { status: 500, afterProcessing: true });
    expect((await save(validBody, { 'Idempotency-Key': 'sos_H' })).status).toBe(500);
    expect(mock.control.calls()).toHaveLength(1);
    const retry = await save(validBody, { 'Idempotency-Key': 'sos_H' });
    expect(retry.status).toBe(201);
    expect(retry.json?.Id).toBe(mock.control.calls()[0]?.CallId);
    expect(mock.control.calls()).toHaveLength(1);
  });

  it('releases an abandoned in-progress claim after the claim TTL', async () => {
    const short = await startMockCore({ claimTtlMs: 150 });
    try {
      short.control.injectFault('Calls/SaveCall', { delayMs: 600 });
      const hdr = {
        'Content-Type': 'application/json',
        'X-Resgrid-ApiKey': DEFAULT_API_KEY,
        'Idempotency-Key': 'k',
      };
      const post = () =>
        fetch(`${short.url}/api/v4/Calls/SaveCall`, {
          method: 'POST',
          headers: hdr,
          body: JSON.stringify(validBody),
        });
      const slow = post();
      await new Promise((r) => setTimeout(r, 50));
      expect((await post()).status).toBe(409);
      await new Promise((r) => setTimeout(r, 200));
      expect((await post()).status).toBe(201);
      await slow;
    } finally {
      await short.close();
    }
  });
});

describe('GetCall', () => {
  it('returns Data with the documented fields', async () => {
    const created = await save();
    const res = await api(`Calls/GetCall?callId=${created.json?.Id}`);
    expect(res.status).toBe(200);
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data).toMatchObject({
      CallId: created.json?.Id,
      State: 8,
      ExternalId: 'sos_1',
      ReferenceId: 'SOS-7KQ2',
      DispatchedOnUtc: null,
      Name: validBody.Name,
    });
    expect(typeof res.json?.Data.LoggedOnUtc).toBe('string');
    expect(res.json?.Data.IdempotencyKey).toBeUndefined();
  });

  it('follows dispatcher actions: 8, then 0, then closed, then re-opened', async () => {
    const created = await save();
    const id = created.json?.Id as string;
    const state = async () => (await api(`Calls/GetCall?callId=${id}`)).json?.Data.State;
    expect(await state()).toBe(8);
    mock.control.setCallState(id, 0);
    expect(await state()).toBe(0);
    expect((await api(`Calls/GetCall?callId=${id}`)).json?.Data.DispatchedOnUtc).toEqual(expect.any(String));
    mock.control.setCallState(id, 1);
    expect(await state()).toBe(1);
    mock.control.setCallState(id, 3);
    expect(await state()).toBe(3);
    mock.control.setCallState(id, 0);
    expect(await state()).toBe(0);
  });

  it('returns HTTP 200 with Status "not_found" for an unknown id', async () => {
    const res = await api('Calls/GetCall?callId=999999');
    expect(res.status).toBe(200);
    expect(res.json?.Status).toBe('not_found');
    expect(res.json?.Data).toBeNull();
  });

  it('returns 400 with an empty body when callId is not an integer or missing', async () => {
    for (const q of ['callId=abc', 'callId=1.5', 'callId=', '']) {
      const res = await api(`Calls/GetCall?${q}`);
      expect(res.status).toBe(400);
      expect(res.text).toBe('');
    }
  });

  it('defaults to not_found for a deleted call and can be switched to the last state', async () => {
    const id = (await save()).json?.Id as string;
    mock.control.setCallState(id, 1);
    mock.control.deleteCall(id);
    expect((await api(`Calls/GetCall?callId=${id}`)).json?.Status).toBe('not_found');
    mock.control.setDeletedCallBehavior('last_state');
    const res = await api(`Calls/GetCall?callId=${id}`);
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data.State).toBe(1);
    expect(mock.control.calls()).toHaveLength(0);
    expect(mock.control.calls({ includeDeleted: true })).toHaveLength(1);
  });
});

describe('GetPendingCalls', () => {
  it('returns not_found with an empty array when there are none', async () => {
    const res = await api('Calls/GetPendingCalls');
    expect(res.status).toBe(200);
    expect(res.json?.Status).toBe('not_found');
    expect(res.json?.Data).toEqual([]);
  });

  it('lists only State 8 calls, oldest first', async () => {
    const a = (await save({ ...validBody, ExternalId: 'a' })).json?.Id as string;
    const b = (await save({ ...validBody, ExternalId: 'b' })).json?.Id as string;
    const c = (await save({ ...validBody, ExternalId: 'c' })).json?.Id as string;
    mock.control.setCallState(b, 0);
    const res = await api('Calls/GetPendingCalls');
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data.map((d: { CallId: string }) => d.CallId)).toEqual([a, c]);
    mock.control.setCallState(b, 8); // re-opened to pending
    const res2 = await api('Calls/GetPendingCalls');
    expect(res2.json?.Data.map((d: { CallId: string }) => d.CallId)).toEqual([a, b, c]);
    mock.control.deleteCall(a);
    expect((await api('Calls/GetPendingCalls')).json?.Data).toHaveLength(2);
  });

  it('leaves active calls out', async () => {
    await save({ ...validBody, IsPending: false });
    expect((await api('Calls/GetPendingCalls')).json?.Status).toBe('not_found');
  });
});

describe('reference data', () => {
  it('always includes "No Type" with id "0"', async () => {
    const res = await api('CallTypes/GetAllCallTypes');
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data).toEqual([
      { Id: '0', Name: 'No Type', BaseType: 0 },
      { Id: '12', Name: 'Public SOS', BaseType: 0 },
    ]);
  });

  it('returns not_found with only "No Type" when the department has no types', async () => {
    mock.control.setCallTypes([]);
    const res = await api('CallTypes/GetAllCallTypes');
    expect(res.status).toBe(200);
    expect(res.json?.Status).toBe('not_found');
    expect(res.json?.Data).toEqual([{ Id: '0', Name: 'No Type', BaseType: 0 }]);
  });

  it('accepts explicit ids and a "No Type" name without duplicating it', async () => {
    mock.control.setCallTypes([{ Id: 99, Name: 'Fire' }, 'No Type']);
    const res = await api('CallTypes/GetAllCallTypes');
    expect(res.json?.Data.map((t: { Id: string }) => t.Id)).toEqual(['0', '99']);
  });

  it('serves priorities through the misspelled endpoint, with integer ids', async () => {
    const res = await api('CallPriorities/GetAllCallPriorites');
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data[0]).toMatchObject({ Id: 3, Name: 'High', IsDeleted: false });
    expect((await api('CallPriorities/GetAllCallPriorities')).status).toBe(401); // the correct spelling does not exist
  });

  it('returns not_found with an empty array when there are no priorities', async () => {
    mock.control.setPriorities([]);
    const res = await api('CallPriorities/GetAllCallPriorites');
    expect(res.json?.Status).toBe('not_found');
    expect(res.json?.Data).toEqual([]);
  });

  it('shows a deleted priority', async () => {
    mock.control.setPriorities([{ Id: 3, Name: 'High', IsDeleted: true }]);
    expect((await api('CallPriorities/GetAllCallPriorites')).json?.Data[0].IsDeleted).toBe(true);
  });
});

describe('fault injection', () => {
  it('returns a given status with a body and Retry-After for the next N requests only', async () => {
    mock.control.injectFault('Calls/GetPendingCalls', { status: 429, body: 'slow down', retryAfter: 7 }, 2);
    for (let i = 0; i < 2; i++) {
      const res = await api('Calls/GetPendingCalls');
      expect(res.status).toBe(429);
      expect(res.text).toBe('slow down');
      expect(res.headers.get('retry-after')).toBe('7');
    }
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
    expect(mock.control.pendingFaults()).toBe(0);
  });

  it('sends object bodies as JSON and only hits the named endpoint', async () => {
    mock.control.injectFault('Calls/GetCall', { status: 502, body: { error: 'bad gateway' } });
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
    const res = await api('Calls/GetCall?callId=1');
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: 'bad gateway' });
  });

  it('applies to any endpoint with "*" and even to unauthenticated requests', async () => {
    mock.control.injectFault('*', { status: 503 });
    const res = await fetch(`${mock.url}/api/v4/CallTypes/GetAllCallTypes`);
    expect(res.status).toBe(503);
  });

  it('delays a response so a client timeout fires', async () => {
    mock.control.injectFault('Calls/GetPendingCalls', { delayMs: 500 });
    await expect(
      fetch(`${mock.url}/api/v4/Calls/GetPendingCalls`, {
        headers: baseHeaders(),
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
    // A delay-only fault still processes the request normally.
    mock.control.injectFault('Calls/GetPendingCalls', { delayMs: 150 });
    const t0 = Date.now();
    const res = await api('Calls/GetPendingCalls');
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('keeps a call saved when the client timed out during a delayed SaveCall', async () => {
    mock.control.injectFault('Calls/SaveCall', { delayMs: 300 });
    await expect(
      fetch(`${mock.url}/api/v4/Calls/SaveCall`, {
        method: 'POST',
        headers: { ...baseHeaders(), 'Content-Type': 'application/json', 'Idempotency-Key': 'timeout1' },
        body: JSON.stringify(validBody),
        signal: AbortSignal.timeout(80),
      }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.control.calls()).toHaveLength(1);
    const retry = await save(validBody, { 'Idempotency-Key': 'timeout1' });
    expect(retry.status).toBe(201);
    expect(retry.json?.Id).toBe(mock.control.calls()[0]?.CallId);
  });

  it('drops the connection', async () => {
    mock.control.injectFault('Calls/GetPendingCalls', { drop: true });
    await expect(
      fetch(`${mock.url}/api/v4/Calls/GetPendingCalls`, { headers: baseHeaders() }),
    ).rejects.toThrow();
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
    expect(mock.control.requests({ endpoint: 'Calls/GetPendingCalls' })[0]?.faulted).toBe(true);
  });

  it('drops the connection after saving when afterProcessing is set', async () => {
    mock.control.injectFault('Calls/SaveCall', { drop: true, afterProcessing: true });
    await expect(save(validBody, { 'Idempotency-Key': 'drop1' })).rejects.toThrow();
    expect(mock.control.calls()).toHaveLength(1);
    expect((await save(validBody, { 'Idempotency-Key': 'drop1' })).json?.Id).toBe(
      mock.control.calls()[0]?.CallId,
    );
  });

  it('rejects a fault that does nothing, and unknown endpoints', () => {
    expect(() => mock.control.injectFault('Calls/SaveCall', {})).toThrow();
    expect(() => mock.control.injectFault('Calls/Nope' as never, { status: 500 })).toThrow();
  });

  it('clears faults', async () => {
    mock.control.injectFault('*', { status: 500 }, 5);
    mock.control.clearFaults();
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
  });
});

describe('SaveCallFile', () => {
  const audio = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x01, 0x80]);
  const fileBody = (callId: string, extra: Record<string, unknown> = {}) => ({
    CallId: callId,
    UserId: '00000000-0000-0000-0000-000000000000',
    Type: 1,
    Name: 'SOS-7KQ2-1.m4a',
    Data: audio.toString('base64'),
    ...extra,
  });
  const attach = (body: unknown, headers: Record<string, string> = {}) =>
    api('CallFiles/SaveCallFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('attaches a file to a pending call: 201 { Id }, storing the call id, name and decoded size', async () => {
    const callId = (await save()).json?.Id as string;
    const res = await attach(fileBody(callId));
    expect(res.status).toBe(201);
    expect(res.json?.Status).toBe('created');
    expect(typeof res.json?.Id).toBe('string');
    expect(mock.control.files()).toEqual([
      expect.objectContaining({ Id: res.json?.Id, CallId: callId, Name: 'SOS-7KQ2-1.m4a', Size: 12 }),
    ]);
    expect(mock.control.files({ callId: '999' })).toEqual([]);
  });

  it('also accepts an active call', async () => {
    const callId = (await save({ ...validBody, IsPending: false })).json?.Id as string;
    expect((await attach(fileBody(callId))).status).toBe(201);
  });

  it('refuses a closed call with 400, and attaches nothing', async () => {
    const callId = (await save()).json?.Id as string;
    for (const state of [1, 2, 3, 4, 5, 6, 7]) {
      mock.control.setCallState(callId, state);
      const res = await attach(fileBody(callId));
      expect(res.status, `state ${state}`).toBe(400);
    }
    expect(mock.control.files()).toEqual([]);
    mock.control.setCallState(callId, 8); // re-opened
    expect((await attach(fileBody(callId))).status).toBe(201);
  });

  // What a live Core answered for an unknown call (live checklist, 2026-11-22).
  it('answers 200, Status not_found, Id null for a call that does not exist or was deleted', async () => {
    const unknown = await attach(fileBody('424242'));
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ Status: 'not_found', Id: null });
    const callId = (await save()).json?.Id as string;
    mock.control.deleteCall(callId);
    expect((await attach(fileBody(callId))).json).toMatchObject({ Status: 'not_found', Id: null });
    expect(mock.control.files()).toEqual([]);
  });

  it('answers 400 for a missing field, a bad Type or Data that is not base64', async () => {
    const callId = (await save()).json?.Id as string;
    for (const bad of [
      { UserId: '' },
      { UserId: undefined },
      { Name: undefined },
      { Data: '' },
      { Data: '***not base64***' },
      { CallId: undefined },
      { Type: 'x' },
    ]) {
      expect((await attach(fileBody(callId, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await attach([1, 2])).status).toBe(400);
    expect(mock.control.files()).toEqual([]);
  });

  it('needs calls.update, and the API key', async () => {
    const callId = (await save()).json?.Id as string;
    mock.control.setScopes(['calls.create', 'calls.read', 'reference.read', 'units.read']);
    expect((await attach(fileBody(callId))).status).toBe(403);
    mock.control.setScopes(['calls.update']);
    expect((await attach(fileBody(callId))).status).toBe(201);
    mock.control.setApiKey('other');
    expect((await attach(fileBody(callId))).status).toBe(401);
  });

  // A live Core honours the key on SaveCallFile (live checklist, 2026-11-22: same id twice).
  it('honours Idempotency-Key: the same key returns the same Id and stores one file', async () => {
    const callId = (await save()).json?.Id as string;
    const a = await attach(fileBody(callId), { 'Idempotency-Key': 'rec_k' });
    const b = await attach(fileBody(callId), { 'Idempotency-Key': 'rec_k' });
    expect(b.status).toBe(a.status);
    expect(b.json?.Id).toBe(a.json?.Id);
    expect(mock.control.files({ callId })).toHaveLength(1);
  });

  it('without a key, attaching twice stores two files', async () => {
    const callId = (await save()).json?.Id as string;
    const a = await attach(fileBody(callId));
    const b = await attach(fileBody(callId));
    expect(a.json?.Id).not.toBe(b.json?.Id);
    expect(mock.control.files({ callId })).toHaveLength(2);
  });

  it('records the request without the audio, and supports faults after processing', async () => {
    const callId = (await save()).json?.Id as string;
    mock.control.injectFault('CallFiles/SaveCallFile', { status: 500, afterProcessing: true });
    expect((await attach(fileBody(callId))).status).toBe(500);
    expect(mock.control.files({ callId })).toHaveLength(1); // saved, then the answer failed
    const rec = mock.control.requests({ endpoint: 'CallFiles/SaveCallFile' });
    expect(rec).toHaveLength(1);
    expect(JSON.stringify(rec[0])).not.toContain(audio.toString('base64'));
    expect(rec[0]?.body).toMatchObject({ CallId: callId, Name: 'SOS-7KQ2-1.m4a' });
  });
});

describe('GetAllUnitStatuses', () => {
  const units = [
    {
      UnitId: 214,
      Type: 'Engine',
      State: 'En Route',
      DestinationType: 2,
      DestinationId: 1000,
      Latitude: 6.5,
      Longitude: 3.3,
      Timestamp: '2026-11-22T10:15:30Z',
    },
    { UnitId: '9', Type: null, State: 'Available', DestinationType: null, DestinationId: null },
  ];

  it('returns not_found with an empty list until units are scripted', async () => {
    const res = await api('UnitStatus/GetAllUnitStatuses');
    expect(res.status).toBe(200);
    expect(res.json?.Status).toBe('not_found');
    expect(res.json?.Data).toEqual([]);
  });

  it('returns the scripted list, as given, and follows changes', async () => {
    mock.control.setUnitStatuses(units);
    const res = await api('UnitStatus/GetAllUnitStatuses');
    expect(res.json?.Status).toBe('success');
    expect(res.json?.Data).toEqual(units);
    mock.control.setUnitStatuses([{ ...units[0]!, Latitude: 6.6 }]);
    expect((await api('UnitStatus/GetAllUnitStatuses')).json?.Data).toEqual([{ ...units[0], Latitude: 6.6 }]);
  });

  it('needs units.read, and the API key', async () => {
    mock.control.setScopes(['calls.read']);
    expect((await api('UnitStatus/GetAllUnitStatuses')).status).toBe(403);
    mock.control.setScopes(['units.read']);
    expect((await api('UnitStatus/GetAllUnitStatuses')).status).toBe(200);
    expect(
      (await api('UnitStatus/GetAllUnitStatuses', { headers: { 'X-Resgrid-ApiKey': 'nope' } })).status,
    ).toBe(401);
  });

  it('is scripted at start-up with the unitStatuses option, and reset goes back to it', async () => {
    const m = await startMockCore({ unitStatuses: units });
    try {
      const get = () =>
        fetch(`${m.url}/api/v4/UnitStatus/GetAllUnitStatuses`, { headers: baseHeaders() }).then(
          (r) => r.json() as Promise<{ Status: string; Data: unknown }>,
        );
      expect((await get()).Data).toEqual(units);
      m.control.setUnitStatuses([]);
      expect((await get()).Status).toBe('not_found');
      m.control.reset();
      expect((await get()).Data).toEqual(units);
    } finally {
      await m.close();
    }
  });
});

describe('reset', () => {
  it('restores calls, requests, faults, claims and configuration', async () => {
    await save(validBody, { 'Idempotency-Key': 'r1' });
    mock.control.setUnitStatuses([{ UnitId: 1 }]);
    mock.control.setScopes([]);
    mock.control.setApiKey('x');
    mock.control.injectFault('*', { status: 500 });
    mock.control.reset();
    expect(mock.control.calls()).toHaveLength(0);
    expect(mock.control.requests()).toHaveLength(0);
    expect(mock.control.pendingFaults()).toBe(0);
    expect(mock.control.files()).toHaveLength(0);
    expect(mock.control.unitStatuses()).toEqual([]);
    const res = await save(validBody, { 'Idempotency-Key': 'r1' });
    expect(res.status).toBe(201);
    expect(mock.control.calls()).toHaveLength(1);
  });
});

describe('control endpoints', () => {
  const ctl = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${mock.url}/__control/${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  it('needs no API key and is not recorded as a Core request', async () => {
    expect((await ctl('GET', 'calls')).status).toBe(200);
    expect(mock.control.requests()).toHaveLength(0);
  });

  it('lists, reads, changes the state of and deletes calls', async () => {
    const id = (await save()).json?.Id as string;
    expect((await ctl('GET', 'calls')).json).toHaveLength(1);
    expect((await ctl('GET', `calls/${id}`)).json.State).toBe(8);
    expect((await ctl('POST', `calls/${id}/state`, { state: 0 })).json.State).toBe(0);
    expect((await api(`Calls/GetCall?callId=${id}`)).json?.Data.State).toBe(0);
    expect((await ctl('POST', 'calls/424242/state', { state: 0 })).status).toBe(400);
    expect((await ctl('POST', `calls/${id}/state`, { state: 'x' })).status).toBe(400);
    expect((await ctl('DELETE', `calls/${id}`)).status).toBe(200);
    expect((await ctl('GET', 'calls')).json).toHaveLength(0);
    expect((await ctl('GET', 'calls?includeDeleted=true')).json).toHaveLength(1);
    expect((await ctl('GET', 'calls/424242')).status).toBe(404);
  });

  it('shows received requests with the API key redacted, and clears them', async () => {
    await save();
    const reqs = (await ctl('GET', 'requests?endpoint=Calls/SaveCall&method=POST')).json;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers['x-resgrid-apikey']).toBe('[redacted]');
    expect(reqs[0].body.Name).toBe(validBody.Name);
    await ctl('DELETE', 'requests');
    expect((await ctl('GET', 'requests')).json).toHaveLength(0);
  });

  it('sets call types, priorities, field policy, scopes and the key', async () => {
    expect((await ctl('PUT', 'call-types', ['Fire', { Id: 5, Name: 'EMS' }])).status).toBe(200);
    expect((await api('CallTypes/GetAllCallTypes')).json?.Data.map((t: { Name: string }) => t.Name)).toEqual([
      'No Type',
      'Fire',
      'EMS',
    ]);
    expect((await ctl('PUT', 'priorities', [{ Id: 9, Name: 'Low' }])).status).toBe(200);
    expect((await api('CallPriorities/GetAllCallPriorites')).json?.Data[0].Id).toBe(9);
    expect((await ctl('PUT', 'field-policy', { Rules: [{ Key: 'address', Required: true }] })).status).toBe(
      200,
    );
    expect((await api('Calls/GetNewCallFieldPolicy')).json?.Data.Rules[0].Key).toBe('address');
    expect((await ctl('PUT', 'field-policy', [])).status).toBe(200);
    expect((await ctl('PUT', 'scopes', ['calls.read'])).status).toBe(200);
    expect((await save()).status).toBe(403);
    expect((await ctl('PUT', 'api-key', { apiKey: 'k2' })).status).toBe(200);
    expect((await api('Calls/GetPendingCalls')).status).toBe(401);
    expect((await ctl('PUT', 'api-key', {})).status).toBe(400);
    expect((await ctl('GET', 'state')).json.scopes).toEqual(['calls.read']);
  });

  it('injects faults and switches the deleted-call behaviour', async () => {
    expect(
      (
        await ctl('POST', 'faults', {
          endpoint: 'Calls/GetPendingCalls',
          status: 503,
          retryAfter: 1,
          count: 2,
        })
      ).status,
    ).toBe(200);
    expect((await api('Calls/GetPendingCalls')).status).toBe(503);
    expect((await ctl('GET', 'state')).json.pendingFaults).toBe(1);
    expect((await ctl('DELETE', 'faults')).status).toBe(200);
    expect((await api('Calls/GetPendingCalls')).status).toBe(200);
    expect((await ctl('POST', 'faults', { endpoint: 'Calls/Nope', status: 500 })).status).toBe(400);
    expect((await ctl('PUT', 'deleted-call-behavior', { mode: 'last_state' })).status).toBe(200);
    expect((await ctl('PUT', 'deleted-call-behavior', { mode: 'x' })).status).toBe(400);
  });

  it('scripts unit statuses and lists attached files', async () => {
    expect((await ctl('PUT', 'unit-statuses', [{ UnitId: 5, State: 'On Scene' }])).status).toBe(200);
    expect((await api('UnitStatus/GetAllUnitStatuses')).json?.Data).toEqual([
      { UnitId: 5, State: 'On Scene' },
    ]);
    expect((await ctl('PUT', 'unit-statuses', { Units: [] })).status).toBe(200);
    expect((await api('UnitStatus/GetAllUnitStatuses')).json?.Status).toBe('not_found');
    expect((await ctl('PUT', 'unit-statuses', { nope: 1 })).status).toBe(400);
    expect((await ctl('PUT', 'unit-statuses', [1])).status).toBe(400);

    const callId = (await save()).json?.Id as string;
    await api('CallFiles/SaveCallFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CallId: callId, UserId: 'u', Type: 1, Name: 'a.m4a', Data: 'AAAA' }),
    });
    const files = (await ctl('GET', 'files')).json;
    expect(files).toEqual([expect.objectContaining({ CallId: callId, Name: 'a.m4a', Size: 3 })]);
    expect((await ctl('GET', `files?callId=${callId}`)).json).toHaveLength(1);
    expect((await ctl('GET', 'files?callId=nope')).json).toHaveLength(0);
    const st = (await ctl('GET', 'state')).json;
    expect(st.files).toBe(1);
    expect(st.unitStatuses).toBe(0);
  });

  it('resets', async () => {
    await save();
    expect((await ctl('POST', 'reset')).status).toBe(200);
    expect(mock.control.calls()).toHaveLength(0);
  });
});
