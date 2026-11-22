/**
 * Live Core checklist: integration.md section 11, run by hand against a REAL Resgrid test department
 * before go-live. Not part of the automated suite.
 *
 *   npm run live-checklist -- --yes-create-test-calls [--no-interactive]
 *
 * The four RESGRID_* variables come from the shell or from `.env` in the working directory.
 *
 * THIS CREATES REAL PENDING CALLS in the department the key belongs to. Core's API gives the relay
 * no way to delete a call, so every call created here must be closed or deleted by hand afterwards.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
import { request } from 'undici';
import { createCoreClient } from '../src/core/client.js';
import { silentLogger } from '../src/logger.js';
import { NoopMetrics } from '../src/metrics.js';

const PREFIX = '[RELAY CHECKLIST]';
const USAGE = `Usage: npm run live-checklist -- --yes-create-test-calls [--no-interactive]

Environment (all required; from the shell, or from .env in the working directory, the shell winning):
  RESGRID_API_BASE        e.g. https://api.resgrid.example (no /api/v4)
  RESGRID_API_KEY         the relay's key (scopes calls.create, calls.read, calls.update, units.read, reference.read)
  RESGRID_CALL_TYPE_NAME  the call type name the relay will use
  RESGRID_PRIORITY_ID     the call priority id the relay will use (integer)

Flags:
  --yes-create-test-calls  required: you accept that real pending calls are created
  --no-interactive         do not wait for a human; manual items are printed and skipped
  --help                   this text
`;

// ---------------------------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const known = new Set(['--yes-create-test-calls', '--no-interactive', '--help']);
for (const a of args) {
  if (!known.has(a)) {
    console.error(`Unknown argument ${a}\n\n${USAGE}`);
    process.exit(2);
  }
}
if (args.has('--help')) {
  console.log(USAGE);
  process.exit(0);
}

// A `.env` in the working directory fills in what the shell does not set (the shell wins), like
// `node --env-file`. Only variable names are printed, never values.
loadDotEnv('.env');

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  if (loaded.length > 0) console.log(`Read ${loaded.join(', ')} from ${path}.`);
}

const env = {
  base: (process.env.RESGRID_API_BASE ?? '').trim().replace(/\/+$/, ''),
  key: (process.env.RESGRID_API_KEY ?? '').trim(),
  typeName: process.env.RESGRID_CALL_TYPE_NAME ?? '',
  priorityRaw: (process.env.RESGRID_PRIORITY_ID ?? '').trim(),
};
const missing = [
  ['RESGRID_API_BASE', env.base],
  ['RESGRID_API_KEY', env.key],
  ['RESGRID_CALL_TYPE_NAME', env.typeName],
  ['RESGRID_PRIORITY_ID', env.priorityRaw],
]
  .filter(([, v]) => v === '')
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`Missing environment: ${missing.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}
if (!/^\d+$/.test(env.priorityRaw)) {
  console.error('RESGRID_PRIORITY_ID must be an integer.');
  process.exit(2);
}
const PRIORITY = Number(env.priorityRaw);

console.log(`
==================================================================================
 WARNING: THIS SCRIPT CREATES REAL PENDING CALLS
 Target: ${env.base}
 Every call is named "${PREFIX} ...". Pending calls notify nobody, but they appear in
 the department's Pending Calls list. Core's API offers the relay no way to delete
 them: you must close or delete each one by hand. Use a TEST department only.
==================================================================================
`);
if (!args.has('--yes-create-test-calls')) {
  console.error('Refusing to continue without --yes-create-test-calls. Nothing was sent or created.');
  process.exit(2);
}

const interactive = !args.has('--no-interactive') && Boolean(process.stdin.isTTY);
if (!args.has('--no-interactive') && !process.stdin.isTTY) {
  console.log('stdin is not a terminal: running as --no-interactive.\n');
}

// ---------------------------------------------------------------------------------------------
// Output helpers (the key is never printed)
// ---------------------------------------------------------------------------------------------

const secrets = new Set<string>([env.key]);
function safe(s: string): string {
  let out = s;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}
function say(s = ''): void {
  console.log(safe(s));
}

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
const results: { id: string; title: string; verdict: Verdict; evidence: string }[] = [];
function record(id: string, title: string, verdict: Verdict, evidence: string): void {
  results.push({ id, title, verdict, evidence });
  say(`[${id}] ${verdict}  ${title}`);
  say(`      ${evidence}`);
}

const created: { id: string; note: string }[] = [];
const measurements: string[] = [];

// ---------------------------------------------------------------------------------------------
// Human interaction
// ---------------------------------------------------------------------------------------------

const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

async function pressEnter(prompt: string): Promise<void> {
  await rl?.question(`\n>>> ${safe(prompt)}\n    Press Enter when done. `);
}

async function confirm(question: string): Promise<boolean> {
  const a = await rl?.question(`\n>>> ${safe(question)} [y/N] `);
  return /^y/i.test((a ?? '').trim());
}

/** Reads a secret without echoing it. Returns '' when the operator just presses Enter. */
async function askSecret(prompt: string): Promise<string> {
  if (!rl) return '';
  process.stdout.write(`\n>>> ${prompt}\n    (input hidden; just press Enter to skip) `);
  const out = process.stdout as unknown as { write: (...a: unknown[]) => boolean };
  const original = out.write;
  out.write = () => true;
  try {
    const v = (await rl.question('')).trim();
    if (v) secrets.add(v);
    return v;
  } finally {
    out.write = original;
    process.stdout.write('\n');
  }
}

interface Manual {
  id: string;
  title: string;
  steps: string[];
  expect: string;
}

/** Non-interactive: print the manual step and record SKIP. */
function skipManual(m: Manual): void {
  record(m.id, m.title, 'SKIP', 'manual step, not run (--no-interactive)');
  say('      MANUAL STEP:');
  for (const [i, s] of m.steps.entries()) say(`        ${i + 1}. ${s}`);
  say(`      EXPECT: ${m.expect}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: createCoreClient where it can express the check, raw undici where it cannot
// ---------------------------------------------------------------------------------------------

const client = createCoreClient(
  { apiBase: env.base, apiKey: env.key },
  { log: silentLogger(), metrics: new NoopMetrics() },
);

interface Raw {
  status: number;
  text: string;
  json: Record<string, unknown> | undefined;
  headers: Record<string, string | string[] | undefined>;
  error?: string;
}

async function raw(
  method: 'GET' | 'POST',
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; apiKey?: string | null } = {},
): Promise<Raw> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.apiKey !== null) headers['X-Resgrid-ApiKey'] = opts.apiKey ?? env.key;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  try {
    const res = await request(`${env.base}/api/v4/${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.body.text();
    let json: Record<string, unknown> | undefined;
    try {
      const p: unknown = JSON.parse(text);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) json = p as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return { status: res.statusCode, text, json, headers: res.headers };
  } catch (err) {
    return { status: 0, text: '', json: undefined, headers: {}, error: describe(err) };
  }
}

function describe(err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string };
  return safe(`${e.code ?? e.name ?? 'error'}: ${e.message ?? ''}`.slice(0, 200));
}

const brief = (r: Raw): string =>
  r.error
    ? `network error ${r.error}`
    : `HTTP ${r.status}${r.text ? ` body ${JSON.stringify(safe(r.text.slice(0, 120)))}` : ' (empty body)'}`;

// ---------------------------------------------------------------------------------------------
// Test-call bodies
// ---------------------------------------------------------------------------------------------

const runId = randomBytes(3).toString('hex');
let seq = 0;
const policy = { required: new Set<string>() };

/** A valid SaveCall body that also meets the department's current field policy. */
function body(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const b: Record<string, unknown> = {
    IsPending: true,
    Priority: PRIORITY,
    Type: env.typeName,
    Name: `${PREFIX} ${label} ${runId}`,
    Nature: `Relay live checklist test call ${runId}-${seq}. Safe to close or delete.`,
    ExternalId: `checklist-${runId}-${seq}`,
    ReferenceId: `CHK-${runId}-${seq}`,
  };
  if (policy.required.has('address')) b.Address = 'See map location';
  if (policy.required.has('contactName')) b.ContactName = 'Unknown caller';
  if (policy.required.has('geolocation')) b.Geolocation = '6.524400,3.379200';
  Object.assign(b, extra);
  for (const [k, v] of Object.entries(b)) if (v === undefined) delete b[k];
  return b;
}

const idemKey = (): string => `checklist-${runId}-${randomBytes(4).toString('hex')}`;

function idOf(r: Raw): string | undefined {
  const id = r.json?.Id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function track(id: string | undefined, note: string): void {
  if (id !== undefined && !created.some((c) => c.id === id)) created.push({ id, note });
}

async function rawSave(
  b: Record<string, unknown> | string,
  note: string,
  key = idemKey(),
  apiKey?: string,
): Promise<Raw & { id?: string; key: string }> {
  const r = await raw('POST', 'Calls/SaveCall', {
    body: b,
    headers: { 'Idempotency-Key': key },
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  const id = r.status === 200 || r.status === 201 ? idOf(r) : undefined;
  track(id, note);
  return { ...r, id, key };
}

async function pendingIds(): Promise<string[] | undefined> {
  const r = await client.getPendingCalls();
  return r.kind === 'ok' ? r.data.callIds : undefined;
}

async function getCallRaw(id: string): Promise<Raw> {
  return raw('GET', `Calls/GetCall?callId=${encodeURIComponent(id)}`);
}

function dataOf(r: Raw): Record<string, unknown> | undefined {
  const d = r.json?.Data;
  return typeof d === 'object' && d !== null && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

let firstCallId: string | undefined;

/** 0. The relay's own startup checks, against the real department. Returns false when nothing else can work. */
async function check0(): Promise<boolean> {
  const types = await client.getCallTypes();
  const prios = await client.getCallPriorities();
  const pol = await client.getFieldPolicy();
  if (types.kind === 'auth' || prios.kind === 'auth' || pol.kind === 'auth') {
    const status = [types, prios, pol].find((r) => r.kind === 'auth');
    record(
      '0',
      'Reference data and field policy readable (relay startup checks)',
      'FAIL',
      `Core answered HTTP ${status?.kind === 'auth' ? status.httpStatus : '401/403'}: key not accepted, wrong environment, or this machine is outside the key's IP allowlist.`,
    );
    return false;
  }
  if (types.kind === 'retryable' && prios.kind === 'retryable' && pol.kind === 'retryable') {
    record(
      '0',
      'Reference data and field policy readable (relay startup checks)',
      'FAIL',
      `Core is unreachable or answering errors: ${types.reason}. Check RESGRID_API_BASE.`,
    );
    return false;
  }
  const problems: string[] = [];
  const notes: string[] = [];
  if (types.kind !== 'ok') problems.push(`GetAllCallTypes failed (${types.kind})`);
  else if (!types.data.names.includes(env.typeName)) {
    problems.push(`call type "${env.typeName}" not found (have: ${types.data.names.join(', ') || 'none'})`);
  } else notes.push(`call type "${env.typeName}" exists`);
  if (prios.kind !== 'ok') problems.push(`GetAllCallPriorites failed (${prios.kind})`);
  else {
    const p = prios.data.priorities.find((x) => x.id === PRIORITY);
    if (!p) problems.push(`priority ${PRIORITY} not found`);
    else if (p.isDeleted) problems.push(`priority ${PRIORITY} is deleted`);
    else notes.push(`priority ${PRIORITY} exists`);
  }
  let abort = false;
  if (pol.kind !== 'ok') problems.push(`GetNewCallFieldPolicy failed (${pol.kind})`);
  else {
    policy.required = new Set(pol.data.requiredKeys);
    notes.push(`required keys: ${pol.data.requiredKeys.join(', ') || 'none'}`);
    const unmeetable = pol.data.requiredKeys.filter((k) =>
      ['what3words', 'incidentId', 'destinationPoi'].includes(k),
    );
    if (unmeetable.length > 0) {
      problems.push(
        `policy requires ${unmeetable.join(', ')}, which the relay can never send: every SOS would fail`,
      );
      abort = true;
    }
  }
  record(
    '0',
    'Reference data and field policy readable (relay startup checks)',
    problems.length ? 'FAIL' : 'PASS',
    [...notes, ...problems.map((p) => `PROBLEM: ${p}`)].join('; '),
  );
  return !abort;
}

/** 1. SaveCall returns 201 with a string Id; the call is pending, State 8. */
async function check1(): Promise<void> {
  const title = 'SaveCall returns 201 with a string Id; call is pending (State 8)';
  const r = await rawSave(body('basic'), 'check 1: basic pending call');
  if (r.status !== 201 || r.id === undefined) {
    return record('1', title, 'FAIL', `expected 201 with Id, got ${brief(r)}`);
  }
  firstCallId = r.id;
  const problems: string[] = [];
  if (typeof r.json?.Id !== 'string') problems.push(`Id is a ${typeof r.json?.Id}, expected string`);
  if (r.json?.Status !== 'created')
    problems.push(`Status is ${JSON.stringify(r.json?.Status)}, expected "created"`);
  const st = await client.getCall(r.id);
  const state = st.kind === 'ok' ? st.data.state : undefined;
  if (state !== 8) problems.push(`GetCall State is ${state ?? st.kind}, expected 8`);
  const ids = await pendingIds();
  if (!ids?.includes(r.id)) problems.push('call not listed by GetPendingCalls');
  record(
    '1',
    title,
    problems.length ? 'FAIL' : 'PASS',
    problems.length
      ? problems.join('; ')
      : `HTTP 201, Id "${r.id}" (string), Status "created", GetCall State 8, listed in GetPendingCalls`,
  );
}

/** 2. No notification. Human only. */
async function check2(): Promise<void> {
  const m: Manual = {
    id: '2',
    title: 'No notification of any kind is sent for a pending call',
    steps: [
      'Have a responder/dispatcher user in the test department with push, SMS and email notifications on, phone in hand.',
      `Look at call ${firstCallId ?? '(the call from check 1)'} named "${PREFIX} basic ${runId}" in Pending Calls (created a moment ago).`,
      'Check that no push, SMS, email or phone call arrived for it, and no call-broadcast alert fired.',
    ],
    expect: 'Nothing was received. Only the dispatcher screen shows it, under Pending Calls.',
  };
  if (!interactive) return skipManual(m);
  say(`\n[2] ${m.title}`);
  for (const [i, s] of m.steps.entries()) say(`      ${i + 1}. ${s}`);
  const clean = await confirm('Was NO notification of any kind sent?');
  record(
    '2',
    m.title,
    clean ? 'PASS' : 'FAIL',
    `operator-confirmed: ${clean ? 'nothing was sent' : 'operator reports a notification was sent'}`,
  );
}

/** 3. Same Idempotency-Key twice: same Id, one call. */
async function check3(): Promise<void> {
  const title = 'Same Idempotency-Key returns the same Id; only one call exists';
  const before = await pendingIds();
  const key = idemKey();
  const b = body('idempotency');
  const a = await rawSave(b, 'check 3: idempotency', key);
  const c = await rawSave(b, 'check 3: idempotency (repeat)', key);
  const after = await pendingIds();
  const fresh = before && after ? after.filter((id) => !before.includes(id)) : undefined;
  const problems: string[] = [];
  if (a.status !== 201) problems.push(`first request: ${brief(a)}`);
  if (c.status !== 201) problems.push(`repeat request: ${brief(c)}`);
  if (a.id && c.id && a.id !== c.id) problems.push(`Ids differ: ${a.id} vs ${c.id}`);
  if (!fresh) problems.push('could not list pending calls to count');
  else if (fresh.length !== 1)
    problems.push(`${fresh.length} new pending calls appeared, expected 1 (${fresh.join(', ')})`);
  record(
    '3',
    title,
    problems.length ? 'FAIL' : 'PASS',
    problems.length
      ? problems.join('; ')
      : `both requests HTTP 201 with Id "${a.id}"; exactly 1 new pending call`,
  );
}

/** 4. Two simultaneous requests with the same key. */
async function check4(): Promise<void> {
  const title = 'Two simultaneous requests with one key produce one call';
  const before = await pendingIds();
  const key = idemKey();
  const b = body('simultaneous');
  const [x, y] = await Promise.all([
    rawSave(b, 'check 4: simultaneous A', key),
    rawSave(b, 'check 4: simultaneous B', key),
  ]);
  let statuses = [x.status, y.status];
  let ids = [x.id, y.id].filter((v): v is string => v !== undefined);
  if (statuses.includes(409) && ids.length === 0) {
    await sleep(1500);
    const retry = await rawSave(b, 'check 4: simultaneous retry', key);
    statuses = [...statuses, retry.status];
    if (retry.id) ids = [retry.id];
  }
  const after = await pendingIds();
  const fresh = before && after ? after.filter((id) => !before.includes(id)) : undefined;
  const problems: string[] = [];
  if (statuses.some((s) => s !== 201 && s !== 409))
    problems.push(`unexpected statuses ${statuses.join(', ')}`);
  if (new Set(ids).size !== 1) problems.push(`expected one distinct Id, saw [${ids.join(', ')}]`);
  if (!fresh) problems.push('could not list pending calls to count');
  else if (fresh.length !== 1) problems.push(`${fresh.length} new pending calls appeared, expected 1`);
  record(
    '4',
    title,
    problems.length ? 'FAIL' : 'PASS',
    problems.length
      ? problems.join('; ')
      : `statuses ${statuses.join(', ')}; one Id "${ids[0]}"; exactly 1 new pending call`,
  );
}

/** 5. A wrong call type name is silently dropped. */
async function check5(): Promise<void> {
  const title = 'A wrong call type name creates a call with no type';
  const wrong = `${PREFIX} no-such-type ${runId}`;
  const r = await rawSave(body('wrong type', { Type: wrong }), 'check 5: wrong call type name');
  if (r.status !== 201 || !r.id)
    return record('5', title, 'FAIL', `expected 201 (type silently dropped), got ${brief(r)}`);
  const g = await getCallRaw(r.id);
  const d = dataOf(g);
  const typeKeys = d ? Object.keys(d).filter((k) => /type/i.test(k)) : [];
  const shown = typeKeys.map((k) => `${k}=${JSON.stringify(d?.[k])}`).join(', ');
  const empty = (v: unknown) =>
    v === null || v === undefined || v === '' || v === 0 || v === '0' || v === 'No Type';
  if (typeKeys.length === 0) {
    return record(
      '5',
      title,
      'SKIP',
      `HTTP 201 (not rejected), but GetCall exposes no type field. Open call ${r.id} in Resgrid and confirm it has no type.`,
    );
  }
  const nameKey = typeKeys.find((k) => d?.[k] === wrong);
  if (nameKey) return record('5', title, 'FAIL', `GetCall shows the unknown type was stored: ${shown}`);
  if (typeKeys.every((k) => empty(d?.[k]))) {
    return record(
      '5',
      title,
      'PASS',
      `HTTP 201 and GetCall shows no type (${shown}); the relay's startup type check is therefore needed`,
    );
  }
  record(
    '5',
    title,
    'SKIP',
    `HTTP 201, GetCall type fields: ${shown}. Cannot tell if empty; confirm call ${r.id} has no type in Resgrid.`,
  );
}

async function refreshPolicy(): Promise<void> {
  const p = await client.getFieldPolicy();
  if (p.kind === 'ok') policy.required = new Set(p.data.requiredKeys);
}

/** 6. address required, none sent: 400 "Required call fields are missing: address". */
async function check6(): Promise<void> {
  const title = 'Required address, none sent: 400 "Required call fields are missing: address"';
  const m: Manual = {
    id: '6',
    title,
    steps: [
      'In Resgrid (test department) open the new-call field policy and make Address required.',
      'Re-run this check (or follow the prompt in interactive mode).',
      'Afterwards, restore the original policy.',
    ],
    expect:
      'SaveCall without Address returns HTTP 400 whose body starts "Required call fields are missing: " and lists address.',
  };
  if (!policy.required.has('address')) {
    if (!interactive) return skipManual(m);
    say(`\n[6] ${title}`);
    await pressEnter(
      'In Resgrid, make "Address" REQUIRED in the new-call field policy (test department only).',
    );
    await refreshPolicy();
    if (!policy.required.has('address')) {
      return record(
        '6',
        title,
        'FAIL',
        'GetNewCallFieldPolicy does not show address as required after the change',
      );
    }
  }
  const b = body('address required');
  delete b.Address;
  const r = await rawSave(b, 'check 6: address required, none sent');
  const ok =
    r.status === 400 &&
    /^"?Required call fields are missing: /.test(r.text.trim()) &&
    /address/i.test(r.text);
  record(
    '6',
    title,
    ok ? 'PASS' : 'FAIL',
    ok
      ? `HTTP 400 ${JSON.stringify(safe(r.text.slice(0, 120)))}`
      : `expected 400 with the missing-fields message, got ${brief(r)}`,
  );
  if (interactive) {
    await pressEnter('Restore the field policy to what it was (so later checks run as the relay will).');
    await refreshPolicy();
  }
}

/** 7. "LinkedCallId": "" is rejected when the requirement is on; omitting it succeeds. */
async function check7(): Promise<void> {
  const title = '"LinkedCallId": "" returns 400 when the linked-call requirement is on; omitting it succeeds';
  const m: Manual = {
    id: '7',
    title,
    steps: [
      'In Resgrid (test department) make "Linked call" required in the new-call field policy.',
      'Re-run in interactive mode: the script sends "LinkedCallId": "" and then a body without the field.',
      'Afterwards, restore the original policy.',
    ],
    expect: 'The blank-field request returns 400; the request that omits the field returns 201.',
  };
  if (!interactive) return skipManual(m);
  say(`\n[7] ${title}`);
  await pressEnter(
    'In Resgrid, make "Linked call" REQUIRED in the new-call field policy (test department only).',
  );
  await refreshPolicy();
  if (!policy.required.has('linkedCall')) {
    return record(
      '7',
      title,
      'FAIL',
      'GetNewCallFieldPolicy does not show linkedCall as required after the change',
    );
  }
  const blank = await rawSave(
    body('linked call blank', { LinkedCallId: '' }),
    'check 7: LinkedCallId "" (should not exist)',
  );
  const omitted = await rawSave(body('linked call omitted'), 'check 7: LinkedCallId omitted');
  const problems: string[] = [];
  if (blank.status !== 400) problems.push(`blank LinkedCallId: expected 400, got ${brief(blank)}`);
  if (omitted.status !== 201) problems.push(`omitted LinkedCallId: expected 201, got ${brief(omitted)}`);
  record(
    '7',
    title,
    problems.length ? 'FAIL' : 'PASS',
    problems.length ? problems.join('; ') : 'blank field: HTTP 400; field omitted: HTTP 201',
  );
  await pressEnter('Restore the field policy to what it was.');
  await refreshPolicy();
}

/** 8. GetCall State 8, then 0 after dispatch, then a closed state after close. */
async function check8(): Promise<void> {
  const title = 'GetCall returns State 8, then 0 after dispatch, then a closed state after close';
  if (!firstCallId) return record('8', title, 'SKIP', 'check 1 did not create a call');
  const id = firstCallId;
  const s0 = await client.getCall(id);
  const st0 = s0.kind === 'ok' ? s0.data.state : undefined;
  if (st0 !== 8)
    return record('8', title, 'FAIL', `before dispatch GetCall State is ${st0 ?? s0.kind}, expected 8`);
  if (!interactive) {
    return skipManual({
      id: '8',
      title: `${title} (State 8 verified automatically; dispatch and close are manual)`,
      steps: [
        `In Resgrid, dispatch call ${id} ("${PREFIX} basic ${runId}") from Pending Calls.`,
        `Run: curl -s -H "X-Resgrid-ApiKey: $RESGRID_API_KEY" "$RESGRID_API_BASE/api/v4/Calls/GetCall?callId=${id}"`,
        'Then close the call and run the same GetCall again.',
      ],
      expect: 'State 0 after dispatch, then a State from 1 to 7 after close.',
    });
  }
  say(`\n[8] ${title}\n      State is 8 before dispatch: confirmed.`);
  await pressEnter(
    `Dispatch call ${id} ("${PREFIX} basic ${runId}") in Resgrid now. A dispatch notifies the test department; use a test department.`,
  );
  await sleep(1000);
  const s1 = await client.getCall(id);
  const st1 = s1.kind === 'ok' ? s1.data.state : undefined;
  if (st1 !== 0)
    return record('8', title, 'FAIL', `after dispatch GetCall State is ${st1 ?? s1.kind}, expected 0`);
  await pressEnter(`Close call ${id} in Resgrid now (any close type).`);
  await sleep(1000);
  const s2 = await client.getCall(id);
  const st2 = s2.kind === 'ok' ? s2.data.state : undefined;
  const closed = st2 !== undefined && st2 >= 1 && st2 <= 7;
  record(
    '8',
    title,
    closed ? 'PASS' : 'FAIL',
    closed ? `State 8 -> 0 -> ${st2}` : `after close GetCall State is ${st2 ?? s2.kind}, expected 1 to 7`,
  );
}

/** 9. Unknown id: HTTP 200, Status "not_found". */
async function check9(): Promise<void> {
  const title = 'GetCall with an unknown id returns HTTP 200 and Status "not_found"';
  const r = await getCallRaw('2147483000');
  const viaClient = await client.getCall('2147483000');
  const ok = r.status === 200 && r.json?.Status === 'not_found';
  const clientOk = viaClient.kind === 'ok' && viaClient.data.notFound;
  record(
    '9',
    title,
    ok && clientOk ? 'PASS' : 'FAIL',
    ok
      ? `HTTP 200 Status "not_found"; relay client maps it to ${clientOk ? 'not found / closed' : `an unexpected result (${viaClient.kind})`}`
      : `got ${brief(r)}`,
  );
}

/** 10. X-Resgrid-ApiKey together with Authorization: 401. A read endpoint, so a wrong answer cannot create a call. */
async function check10(): Promise<void> {
  const title = 'A request carrying both X-Resgrid-ApiKey and Authorization returns 401';
  const both = await raw('GET', 'Calls/GetNewCallFieldPolicy', {
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  const plain = await raw('GET', 'Calls/GetNewCallFieldPolicy');
  const ok = both.status === 401 && plain.status === 200;
  record(
    '10',
    title,
    ok ? 'PASS' : 'FAIL',
    ok
      ? 'key + Authorization: HTTP 401; the same request without Authorization: HTTP 200 (GetNewCallFieldPolicy)'
      : `with Authorization: ${brief(both)}; without: ${brief(plain)}`,
  );
}

/** 11. A key without calls.create: 403 on SaveCall. */
async function check11(): Promise<void> {
  const title = 'A key without calls.create returns 403 on SaveCall';
  const m: Manual = {
    id: '11',
    title,
    steps: [
      'In Resgrid create a second, throwaway API key with scopes calls.read and reference.read only (no calls.create).',
      'Re-run in interactive mode and paste it when asked, or run: curl -i -X POST -H "X-Resgrid-ApiKey: <that key>" -H "Content-Type: application/json" -d \'{"IsPending":true,"Priority":<id>,"Name":"[RELAY CHECKLIST] no scope","Nature":"x"}\' "$RESGRID_API_BASE/api/v4/Calls/SaveCall"',
      'Revoke the throwaway key afterwards.',
    ],
    expect: 'HTTP 403.',
  };
  if (!interactive) return skipManual(m);
  say(`\n[11] ${title}`);
  say('      Create a throwaway key in Resgrid with calls.read and reference.read only (NOT calls.create).');
  const k = await askSecret('Paste that key:');
  if (!k) return record('11', title, 'SKIP', 'no key given');
  const r = await rawSave(
    body('no calls.create scope'),
    'check 11: key WITHOUT calls.create (should not exist)',
    idemKey(),
    k,
  );
  record(
    '11',
    title,
    r.status === 403 ? 'PASS' : 'FAIL',
    r.status === 403 ? 'HTTP 403' : `expected 403, got ${brief(r)}`,
  );
  say('      Revoke the throwaway key now.');
}

/** 12. IP allowlist: needs another address. */
async function check12(): Promise<void> {
  const title = "A request from an address outside the key's IP allowlist returns 401";
  const m: Manual = {
    id: '12',
    title,
    steps: [
      "In Resgrid set the key's IP allowlist to the relay's static egress IP(s) only.",
      'From a machine NOT on that list (a laptop on another network), with the same key exported as RESGRID_API_KEY, run: curl -i -H "X-Resgrid-ApiKey: $RESGRID_API_KEY" "$RESGRID_API_BASE/api/v4/Calls/GetNewCallFieldPolicy"',
      'From the allowed address, run the same command.',
      'Keys change in up to 60 seconds, so wait a minute after editing the allowlist.',
    ],
    expect: 'HTTP 401 from the outside address, HTTP 200 from the allowed one.',
  };
  if (!interactive) return skipManual(m);
  say(`\n[12] ${title}`);
  for (const [i, s] of m.steps.entries()) say(`      ${i + 1}. ${s}`);
  const ok = await confirm('Did the outside address get 401 and the allowed address get 200?');
  record(
    '12',
    title,
    ok ? 'PASS' : 'FAIL',
    `operator-confirmed: ${ok ? '401 outside, 200 inside' : 'operator reports a different result'}`,
  );
}

/** 13. A revoked key returns 401 within about 60 seconds. */
async function check13(): Promise<void> {
  const title = 'A revoked key returns 401 within about 60 seconds';
  const m: Manual = {
    id: '13',
    title,
    steps: [
      'In Resgrid create a throwaway key with reference.read (or all three scopes).',
      'Re-run in interactive mode: paste it, confirm it works, revoke it when told, and the script polls until it gets 401.',
      'Or by hand: revoke the key, then run GetAllCallTypes with it every 10 seconds and note when it first returns 401.',
    ],
    expect: 'HTTP 401 within about 60 seconds of the revocation (the script allows up to 75 s).',
  };
  if (!interactive) return skipManual(m);
  say(`\n[13] ${title}`);
  say('      Create a throwaway key in Resgrid (reference.read is enough). Do NOT use the relay key.');
  const k = await askSecret('Paste the throwaway key:');
  if (!k) return record('13', title, 'SKIP', 'no key given');
  const probe = () => raw('GET', 'CallTypes/GetAllCallTypes', { apiKey: k });
  const before = await probe();
  if (before.status !== 200)
    return record('13', title, 'FAIL', `the throwaway key did not work before revocation: ${brief(before)}`);
  await pressEnter('Revoke the throwaway key in Resgrid now.');
  const started = Date.now();
  let status = 200;
  while (Date.now() - started < 120_000) {
    status = (await probe()).status;
    if (status === 401) break;
    await sleep(5000);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const ok = status === 401 && secs <= 75;
  record(
    '13',
    title,
    ok ? 'PASS' : 'FAIL',
    status === 401
      ? `401 after about ${secs} s${ok ? '' : ' (over the 75 s allowance)'}`
      : `still HTTP ${status} after ${secs} s`,
  );
}

/** 14a. What GetCall returns for a deleted call. A measurement. */
async function check14a(): Promise<void> {
  const title = 'Measurement: what GetCall returns for a deleted call';
  const m: Manual = {
    id: '14a',
    title,
    steps: [
      'In Resgrid delete one of the test calls (or create a call and delete it).',
      'Run: curl -s -H "X-Resgrid-ApiKey: $RESGRID_API_KEY" "$RESGRID_API_BASE/api/v4/Calls/GetCall?callId=<id>"',
      'Record the HTTP status, Status, and Data.State. Put the finding in PRD risk R4.',
    ],
    expect: 'Either Status "not_found" or the last State. Both map to a sensible relay status.',
  };
  if (!interactive) return skipManual(m);
  say(`\n[14a] ${title}`);
  const r = await rawSave(body('delete me'), 'check 14a: DELETE THIS CALL');
  if (!r.id) return record('14a', title, 'FAIL', `could not create the call to delete: ${brief(r)}`);
  await pressEnter(`DELETE call ${r.id} ("${PREFIX} delete me ${runId}") in Resgrid now.`);
  const g = await getCallRaw(r.id);
  const d = dataOf(g);
  const finding = `GetCall for deleted call ${r.id}: HTTP ${g.status}, Status ${JSON.stringify(g.json?.Status)}, Data ${d ? `present, State ${JSON.stringify(d.State)}` : 'absent'}`;
  measurements.push(finding);
  record('14a', title, g.status === 0 ? 'FAIL' : 'PASS', `recorded: ${finding}`);
}

/** 14b. Longest Name, Nature, Address and Note that Core accepts. A measurement; a few calls. */
async function check14b(): Promise<void> {
  const title = 'Measurement: longest Name, Nature, Address and Note Core accepts';
  const plan: { field: 'Name' | 'Nature' | 'Address' | 'Note'; sizes: number[] }[] = [
    { field: 'Name', sizes: [100, 250, 500] },
    { field: 'Nature', sizes: [500, 1500, 4000] },
    { field: 'Address', sizes: [250, 1000, 4000] },
    { field: 'Note', sizes: [1000, 4000, 16000] },
  ];
  const findings: string[] = [];
  let hardError = false;
  for (const { field, sizes } of plan) {
    let best = 0;
    let stored: string | undefined;
    let failure: string | undefined;
    for (const size of sizes) {
      const filler = (n: number) => 'x'.repeat(Math.max(0, n));
      const extra: Record<string, unknown> = {};
      if (field === 'Name') extra.Name = `${PREFIX} len ${runId} ${filler(size)}`.slice(0, size);
      else extra[field] = filler(size);
      // A point stops Core geocoding the (long) address.
      if (field === 'Address') extra.Geolocation = '6.524400,3.379200';
      const r = await rawSave(body(`length ${field} ${size}`, extra), `check 14b: ${field} ${size} chars`);
      if (r.status === 201 && r.id) {
        best = size;
        const d = dataOf(await getCallRaw(r.id));
        const v = d?.[field];
        stored =
          typeof v === 'string'
            ? `stored length ${v.length}`
            : 'GetCall does not return this field, stored length not checked';
      } else {
        failure = `${size} chars rejected: ${brief(r)}`;
        if (r.status === 0 || r.status >= 500) hardError = true;
        break;
      }
    }
    const top = sizes[sizes.length - 1];
    findings.push(
      best === 0
        ? `${field}: even ${sizes[0]} chars failed (${failure})`
        : failure
          ? `${field}: largest accepted ${best} chars (${stored}); ${failure}`
          : `${field}: all probed sizes accepted, up to ${top} chars (${stored}); the true limit is at least ${top}`,
    );
  }
  for (const f of findings) measurements.push(f);
  record(
    '14b',
    title,
    hardError ? 'FAIL' : 'PASS',
    `recorded: ${findings.join(' | ')}${hardError ? ' (a probe failed with a 5xx or network error: the result is not a clean limit)' : ''}`,
  );
}

/** A tiny, valid-looking m4a header: the checklist attaches this, never real audio. */
const SAMPLE_FILE = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00, 0x4d, 0x34,
  0x41, 0x20, 0x6d, 0x70, 0x34, 0x32,
]);

/** A SaveCallFile body, as the client sends it, for the raw probes. */
function fileBody(callId: string, name: string): Record<string, unknown> {
  return {
    CallId: callId,
    UserId: '00000000-0000-0000-0000-000000000000',
    Type: 1,
    Name: name,
    Data: SAMPLE_FILE.toString('base64'),
  };
}

/** 15. SaveCallFile: attach to a pending call, and what Core answers for a call that is not open. */
async function check15(): Promise<void> {
  const title = 'SaveCallFile attaches a file to a pending call, and refuses a closed or unknown call';
  const evidence: string[] = [];
  const problems: string[] = [];

  const made = await rawSave(body('attach'), 'check 15: attached a test file');
  if (!made.id) return record('15', title, 'FAIL', `could not create the call to attach to: ${brief(made)}`);
  const id = made.id;

  // 1. The client, as the relay uses it.
  const name = `CHK-${runId}-1.m4a`;
  const ok = await client.saveCallFile({ callId: id, name, data: SAMPLE_FILE });
  if (ok.kind === 'ok') evidence.push(`pending call ${id}: attached as file ${ok.data.fileId}`);
  else problems.push(`attach to pending call ${id} gave ${JSON.stringify(ok)}, expected ok`);

  // 2. The raw answer, and whether an Idempotency-Key is honoured (a measurement, plan §2.2).
  const key = idemKey();
  const a = await raw('POST', 'CallFiles/SaveCallFile', {
    body: fileBody(id, `CHK-${runId}-idem.m4a`),
    headers: { 'Idempotency-Key': key },
  });
  const b = await raw('POST', 'CallFiles/SaveCallFile', {
    body: fileBody(id, `CHK-${runId}-idem.m4a`),
    headers: { 'Idempotency-Key': key },
  });
  if (a.status !== 201) problems.push(`raw attach: ${brief(a)}, expected HTTP 201 with an Id`);
  else if (idOf(a) === undefined)
    problems.push(`raw attach: HTTP 201 without an Id in ${JSON.stringify(a.text.slice(0, 120))}`);
  else {
    const honoured = a.status === b.status && idOf(a) === idOf(b);
    const finding = `SaveCallFile with the same Idempotency-Key twice: ids ${idOf(a)} and ${idOf(b) ?? brief(b)}, so the key is ${honoured ? 'HONOURED' : 'NOT honoured (a retry after a lost 201 attaches twice)'}`;
    measurements.push(finding);
    evidence.push(finding);
  }
  if (interactive) {
    say(`\n[15] ${title}`);
    const seen = await confirm(
      `Open call ${id} ("${PREFIX} attach ${runId}") in Resgrid. Is "${name}" attached (plus the "CHK-${runId}-idem.m4a" file(s))?`,
    );
    if (!seen) problems.push('the operator did not see the attached file on the call');
    else evidence.push('operator saw the file on the call');
  } else {
    evidence.push(`check by hand that call ${id} shows ${name} (--no-interactive)`);
  }

  // 3. A call that does not exist. The swagger declares only 400 ProblemDetails; the client must read it as closed.
  const ghost = '2147483000';
  const gr = await raw('POST', 'CallFiles/SaveCallFile', { body: fileBody(ghost, `CHK-${runId}-x.m4a`) });
  const gc = await client.saveCallFile({ callId: ghost, name: `CHK-${runId}-x.m4a`, data: SAMPLE_FILE });
  const ghostFinding = `unknown call ${ghost}: ${brief(gr)} -> client says ${gc.kind}`;
  measurements.push(`SaveCallFile, unknown call: ${brief(gr)}`);
  evidence.push(ghostFinding);
  if (gc.kind !== 'call_closed') {
    problems.push(
      `unknown call is not read as call_closed (${gc.kind}): update CALL_CLOSED_STATUSES in src/core/client.ts`,
    );
  }

  // 4. A closed call. Closing needs the Resgrid UI (the key has no calls.close).
  const closedSteps = [
    `In Resgrid, dispatch call ${id} ("${PREFIX} attach ${runId}") if needed, then CLOSE it (any close type).`,
    `Try to attach a file to it: curl -s -XPOST -H "X-Resgrid-ApiKey: $RESGRID_API_KEY" -H 'Content-Type: application/json' -d '{"CallId":"${id}","UserId":"00000000-0000-0000-0000-000000000000","Type":1,"Name":"x.m4a","Data":"AAAA"}' "$RESGRID_API_BASE/api/v4/CallFiles/SaveCallFile"`,
    'Record the HTTP status and body. It must be 400 (ProblemDetails), which the client reads as call_closed.',
  ];
  if (!interactive) {
    record(
      '15',
      title,
      problems.length ? 'FAIL' : 'SKIP',
      [
        ...evidence,
        ...problems.map((p) => `PROBLEM: ${p}`),
        'closed-call answer NOT measured: manual step, not run (--no-interactive)',
      ].join('; '),
    );
    say('      MANUAL STEP:');
    for (const [i, st] of closedSteps.entries()) say(`        ${i + 1}. ${st}`);
    say(
      '      EXPECT: HTTP 400 ProblemDetails (what the client maps to call_closed). Anything else: change src/core/client.ts.',
    );
    return;
  }
  await pressEnter(
    `Close call ${id} ("${PREFIX} attach ${runId}") in Resgrid now (dispatch it first if Core needs that).`,
  );
  await sleep(1000);
  const cr = await raw('POST', 'CallFiles/SaveCallFile', { body: fileBody(id, `CHK-${runId}-closed.m4a`) });
  const cc = await client.saveCallFile({ callId: id, name: `CHK-${runId}-closed.m4a`, data: SAMPLE_FILE });
  const closedFinding = `closed call ${id}: ${brief(cr)} -> client says ${cc.kind}`;
  measurements.push(`SaveCallFile, closed call: ${brief(cr)}`);
  evidence.push(closedFinding);
  if (cc.kind !== 'call_closed') {
    problems.push(
      `a closed call is not read as call_closed (${cc.kind}; ${brief(cr)}): update CALL_CLOSED_STATUSES in src/core/client.ts`,
    );
  }
  record(
    '15',
    title,
    problems.length ? 'FAIL' : 'PASS',
    [...evidence, ...problems.map((p) => `PROBLEM: ${p}`)].join('; '),
  );
}

/** 16. GetAllUnitStatuses: the response has the shape the relay maps. */
async function check16(): Promise<void> {
  const title = 'GetAllUnitStatuses returns the fields the relay maps (units.read)';
  const r = await raw('GET', 'UnitStatus/GetAllUnitStatuses');
  if (r.status === 401 || r.status === 403) {
    return record('16', title, 'FAIL', `${brief(r)}: the key lacks units.read`);
  }
  if (r.status !== 200 || !r.json) return record('16', title, 'FAIL', brief(r));
  const status = r.json.Status;
  if (status !== 'success' && status !== 'not_found') {
    return record(
      '16',
      title,
      'FAIL',
      `HTTP 200 but Status ${JSON.stringify(status)}, expected "success" or "not_found"`,
    );
  }
  const viaClient = await client.getAllUnitStatuses();
  if (viaClient.kind !== 'ok')
    return record('16', title, 'FAIL', `the client could not read it: ${viaClient.kind}`);
  const rows = Array.isArray(r.json.Data)
    ? (r.json.Data as unknown[]).filter(
        (x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x),
      )
    : [];
  if (rows.length === 0) {
    return record(
      '16',
      title,
      'SKIP',
      `Status ${JSON.stringify(status)} with no units: the field names are NOT verified. Add a unit to the test department, give it a status with a call destination, and run again.`,
    );
  }
  const expected = [
    'UnitId',
    'Type',
    'State',
    'DestinationType',
    'DestinationId',
    'Latitude',
    'Longitude',
    'Timestamp',
  ];
  const present = new Set(rows.flatMap((x) => Object.keys(x)));
  const absent = expected.filter((k) => !present.has(k));
  const typeOf = (k: string): string => {
    const kinds = new Set(rows.map((x) => (x[k] === null ? 'null' : typeof x[k])));
    return [...kinds].join('|');
  };
  const types = expected.filter((k) => present.has(k)).map((k) => `${k}:${typeOf(k)}`);
  const noId = rows.filter((x) => x.UnitId === undefined || x.UnitId === null || x.UnitId === '').length;
  const toCall = viaClient.data.units.filter((u) => u.destinationType === 2).length;
  const finding = `GetAllUnitStatuses fields: ${types.join(', ')}${absent.length ? `; absent in every row: ${absent.join(', ')}` : ''}`;
  measurements.push(finding);
  const problems: string[] = [];
  if (noId > 0) problems.push(`${noId} row(s) have no UnitId`);
  if (!present.has('UnitId')) problems.push('no row has UnitId');
  record(
    '16',
    title,
    problems.length ? 'FAIL' : 'PASS',
    [
      `${rows.length} unit(s), ${viaClient.data.units.length} mapped, ${toCall} heading to a call`,
      finding,
      ...problems.map((p) => `PROBLEM: ${p}`),
    ].join('; '),
  );
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function summary(): number {
  say('\n==================================================================================');
  say(' SUMMARY');
  say('==================================================================================');
  for (const r of results) say(`  [${r.id}] ${r.verdict}  ${r.title}`);
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  say(
    `\n  ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped (manual or not applicable)`,
  );
  if (count('SKIP') > 0) {
    say('  Skipped items are NOT proven. Run them (without --no-interactive) or by hand before go-live.');
  }
  if (measurements.length > 0) {
    say('\n  MEASUREMENTS TO RECORD (sos-relay-PRD.md R3 and R4, integration.md section 11):');
    for (const m of measurements) say(`   - ${m}`);
  }
  say(`\n  TEST CALLS CREATED IN ${env.base}: ${created.length}`);
  for (const c of created) say(`   - call ${c.id}  (${c.note})`);
  if (created.length > 0) {
    say(`\n  Core's API offers the relay no way to delete calls. Close or delete each call above by hand`);
    say(`  in Resgrid (search the Pending Calls list for "${PREFIX}" or run id ${runId}).`);
  }
  return count('FAIL') > 0 ? 1 : 0;
}

let finished = false;
function finish(code: number): never {
  finished = true;
  rl?.close();
  process.exit(code);
}
process.on('SIGINT', () => {
  if (finished) return;
  say('\n\nInterrupted.');
  finish(summary() || 1);
});

async function main(): Promise<number> {
  say(
    `Run id ${runId}. Mode: ${interactive ? 'interactive' : 'no-interactive (manual steps are printed and skipped)'}.\n`,
  );
  const steps: Array<() => Promise<unknown>> = [];
  if (!(await check0())) {
    say('\nCannot continue: nothing further can work until this is fixed. No calls were created.');
    return summary() || 1;
  }
  steps.push(
    check1,
    check2,
    check3,
    check4,
    check5,
    check6,
    check7,
    check8,
    check9,
    check10,
    check11,
    check12,
    check13,
    check14a,
    check14b,
    check15,
    check16,
  );
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      record(step.name.replace('check', ''), `${step.name} threw`, 'FAIL', describe(err));
    }
  }
  return summary();
}

main()
  .then((code) => finish(code))
  .catch((err) => {
    say(`\nUnexpected error: ${describe(err)}`);
    finish(summary() || 1);
  });
