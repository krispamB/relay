# SOS Relay: Core Integration Guide

| | |
|---|---|
| **Audience** | Whoever builds `sos-relay` (Node.js / Fastify) in its own repo |
| **Purpose** | Everything the relay needs to know to talk to Resgrid Core (Sentinel). Core's source is not needed alongside this. |
| **Date** | 2026-11-16 |
| **Verified against** | Sentinel repo, branch `feature/sentinel-branding`, commit `1977c523` |
| **Companion** | `sos-relay-PRD.md`. Where the two disagree, **this document wins** (see §12). |

Core is not changed for this integration. The relay uses the public v4 REST API with a department API key.

---

## 1. Quick reference

| | |
|---|---|
| Base URL | `{RESGRID_API_BASE}/api/v4/` |
| Auth header | `X-Resgrid-ApiKey: rgk_…` |
| Key scopes needed | `calls.create`, `calls.read`, `calls.update`, `units.read`, `reference.read` |
| Content type | `application/json` |
| Response field casing | **PascalCase** (`Id`, `Status`, `Data`, `State`) |
| Retry safety | Send `Idempotency-Key` on `SaveCall` |

| Purpose | Method and path | Scope |
|---|---|---|
| Create the pending call | `POST Calls/SaveCall` | `calls.create` |
| Read one call's state | `GET Calls/GetCall?callId={id}` | `calls.read` |
| List all pending calls | `GET Calls/GetPendingCalls` | `calls.read` |
| Read the required-field policy | `GET Calls/GetNewCallFieldPolicy` | `calls.read` |
| List call types | `GET CallTypes/GetAllCallTypes` | `reference.read` |
| List call priorities | `GET CallPriorities/GetAllCallPriorites` | `reference.read` |
| Attach a call file (voice recording) | `POST CallFiles/SaveCallFile` | `calls.update` |
| Unit statuses (all units) | `GET UnitStatus/GetAllUnitStatuses` | `units.read` |

`GetAllCallPriorites` is misspelled in Core. Use it exactly as written.

---

## 2. Authentication

### 2.1 The key
- Format: `rgk_` + 8-character prefix + `_` + 43-character secret, about 56 characters in total. Core rejects anything shorter than 40 or longer than 100 characters, or not starting with `rgk_`, without looking it up.
- A department admin creates it in the Resgrid web UI under Security → API Keys. It is shown once.
- A key belongs to one department. Every request runs **as that department's managing user**, limited to the key's scopes. There is no way to act for another department with it.
- Maximum lifetime is 730 days. Core has no endpoint to read a key's expiry, so the relay must be told the date in its own config.

### 2.2 Sending it
```
X-Resgrid-ApiKey: rgk_AbCdEfGh_…
```
- **Never send `Authorization` or `X-Resgrid-SystemApiKey` in the same request.** Core fails the request with 401 if either is present next to the key. Check that the HTTP client adds no default `Authorization` header.
- The key works **only** on endpoints that carry a key scope (the six in §1 are all of the ones the relay needs). On any other endpoint the key is ignored and the request gets 401.

### 2.3 What auth failures look like

| Situation | HTTP | Counts toward lockout? |
|---|---|---|
| Key not recognised (typo, wrong environment) | 401 | **Yes** |
| Key revoked | 401 | No |
| Key expired | 401 | No |
| Request came from an address outside the key's IP allowlist | 401 | No |
| Key's department is unavailable | 401 | No |
| Key sent together with `Authorization` | 401 | No |
| Key is valid but lacks the endpoint's scope | 403 | No |

Core does not put the reason in the response body, so the relay cannot tell these 401 cases apart. Treat every 401 as "stop and alert".

### 2.4 Lockout
- After **20 unrecognised keys from one source address within 10 minutes**, Core refuses every key from that address until the window passes.
- Only unrecognised keys count. A revoked or expired key does not trip it.
- The counter is kept in memory on each Core instance, so behind a load balancer the real threshold may be higher. Don't rely on that.
- **Relay rule:** on any 401, pause that department's delivery queue and raise a critical alert. Do not retry on a timer. Resume only after an operator confirms the key.

### 2.5 IP allowlist
- A key can be restricted to IP addresses or CIDR ranges. An empty list allows any address.
- Core checks the client address after applying its trusted proxy headers, so the address it sees is the relay's public egress IP. The relay needs a **static egress IP**, and that IP goes in the key's allowlist.
- A request from any other address gets 401, which makes a leaked key useless elsewhere.

### 2.6 Key changes take up to 60 seconds
Core caches key lookups for up to 60 seconds. A newly revoked key can keep working for that long, and a new allowlist can take that long to apply.

---

## 3. Response conventions

Every v4 response body extends the same envelope:

```json
{
  "PageSize": 0,
  "Page": 0,
  "Timestamp": "2026-11-16T14:03:22.123Z",
  "Version": "v4",
  "Node": "core-01",
  "Environment": "Prod",
  "RequestId": "00-4bf92f…",
  "Status": "created",
  "PreviousPageUrl": null,
  "NextPageUrl": null
}
```

- `Status` values: `success`, `created`, `updated`, `deleted`, `queued`, `failure`, `not_found`.
- **"Not found" is usually HTTP 200 with `Status: "not_found"`.** Always read `Status`, not just the HTTP code.
- Log `RequestId` with every Core call. It is what a Core operator needs to trace a request.
- Request bodies: send PascalCase property names as shown in this document. Core's JSON reader accepts other casings, but matching the documented names avoids surprises.
- Error responses (400, 401, 403, 409) are **not** in the envelope. A 400 body is either empty or a plain-text / JSON-string message. Parse error bodies defensively.

---

## 4. Create a pending call: `POST Calls/SaveCall`

### 4.1 Request

```http
POST /api/v4/Calls/SaveCall
X-Resgrid-ApiKey: rgk_…
Content-Type: application/json
Idempotency-Key: sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD
```

```json
{
  "IsPending": true,
  "Priority": 3,
  "Type": "Public SOS",
  "Name": "[PUBLIC SOS] Medical emergency",
  "Nature": "Medical emergency. Man collapsed, not breathing",
  "Geolocation": "6.524400,3.379200",
  "Address": "12 Marina Rd",
  "ContactName": "Ade",
  "ContactInfo": "+2348012345678",
  "ExternalId": "sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD",
  "ReferenceId": "SOS-7KQ2",
  "Note": "Public SOS submission (unverified member of the public)\nSubmitted: 2026-11-16T14:03:22Z   Reference: SOS-7KQ2\n…"
}
```

### 4.2 Fields the relay sends

| Field | Type | Required by Core | Notes |
|---|---|---|---|
| `IsPending` | bool | No | **Always `true`.** Without it the call is created active and Core pages the whole department. |
| `Priority` | int | **Yes** | A department call-priority id, from relay config. Validate it against `GetAllCallPriorites` at startup. Core does not check that the id exists. |
| `Name` | string | **Yes** | Core returns 400 if missing or empty. |
| `Nature` | string | **Yes** | Core returns 400 if missing or empty. |
| `Type` | string | No | The call type's **name**, matched exactly and case-sensitively. An unknown name is silently dropped and the call is saved with no type, so validate it at startup. |
| `Geolocation` | string | No | `"lat,lon"` in decimal degrees, dot as the decimal separator, no spaces. If it can't be parsed, Core ignores it and tries to geocode `Address` instead. |
| `Address` | string | No | Free text. |
| `ContactName` | string | No | |
| `ContactInfo` | string | No | Callback phone in E.164. |
| `ExternalId` | string | No | The relay's submission id. |
| `ReferenceId` | string | No | The short code shown to the caller. |
| `Note` | string | No | The structured note block. |

Core's maximum lengths for the text columns were not checked. Keep `Name` under 100 characters and test the longest allowed `Nature`, `Address` and `Note` against a real instance.

### 4.2.1 Live SOS mapping (pilot)

For account-based one-tap SOS ([`docs/live-sos-plan.md`](docs/live-sos-plan.md) §3.2), the relay sets:

| Field | Value |
|---|---|
| `Name` | `[PUBLIC SOS] SOS` |
| `Nature` | Config `SOS_NATURE_TEXT` (default `SOS – caller recording to follow`) |
| `ContactName` | The signed-in user's full name |
| `ContactInfo` | The user's phone (E.164) |
| `Note` | Still labels an unverified member of the public; includes `Phone: … (unverified)` |

The app does not send name, phone or nature on `POST /v1/sos`. `Geolocation` and `Address` still come from
the SOS body when present.

### 4.3 Fields the relay must never send

Leave these **out of the JSON body entirely**. Do not send them as `null`, `""` or `[]`.

| Field | Why |
|---|---|
| `LinkedCallId` | Omitted: the department's linked-call requirement is skipped. Sent blank: it is enforced, and the call can be rejected. |
| `ProtocolIds` | Same rule as `LinkedCallId`, for the protocols requirement. |
| `IndoorMapZoneId` | Same rule, for the indoor-location requirement. |
| `DispatchList` | Would propose or trigger dispatch. `"0"` means "everyone". |
| `DispatchOn`, `DispatchOnUtc` | Scheduling. Ignored for pending calls anyway. |
| `DepartmentId` | Only for the system key. |
| `UdfValues`, `ContactId`, `AdditionalContactIds`, `SubjectIdentifiers`, `Part2ConsentOnFile`, `IncidentId`, `DestinationPoiId`, `IndoorMapFloorId`, `What3Words`, `CheckInTimersEnabled`, `CallFormData` | Not part of an SOS. Some trigger extra validation or links. |

Build the body from an allowlist of the twelve fields in §4.2, and add a unit test that fails if any other key appears.

### 4.4 Success

**HTTP 201 Created** (not 200):

```json
{ "Id": "48213", "Status": "created", "PageSize": 0, "RequestId": "…", "Timestamp": "…" }
```

- `Id` is the new call's id, as a **string**. Store it; it is the `callId` for `GetCall`.
- A `Location` header points at `GetCall` for the new call.

What Core does with a pending call:
- Saves it with `State = 8` (Pending).
- Notifies **nobody**. No push, SMS, email or call broadcast.
- Keeps it out of active call lists, maps and the field apps.
- Refreshes dispatcher screens, so it appears in Pending Calls.
- Sets the reporting user to the department's managing user.
- If `Geolocation` is missing or invalid and `Address` is present, geocodes the address.

### 4.5 Idempotency

Core honours an `Idempotency-Key` header on `SaveCall`. **Always send it**, with the relay's submission id as the value.

| Situation | Core's response |
|---|---|
| First request with this key | Creates the call, 201 |
| Same key again, first request finished | **201 with the same call `Id`.** No second call is created. |
| Same key again, first request still running | **409 Conflict**, empty body |
| Same key again, first request saved the call then failed part-way | Finishes the same call and returns 201 with its `Id` |
| Same key again, first request failed before saving | Processed as new |

Rules:
- The key is scoped to the department. Maximum useful length is about 120 characters; a ULID or UUID is fine.
- Core keeps keys for **7 days**. The relay stops retrying after 30 minutes, well inside that.
- A claim held by a crashed Core request is released after 5 minutes. Until then retries get 409.
- **Use one key per submission and reuse it on every retry of that submission.** Never generate a new key for a retry.
- Core does **not** compare the body on a repeat. A different body with the same key returns the original call unchanged.
- If Core's receipt store fails, Core processes the request without duplicate protection. A duplicate is then possible but rare. Keep `ExternalId` and `ReferenceId` on every call so a dispatcher can still spot one.

### 4.6 Errors

| HTTP | Meaning | Relay action |
|---|---|---|
| **201** | Created (or already created by an earlier attempt) | Store `Id`, mark `received` |
| **400**, body starts `Required call fields are missing: ` | The department's field policy requires a field the relay didn't send. The rest of the body is a comma-separated list of field keys (§7). | Do not retry. Mark failed, alert. This is a configuration problem. |
| **400**, other or empty body | Body failed validation (`Priority`, `Name` or `Nature` missing, or malformed JSON) | Do not retry. Mark failed, alert. This is a relay bug. |
| **401** | Key problem (§2.3), or the managing user is not allowed to create calls | Pause the department queue, critical alert, keep the submission queued |
| **403** | Key lacks `calls.create` | Same as 401 |
| **409** | Same `Idempotency-Key` is still being processed | Retry with the same key after the normal backoff |
| **415** | `Content-Type` was not `application/json` | Relay bug |
| **429** | Rate limited | Retry after the `Retry-After` header, or the normal backoff |
| **5xx**, timeout, connection error | Unknown whether the call was saved | Retry with the **same** `Idempotency-Key` |

A department with Advanced Data Protection turned on can return an additional error from its protected-write check. The relay has no special handling for it: treat any unlisted 4xx as "do not retry, alert", and any 5xx as retryable.

---

## 5. Read a call's state: `GET Calls/GetCall`

```http
GET /api/v4/Calls/GetCall?callId=48213
X-Resgrid-ApiKey: rgk_…
```

Do not send a `departmentId` query parameter.

### 5.1 Responses

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `Status: "success"`, `Data: { … }` | Call found |
| 200 | `Status: "not_found"`, no usable `Data` | No call with that id |
| 400 | empty | `callId` is not an integer |
| 401 | empty | Key problem, **or the call belongs to another department** |

Because 401 has two meanings here, don't pause the queue on a 401 from `GetCall` alone. Confirm with a call that takes no id, such as `GetNewCallFieldPolicy`.

### 5.2 The fields the relay reads

```json
{
  "Status": "success",
  "Data": {
    "CallId": "48213",
    "State": 8,
    "ExternalId": "sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD",
    "ReferenceId": "SOS-7KQ2",
    "LoggedOnUtc": "2026-11-16T14:03:22Z",
    "DispatchedOnUtc": null
  }
}
```

`Data` contains the full call (name, nature, notes count, address, contact details and more). **The relay reads `State` and nothing else, and returns none of it to the app.** In a department with Advanced Data Protection, some text fields come back redacted; `State` is not affected.

### 5.3 State mapping

| `State` | Core meaning | Relay status |
|---|---|---|
| 8 | Pending, waiting for a dispatcher | `received` |
| 0 | Active, dispatched | `dispatched` |
| 1 | Closed | `closed` |
| 2 | Cancelled | `closed` |
| 3 | Unfounded | `closed` (counts as a hoax signal) |
| 4 | Founded | `closed` |
| 5 | Minor | `closed` |
| 6 | Transferred | `closed` |
| 7 | False alarm | `closed` (counts as a hoax signal) |
| `Status: "not_found"` | Call removed | `closed` |
| any other number | Unknown | Keep the last known status, log a warning |

- A call can go from a closed state back to 0 if a dispatcher re-opens it. Keep polling for the 24-hour status window instead of stopping at the first closed state.
- What `GetCall` returns for a call a dispatcher deleted was not verified. It may be `not_found` or the last state. Test it during integration.

### 5.4 Polling cost and a cheaper alternative
- `GetCall` does a lot of work per request in Core. Keep the 15-second cache per call from the PRD and never poll Core faster than that.
- `GET Calls/GetPendingCalls` returns every pending call for the department in one request, ordered oldest first, in `Data` as an array of the same call objects. When there are no pending calls it returns `Status: "not_found"` with an empty array.
- With many open submissions in one department, poll `GetPendingCalls` once per interval: a submission whose `CallId` is in the list is still `received`; one that has dropped out needs a single `GetCall` to learn whether it was dispatched or closed.

### 5.5 Attach a call file: `POST CallFiles/SaveCallFile`

**Scope:** `calls.update`.

Attaches the caller's voice recording after the pending call exists. The relay sends:

```json
{
  "CallId": "<core call id>",
  "UserId": "<fixed placeholder>",
  "Type": 1,
  "Name": "SOS-7KQ2-1.m4a",
  "Data": "<base64 of raw .m4a bytes>"
}
```

- Core **requires** `UserId` but ignores the value; the relay sends a configured placeholder.
- **201** with `{ "Id" }` is success; store the file id. Active and pending calls only; closed calls are
  refused (the relay maps that to dropping the recording).
- **Timeouts and 5xx / 429:** retry with backoff like delivery, at most 5 attempts.

**Idempotency:** Core documents no `Idempotency-Key` on `SaveCallFile` (only `SaveCall` honours one; confirm
against a live Core before relying on this). A retry after a lost **201** can attach the same audio twice.
The relay accepts that risk—a duplicate audio file is harmless to a dispatcher—and keeps retry counts low.
`GetFilesForCall` is not available to the department key, so the relay cannot check before attach.

### 5.6 Unit statuses: `GET UnitStatus/GetAllUnitStatuses`

**Scope:** `units.read`.

Returns every unit's current status for the department. The relay calls this **once per interval** while any
SOS is being watched and at least one watched submission is `dispatched` (plan D13), then keeps only rows where
`DestinationType = 2` (call) and `DestinationId` equals the Core call id (plan D12). Those rows drive the
live snapshot `units` array in [`app-api-contract.md`](docs/app-api-contract.md).

Unit names and call signs are not sent to the app. Coordinates and status text come from Core's response
fields the relay maps in code (TBD in build: exact PascalCase field names in the live Core envelope).

---

## 6. Reference data (startup checks)

### 6.1 `GET CallTypes/GetAllCallTypes`
```json
{
  "Status": "success",
  "Data": [
    { "Id": "0",  "Name": "No Type",    "BaseType": 0 },
    { "Id": "12", "Name": "Public SOS", "BaseType": 0 }
  ]
}
```
- Check that the configured `callTypeName` equals a `Name` exactly (case-sensitive).
- `"No Type"` with id `"0"` is always present and is not a real type.
- A department with no call types returns `Status: "not_found"` with only the `"No Type"` entry.

### 6.2 `GET CallPriorities/GetAllCallPriorites`
```json
{
  "Status": "success",
  "Data": [
    { "Id": 3, "DepartmentId": 41, "Name": "High", "Color": "#ff0000", "Sort": 1,
      "IsDeleted": false, "IsDefault": false, "Tone": 0, "BaseType": 0 }
  ]
}
```
- `Id` is an **integer** here (it is a string for call types).
- Check that the configured `priorityId` matches an `Id` with `IsDeleted: false`.
- A department with no priorities returns `Status: "not_found"` and an empty array.

---

## 7. Required-field policy: `GET Calls/GetNewCallFieldPolicy`

A department can make built-in call fields mandatory. Core enforces this on `SaveCall`, so a policy the relay can't satisfy makes **every** SOS fail with 400.

```json
{
  "Status": "success",
  "Data": {
    "Rules": [
      { "Key": "address",    "Visible": true, "Required": true },
      { "Key": "incidentId", "Visible": false, "Required": false }
    ]
  }
}
```

An empty `Rules` array means nothing extra is required. Only `Required: true` matters to the relay.

| Policy key | Body field | Can the relay satisfy it? |
|---|---|---|
| `note` | `Note` | Always |
| `externalId` | `ExternalId` | Always |
| `referenceId` | `ReferenceId` | Always |
| `contactInfo` | `ContactInfo` | Always (phone is required by the relay) |
| `geolocation` | `Geolocation` | **Only when the caller shared a location.** Must be a real point; `","` or `"0,0"` does not count. |
| `address` | `Address` | **Only when the caller typed one** |
| `contactName` | `ContactName` | **Only when the caller gave a name** |
| `what3words` | `What3Words` | No |
| `incidentId` | `IncidentId` | No |
| `destinationPoi` | `DestinationPoiId` | No |
| `dispatchOn` | – | Not enforced for pending calls |
| `dispatchList` | – | Not enforced for pending calls |
| `protocols` | `ProtocolIds` | Not enforced while the field is omitted (§4.3) |
| `linkedCall` | `LinkedCallId` | Not enforced while the field is omitted (§4.3) |
| `indoorLocation` | `IndoorMapZoneId` | Not enforced while the field is omitted (§4.3) |
| `pluscode` | – | Can never be required |

Startup and hourly check:
- **Unhealthy** (alert, every SOS will fail): `what3words`, `incidentId` or `destinationPoi` is required.
- **Conditional** (the relay must adapt): `geolocation`, `address` or `contactName` is required. Either the intake config makes the matching input mandatory for the app, or the relay fills a placeholder. For example, when `address` is required and the caller only sent GPS, send `Address: "See map location"`; when `contactName` is required and none was given, send `ContactName: "Unknown caller"`. A required `geolocation` with no location has no honest placeholder: the intake must require location.
- Report the conditional requirements to the app through the intake config so the form asks for them up front.

---

## 8. Rate limits and timeouts

- Core has IP-based rate limiting, but no rule in its default configuration targets the endpoints in this document. A deployment can add rules, so handle 429 anyway and honour `Retry-After`.
- Keep outbound traffic modest: one delivery worker per department, and status polling capped by the 15-second cache.
- `SaveCall` does several database reads and may geocode an address. Use a 6-second timeout. A timeout does not mean the call was not saved, which is why the retry reuses the `Idempotency-Key`.
- Use a 5-second timeout for the read endpoints.

---

## 9. Reference client (TypeScript)

A minimal shape for the Core client. It shows the points that are easy to get wrong.

```ts
import { request } from 'undici';

export type CoreResult<T> =
  | { kind: 'ok'; status: string; data: T; requestId?: string }
  | { kind: 'auth' }                       // 401 / 403: pause the queue
  | { kind: 'conflict' }                   // 409: same key still in progress
  | { kind: 'rejected'; httpStatus: number; message: string } // other 4xx: do not retry
  | { kind: 'retryable'; reason: string }; // 429, 5xx, timeout, network

const ALLOWED_FIELDS = [
  'IsPending', 'Priority', 'Type', 'Name', 'Nature', 'Geolocation', 'Address',
  'ContactName', 'ContactInfo', 'ExternalId', 'ReferenceId', 'Note',
] as const;

export async function saveCall(
  cfg: { baseUrl: string; apiKey: string },
  call: Record<(typeof ALLOWED_FIELDS)[number], unknown>,
  submissionId: string,
): Promise<CoreResult<{ callId: string }>> {
  // Allowlist + drop undefined, so forbidden or empty fields can never reach Core.
  const body: Record<string, unknown> = {};
  for (const k of ALLOWED_FIELDS) if (call[k] !== undefined && call[k] !== null && call[k] !== '') body[k] = call[k];
  body.IsPending = true;

  let res;
  try {
    res = await request(`${cfg.baseUrl}/api/v4/Calls/SaveCall`, {
      method: 'POST',
      headers: {
        'X-Resgrid-ApiKey': cfg.apiKey,      // and NO Authorization header
        'Content-Type': 'application/json',
        'Idempotency-Key': submissionId,     // same value on every retry
      },
      body: JSON.stringify(body),
      headersTimeout: 6000,
      bodyTimeout: 6000,
    });
  } catch (err) {
    return { kind: 'retryable', reason: String(err) };
  }

  const text = await res.body.text();
  if (res.statusCode === 200 || res.statusCode === 201) {
    const json = JSON.parse(text);
    if (!json.Id) return { kind: 'retryable', reason: 'success without Id' };
    return { kind: 'ok', status: json.Status, data: { callId: String(json.Id) }, requestId: json.RequestId };
  }
  if (res.statusCode === 401 || res.statusCode === 403) return { kind: 'auth' };
  if (res.statusCode === 409) return { kind: 'conflict' };
  if (res.statusCode === 429 || res.statusCode >= 500) return { kind: 'retryable', reason: `HTTP ${res.statusCode}` };
  return { kind: 'rejected', httpStatus: res.statusCode, message: text.slice(0, 500) };
}

const STATE_TO_STATUS: Record<number, 'received' | 'dispatched' | 'closed'> = {
  8: 'received', 0: 'dispatched',
  1: 'closed', 2: 'closed', 3: 'closed', 4: 'closed', 5: 'closed', 6: 'closed', 7: 'closed',
};

export function mapCallState(envelope: { Status: string; Data?: { State?: number } }) {
  if (envelope.Status === 'not_found') return 'closed';
  const state = envelope.Data?.State;
  return state === undefined ? undefined : STATE_TO_STATUS[state]; // undefined = keep last known
}
```

Never log the `X-Resgrid-ApiKey` value. Add it to `pino`'s redaction paths.

---

## 10. Core-side setup (configuration only)

Done once per department by a department admin in the Resgrid web UI:

1. Create a call type named exactly as the relay's `callTypeName` (e.g. `Public SOS`).
2. Pick the call priority for SOS calls and note its numeric id (also visible through `GetAllCallPriorites`).
3. Under Security → API Keys, create a key with scopes **`calls.create`, `calls.read`, `calls.update`, `units.read`, `reference.read`** only. Set the IP allowlist to the relay's egress IP. Set an expiry of 730 days or less and record the date in relay config.
4. Review the new-call field policy against §7.
5. Confirm the department's managing user is allowed to create calls (true by default for a department admin).

---

## 11. Integration test checklist

Run against a real Sentinel dev instance with a test department:

- [ ] `SaveCall` returns **201** with a string `Id`, and the call shows in Pending Calls with `State = 8`.
- [ ] No notification of any kind is sent for the pending call.
- [ ] Repeating the same request with the same `Idempotency-Key` returns the **same** `Id`, and only one call exists.
- [ ] Two simultaneous requests with the same key produce one call (one of them may get 409).
- [ ] A wrong call type name creates a call with no type (proves the startup check is needed).
- [ ] With `address` set as required in the field policy and no `Address` sent, `SaveCall` returns 400 with `Required call fields are missing: address`.
- [ ] Sending `"LinkedCallId": ""` with the linked-call requirement on returns 400; omitting the field succeeds.
- [ ] `GetCall` returns `State` 8, then 0 after a dispatcher dispatches the call, then a closed state after it is closed.
- [ ] `GetCall` with an unknown id returns HTTP 200 and `Status: "not_found"`.
- [ ] A request that carries both `X-Resgrid-ApiKey` and `Authorization` returns 401.
- [ ] A key without `calls.create` returns 403 on `SaveCall`.
- [ ] A request from an address outside the allowlist returns 401.
- [ ] A revoked key returns 401 within about 60 seconds of revocation.
- [ ] Record what `GetCall` returns for a deleted call, and the longest `Name`, `Nature`, `Address` and `Note` Core accepts.
- [ ] `SaveCallFile` on an active pending call returns **201** with a file `Id`; the file is visible to dispatch on that call.
- [ ] `SaveCallFile` on a closed call is refused with the same behaviour the relay expects for "call not active/pending".
- [ ] `GetAllUnitStatuses` returns at least one unit; moving a unit's destination to the test call id shows it in the relay's filtered list.

---

## 12. Corrections to `sos-relay-PRD.md`

| PRD section | PRD says | Correct |
|---|---|---|
| §5.2, §8.3 | `SaveCall` has no idempotency key; duplicates are accepted | `SaveCall` honours an `Idempotency-Key` header (§4.5). Send the submission id. Duplicates are prevented in normal operation, and retries can start sooner than the PRD's cautious first retry. |
| §5.2, §7.5 | `GetCall` not-found has `Status` `"notfound"` | The value is `"not_found"`. |
| §8.1 step 11 | Implies success is a 200 | Success is **201** with `Status: "created"`. Accept 200 and 201. |
| §5.2 | Any invalid key counts toward the lockout | Only unrecognised keys count. Revoked, expired and wrong-address keys don't. The "pause on 401" rule stays. |
| §13.2 step 4 | The relay always fills `Geolocation`, `Address`, `ContactName` | Those three depend on what the caller provided (§7). |
| §5.1 | Five endpoints | `GetPendingCalls` is a sixth, optional one that makes status polling cheaper (§5.4). |
| §5.3 | Never-set list | Add `IndoorMapZoneId`, `What3Words`, `AdditionalContactIds`, `Part2ConsentOnFile`, `CallFormData`, `DestinationPoiId` (§4.3). |
