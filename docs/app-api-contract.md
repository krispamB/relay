# SOS Relay: API contract for the mobile app

This is the one document the app team needs to talk to the SOS Relay. It covers every endpoint the
app calls, what to send, every answer the relay can give, and what the app should do with each one.

It describes the relay as built for the **live SOS pilot**: signed-in users, one-tap SOS, an optional
voice recording, and live call and unit status over a WebSocket. Values that are random (ids, tokens)
will differ in your runs. If this document and the relay disagree, the relay is right and this
document has a bug: tell the relay team.

Full design context: [`docs/live-sos-plan.md`](live-sos-plan.md).

## Happy path (in order)

1. **Sign up or sign in** (`POST /v1/auth/signup` or `POST /v1/auth/signin`) — store the session;
   use the **access token** on every SOS and live call. Details: [`docs/auth-contract.md`](auth-contract.md).
2. **`GET /v1/intake/:intakeCode`** — cache department config and `emergencyPhone`.
3. **One tap:** **`POST /v1/sos`** with `Authorization: Bearer <accessToken>`, body
   `{ "intakeCode", "location?" | "address?" }`. Start recording at the same moment.
4. **Keep the receipt** (`receiptId`, `reference`, `status`) — there is **no** `statusToken`.
5. **Open `GET /v1/live`** (WebSocket): authenticate, **`subscribe`** with `receiptId`, send
   **`location`** and **`ping`** every 25 s; apply each `{type:"state"}` snapshot (§6.3).
6. When recording stops (or hits the cap), **`POST /v1/sos/{receiptId}/recording`** with the
   `.m4a` bytes.
7. If the socket is down briefly, **`GET /v1/sos/{receiptId}/status`** returns the same snapshot shape
   as the socket. Prefer the socket while the app is watching.

Three companion files:

- [`docs/auth-contract.md`](auth-contract.md): sign-up, sign-in, refresh, sign-out, `GET /v1/me`.
- [`docs/openapi.json`](openapi.json): machine-readable schema (see [OpenAPI document](#7-openapi-document)).
- [`docs/attestation-contract.md`](attestation-contract.md): **retired** for the pilot; kept as history only.

## Contents

1. [The rules that matter most](#1-the-rules-that-matter-most)
2. [Basics](#2-basics)
3. [The error body](#3-the-error-body)
4. [Endpoints](#4-endpoints)
   - [`GET /v1/intake/:intakeCode`](#41-get-v1intakeintakecode)
   - [`POST /v1/sos`](#42-post-v1sos)
   - [`GET /v1/sos/:receiptId/status`](#43-get-v1sosreceiptidstatus)
   - [`POST /v1/sos/:receiptId/recording`](#44-post-v1sosreceiptidrecording)
5. [Live status: `GET /v1/live` (WebSocket)](#5-live-status-get-v1live-websocket)
6. [The idempotency key, retries and the outbox](#6-the-idempotency-key-retries-and-the-outbox)
7. [OpenAPI document](#7-openapi-document)
8. [What each SOS status means](#8-what-each-sos-status-means)
9. [Rate limits](#9-rate-limits)
10. [The demo intake](#10-the-demo-intake)
11. [What is deliberately not available](#11-what-is-deliberately-not-available)

---

## 1. The rules that matter most

- **A 503 from `POST /v1/sos` means "not sent, and never will be".** Show "Call {emergencyPhone}"
  at once and do not retry by yourself. The relay never delivers that SOS later.
- **A 202 means "saved, the relay is still delivering it".** The SOS is not at dispatch yet. Watch
  it on the live socket (or poll status).
- **One `Idempotency-Key` per SOS**, reused on every retry of that SOS. That stops a retry from
  creating a second emergency call.
- **Name and callback number come from the account**, not from the SOS body. The recording carries
  what happened.
- **A location older than 10 minutes is refused.** Retries from the outbox must refresh it
  ([§6.3](#63-location-on-retry)).
- **Every error state shows the emergency phone number** from the intake.
- **On the live socket, ignore snapshots with an older `version`.** Replace local state with each
  newer snapshot.

---

## 2. Basics

| Topic | Rule |
|---|---|
| Base URL | Per build variant (`EXPO_PUBLIC_RELAY_BASE_URL`). Auth uses the same base URL ([`auth-contract.md`](auth-contract.md)). |
| TLS | HTTPS only. No cleartext traffic. |
| Pinning | Pin the public keys (SPKI SHA-256) of the **Let's Encrypt roots ISRG Root X1 and ISRG Root X2**, one as primary and one as backup. Do **not** pin the relay's own certificate. |
| Format | JSON for HTTP bodies unless noted. Send `Content-Type: application/json` with JSON requests. Responses are `application/json; charset=utf-8` unless noted. |
| Credentials | The user's **access token** (`Authorization: Bearer`) on `POST /v1/sos`, status, recording, and on the live WebSocket (upgrade header or in-band `auth`). |
| Unknown fields | A request body with a field the relay does not know is refused with 400. Send only the fields listed here. |
| Body size | At most 16 384 bytes for JSON request bodies. Recording upload: at most 400 000 bytes (400 KB) raw audio. Larger bodies get 413. |
| Times | RFC 3339 / ISO 8601 in UTC. |
| Answer time | `POST /v1/sos` answers within 8 seconds. Use a 10-second client timeout. |

---

## 3. The error body

Every HTTP response that is not 2xx has this shape:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 3600 } }
```

| Field | Meaning |
|---|---|
| `error.code` | Stable machine code. Branch on this and on the HTTP status, never on `message`. |
| `error.message` | Short English text for logs. Not meant for the caller's screen. |
| `error.retryAfterSeconds` | Present on every 429 and 503. An integer of at least 1. The same value is in the `Retry-After` header. |

The 409 from `POST /v1/sos` adds the open SOS's receipt fields next to `error` (see [409](#409-an-sos-from-this-user-is-already-open)).

A 403 never says why, by design. Error bodies never contain personal data.

Auth endpoints (`/v1/auth/*`, `/v1/me`) use their own codes in [`auth-contract.md`](auth-contract.md).

Error codes on the SOS HTTP routes:

| HTTP | `code` | Where |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON, unknown field, wrong `Content-Type` (unsupported type → **415** with the same code). |
| 400 | `address_too_long`, `address_required`, `location_invalid`, `location_required` | SOS body checks ([§4.2](#42-post-v1sos)). |
| 401 | `unauthorized` | SOS, status, recording: access token missing, unknown or expired ([`auth-contract.md`](auth-contract.md) for `token_expired` on `/v1/me`). |
| 403 | `forbidden` | SOS: the user or phone number is blocked. No reason given. |
| 404 | `not_found` | Unknown intake; unknown route; status or recording for another user's receipt (same as unknown). |
| 409 | `sos_already_open` | SOS: this user already has an open SOS. |
| 409 | `recording_limit` | Recording: cap reached (`RECORDINGS_PER_SOS`, default 1). |
| 409 | `sos_closed` | Recording: SOS is `closed` or `failed`. |
| 410 | `intake_disabled` | The intake exists but is switched off. |
| 413 | `payload_too_large` | Body or recording too large. |
| 415 | `invalid_request` | Unsupported `Content-Type` on JSON routes. |
| 422 | `idempotency_key_reused` | Recording: same `Idempotency-Key`, different bytes. |
| 429 | `rate_limited` | A rate limit ([§9](#9-rate-limits)). |
| 500 | `internal_error` | A relay bug. Treat like a network failure where retry is allowed. |
| 503 | `unavailable` | SOS: the relay cannot deliver to dispatch right now. |
| 503 | `intake_busy` | SOS: the whole intake is receiving too many SOS at once. |

---

## 4. Endpoints

### 4.1 `GET /v1/intake/:intakeCode`

The department's public configuration: its name, its emergency number, the list of emergency types
("natures") for display only, and whether it can take an SOS right now. No authentication. The app
does **not** send `nature` on `POST /v1/sos`; the relay sets a fixed nature text in Core.

**When:** when the app comes to the foreground (at most once per 5 minutes), and after switching
department. Cache the last good answer; ship a bundled copy for first launch.

**Path parameter:** `intakeCode`, the department's code, exactly as configured (case-sensitive).
Intake codes are 6 to 32 characters of `A-Z a-z 0-9 -`.

**Headers:** none required.

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 200 | The intake (below) | Use it: show `emergencyPhone`. If `available` is `false`, the SOS button should still be shown, but a send will get 503; show the call button prominently. |
| 404 | Error, `not_found` | Unknown code. Replace the SOS with "This service is not available. Call {emergencyPhone}". |
| 410 | Error, `intake_disabled` | Intake switched off. Same as 404. |
| 429 | Error, `rate_limited` | Keep the cached config; try again later. |

**200 body** (unchanged shape; `natures` are labels for the UI only)

| Field | Type | Meaning |
|---|---|---|
| `intakeCode` | string | The code. |
| `displayName` | string | Department name to show. |
| `emergencyPhone` | string | The number for the "Call" button. Show it on every screen. |
| `natures` | array of `{ id: string, label: string }` | Display list. Not sent on SOS in the live flow. |
| `requireVerifiedPhone` | boolean | Always `false` in the pilot ([§11](#11-what-is-deliberately-not-available)). |
| `available` | boolean | `false` while the relay cannot deliver an SOS for this intake. |
| `demo` | boolean | `true` for the demo intake ([§10](#10-the-demo-intake)). |
| `required.location` | boolean | `true` when every SOS must carry a usable location. |
| `required.address` | boolean | Always `false`: the relay fills in a placeholder when needed. |
| `required.name` | boolean | Always `false`: name comes from the account. |

---

### 4.2 `POST /v1/sos`

Sends an SOS in **one tap**. The relay saves it and tries to create a pending call for the department's
dispatchers before answering. Callback name and phone are taken from the signed-in user's account.

**When:** when the caller presses Send (and starts recording at the same time), and for each retry
from the outbox ([§6](#6-the-idempotency-key-retries-and-the-outbox)).

**Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `Authorization` | yes | `Bearer <accessToken>` |
| `Idempotency-Key` | yes | A UUID. **One per SOS, the same string on every retry of it.** |

**Body**

| Field | Type | Rules |
|---|---|---|
| `intakeCode` | string, 1 to 64 characters | Required. The department's code. |
| `location` | object | Optional. See below. |
| `location.lat` | number | Required in `location`. Degrees, -90 to 90. |
| `location.lon` | number | Required in `location`. Degrees, -180 to 180. |
| `location.accuracyM` | number | Optional. Horizontal accuracy in metres. A negative value is ignored. |
| `location.capturedAt` | date-time string | Required in `location`. **The fix's own timestamp**, not the time of sending. At most 10 minutes old when it reaches the relay, and not more than 30 seconds in the future. |
| `location.source` | `"gps"`, `"network"` or `"last_known"` | Required in `location`. |
| `address` | string | Optional. Address or landmark, up to 500 characters. Required when there is no usable location. |

There is no `nature`, `phone`, `name` or `details` field. Any of them is an unknown field → 400.

**Location and address**

- **Text** (`address`) is cleaned: control characters removed, whitespace collapsed, trimmed. Over
  500 characters → 400 `address_too_long`.
- **Location** is unusable when `lat`/`lon` are out of range, exactly `0,0`, `capturedAt` cannot be
  parsed, it is more than 10 minutes old, or more than 30 seconds in the future. An unusable location
  is **silently dropped when an `address` is present**, and is a **400 when there is no address**
  (`location_invalid`).
- No location and no address: 400 `address_required`.
- If the intake says `required.location: true`, an SOS without a usable location is 400
  `location_required`, even with an address.

**Order of checks** (first failure wins)

1. Access token valid → else **401**.
2. User not blocked → else **403**.
3. Headers and body valid → else **400**.
4. Intake known → else **404**; enabled → else **410**.
5. Same user and same `Idempotency-Key` seen before: **replay** (current state; body not compared).
6. This user already has an open SOS → **409**.
7. Phone number (from account) not blocked → else **403**.
8. Rate limits → **429** or **503** `intake_busy`.
9. Relay able to deliver → else **503** `unavailable`.
10. Saved, then one delivery attempt → **201**, **202** or **503**.

**Responses**

| HTTP | Body `status` | Meaning | What the app does |
|---|---|---|---|
| **201** | `received` | Dispatch has the SOS as a pending call. | Store receipt. Open live socket. |
| **201** | `failed` | Not delivered, and will not be. | Store receipt. Show "NOT DELIVERED", call button primary. Do not retry. |
| **201** | `dispatched` or `closed` | Replay: the SOS has moved on. | Store receipt and show that status. |
| **202** | `queued` | Saved; the relay keeps trying for up to 30 minutes. | Store receipt. Watch on socket. |
| **400**–**410**, **413**, **429**, **503** | error | See tables above. | As documented. |
| **401** | `unauthorized` | Token bad or expired. | Refresh session once ([`auth-contract.md`](auth-contract.md)), retry with same `Idempotency-Key`. |
| **409** | `sos_already_open` + receipt | Another open SOS for this user. | Show the returned receipt's status. |
| **500**, timeout, no network | – | Outcome unknown. | Outbox with same key ([§6](#6-the-idempotency-key-retries-and-the-outbox)). |

**Success, replay and 409 body (the receipt)**

| Field | Type | Meaning |
|---|---|---|
| `receiptId` | string, `sos_` + ULID | The SOS id. Used in status, recording and `subscribe`. |
| `reference` | string, `SOS-` + 4 Crockford base32 chars | Code the caller quotes on the phone. Show it large. |
| `status` | `queued`, `received`, `dispatched`, `closed` or `failed` | Current status ([§8](#8-what-each-sos-status-means)). |
| `submittedAt` | date-time | When the relay accepted it. |

There is **no** `statusToken`. Status and live updates use the access token only.

##### 409: an SOS from this user is already open

A user may have one open SOS at a time (`queued`, `received` or `dispatched`), counted separately
for real and demo intakes. The 409 carries that receipt next to the error.

**Example: one tap**

```http
POST /v1/sos
Content-Type: application/json
Authorization: Bearer <accessToken>
Idempotency-Key: 90c85a55-64d7-4d66-818c-da8939ab253b

{"intakeCode":"LAGOS-FIRE","location":{"lat":6.524417,"lon":3.379206,"accuracyM":12,"capturedAt":"2026-11-17T11:59:52.000Z","source":"gps"}}
```

```http
HTTP/1.1 201 Created

{
  "receiptId": "sos_01M7MP1NG0T7GGZBMN90N7V7EF",
  "reference": "SOS-A9TD",
  "status": "received",
  "submittedAt": "2026-11-17T12:00:00Z"
}
```

---

### 4.3 `GET /v1/sos/:receiptId/status`

Returns the **live snapshot** for one SOS ([§5.3](#53-snapshot-state-message)): exactly the
`{type:"state"}` message the WebSocket sends, `type` included, so the app can feed both into the same
code. Compare `version` the same way.

**When:** fallback when the socket is unavailable; not faster than once per 5 seconds per receipt.

**Headers:** `Authorization: Bearer <accessToken>`

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 200 | Snapshot ([§5.3](#53-snapshot-state-message)) | Update UI. |
| 401 | `unauthorized` | Refresh and retry once. |
| 404 | `not_found` | Wrong user, unknown id, or purged (30 days). Stop watching. |
| 429 | `rate_limited` | Wait `retryAfterSeconds`. |

---

### 4.4 `POST /v1/sos/:receiptId/recording`

Uploads the voice recording for an SOS the user owns. The relay stores it and attaches it to the Core
call with `SaveCallFile` when the call exists (see [`integration.md`](../integration.md)).

**When:** when the user stops recording or the app hits the duration cap (at most 60 s).

**Headers**

| Header | Required | Value |
|---|---|---|
| `Authorization` | yes | `Bearer <accessToken>` |
| `Idempotency-Key` | yes | UUID, **one per recording attempt**, reused on every upload retry of that bytes |
| `Content-Type` | yes | `audio/mp4` |
| `X-Recording-Duration-Ms` | yes | Integer milliseconds, 1–60000 |

**Body:** raw `.m4a` bytes (AAC in MP4 container), not JSON. At most **400 KB**. The relay checks size,
the MP4 `ftyp` box, and the declared duration; it does not decode or transcode audio.

**Responses**

| HTTP | Body | Meaning | App does |
|---|---|---|---|
| **202** | `{ "recordingId", "seq", "status": "pending" }` | Accepted for attach | Show upload pending in live state (`recording.status`). |
| **200** | Same as 202, but `status` is the recording's current status | Replay: same key and same bytes | Treat as success. |
| **400** | `invalid_request` | Empty body, a body that is not an MP4 container, or a missing or bad `Idempotency-Key` / `X-Recording-Duration-Ms` | Fix client. |
| **401** | `unauthorized` | | Refresh, retry once with same key and bytes. |
| **404** | `not_found` | Not owner or unknown receipt | Stop. |
| **409** | `recording_limit` | Already has max recordings (default 1) | Do not send another. |
| **409** | `sos_closed` | SOS `closed` or `failed` | Discard local audio; cannot attach. |
| **413** | `payload_too_large` | Over 400 000 bytes | Re-encode or shorten before retry (new key if bytes change). |
| **415** | `invalid_request` | `Content-Type` is not `audio/mp4` | Fix client. |
| **422** | `idempotency_key_reused` | Same key, different bytes | Client bug: new key for new bytes. |

| Field | Meaning |
|---|---|
| `recordingId` | `rec_` + ULID |
| `seq` | 1-based sequence (pilot ships with max 1) |
| `status` | `pending` until attached or dropped (visible on live snapshot as `recording.status`) |

**What the relay does with it.** The `recordings` job attaches the audio to the Core call with
`SaveCallFile` as `{reference}-{seq}.m4a` once the call exists (a recording uploaded while the SOS is still
`queued` waits, and is checked again every 5 s). It retries 5xx, 429 and timeouts with the delivery backoff,
at most 5 attempts. `recording.status` becomes `attached` when Core has the file, or `dropped` (audio
discarded) when the call is closed first, the SOS ends `closed` or `failed`, Core refuses the file, the
attempts run out, or the SOS leaves the 24 h window with the recording still pending. A drop is final: a
dropped recording still counts toward `RECORDINGS_PER_SOS`.

**Format (app production target):** AAC in `.m4a`, mono, 16 kHz, 32 kbps, max 60 s (~240 KB/min).

---

## 5. Live status: `GET /v1/live` (WebSocket)

Upgraded WebSocket on the same host as the REST API (`GET /v1/live`). Delivers versioned snapshots
while the caller watches their SOS. Caller movement is sent on the socket and **stays on the relay**
(for distance only); it is never written to Core.

### 5.1 Connection and auth

- Prefer **`Authorization: Bearer <accessToken>` on the HTTP upgrade**.
- If the upgrade had no token, the **first message within 5 seconds** must be
  `{ "type": "auth", "token": "<accessToken>" }`.
- **Re-authenticate in-band** with `{type:"auth"}` before the access token expires (15 minutes).
  Otherwise the relay closes with **4001**.
- Revoking the session closes open sockets with **4003**.

### 5.2 App → relay messages

| Message | Effect |
|---|---|
| `{ "type": "auth", "token" }` | As above. Must be the same user on reconnect. |
| `{ "type": "subscribe", "receiptId" }` | Watch one SOS. Relay answers with a snapshot. **One SOS per socket**; a second subscribe replaces the first. Not owner → close **4004**. |
| `{ "type": "location", "lat", "lon", "accuracyM?", "capturedAt" }` | Caller position. Same validation as SOS `location`. Stored on the submission; at most one stored every 5 s; extras ignored. |
| `{ "type": "ping" }` | Every **25 s**. Refreshes `live_watch_until`. Answered with `{ "type": "pong" }`. |

### 5.3 Snapshot (`state` message)

Relay → app: `{ "type": "state", … }` with:

```json
{
  "type": "state",
  "version": 17,
  "receiptId": "sos_01J…",
  "reference": "SOS-7KQ2",
  "status": "dispatched",
  "updatedAt": "2026-11-22T09:14:05Z",
  "recording": { "status": "attached" },
  "units": [
    {
      "key": "u_3f9a…",
      "type": "Ambulance",
      "status": "En Route",
      "lat": 4.9247,
      "lon": 6.2676,
      "distanceM": 3200,
      "updatedAt": "2026-11-22T09:13:58Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Monotonic; from `submissions.live_version`. **Replace state when `version` increases; ignore older.** |
| `status` | Same enum as the receipt ([§8](#8-what-each-sos-status-means)). |
| `recording.status` | `none`, `pending`, `attached`, or `dropped` (last recording). |
| `units` | Only when `status` is `dispatched`. Unit **type**, status text, coordinates, straight-line `distanceM` (no names or call signs). Empty until a unit's Core destination is this call; until then the UI shows waiting copy (see plan D12). |
| `distanceM` | Haversine from caller's live location if under 2 minutes old, else incident location, else omitted. |
| `units[].key` | A stable opaque id for one unit (`u_` + 32 hex), the same on every snapshot, so the map can move one marker. It is not Core's unit id. |

**Freshness.** While the app is subscribed (subscribe, then a ping every 25 s), the relay reads the
call every 15 s and the units every `UNIT_POLL_INTERVAL_S` (default 10 s). When nobody has watched
for 60 s it falls back to the slow schedule (15 s received, 60 s dispatched, 5 min closed) and stops
reading units: the last units seen stay in the snapshot, each with its own `updatedAt`, until the SOS
leaves `dispatched`. The HTTP status route reads the database only and does not count as watching.

HTTP `GET /v1/sos/:receiptId/status` returns this same object, `"type": "state"` included.

`updatedAt` is the time of the last **status** change (not of a unit or recording change; those
show in `version`).

Relay may also send `{ "type": "pong" }` and `{ "type": "error", "code" }` (shape TBD in build for
non-fatal protocol errors).

### 5.4 Close codes

| Code | Meaning | App does |
|---|---|---|
| **1000** | SOS final (`closed` or `failed`). | Stop. Show final state. |
| **4001** | No valid token in time, or token expired. | Refresh session, reconnect. |
| **4003** | Session revoked. | Sign out. |
| **4004** | No such SOS for this user, or purged. | Stop. |
| **4008** | No ping for 60 s. | Reconnect. |
| **1012** | Relay restarting (deploy). | Reconnect with backoff. |

After the **24 h** tracking window the SOS becomes `closed`; subscribe delivers the final snapshot
then **1000**. After the **30-day** purge, subscribe yields **4004**.

### 5.5 End of stream

When `status` becomes `closed` or `failed`, the relay sends a **final snapshot** then closes with
**1000**. The app should not expect further updates for that receipt.

---

## 6. The idempotency key, retries and the outbox

### 6.1 One key per SOS

Generate one UUID when the caller presses Send, and use that exact string for every attempt of that
SOS. The relay matches **user + key** for replays and never compares bodies.

### 6.2 When to retry

| Outcome | Retry? |
|---|---|
| Timeout, no network, pin failure, 500 | Yes: outbox, same key. |
| 401 | Once, after refreshing the session, same key. |
| 400, 403, 404, 409, 410, 413, 429, 503 | No. |
| 201, 202 | No. Watch live status. |

Outbox: same schedule as before (5 s, 15 s, 30 s, then every 30 s, up to **30 minutes** in the
foreground).

### 6.3 Location on retry

Rebuild `location` or omit it (with `address`) before each attempt so the fix is not older than
10 minutes. No attestation on retries.

---

## 7. OpenAPI document

`GET /v1/openapi.json` returns OpenAPI 3.0 for the public API. Committed copy:
[`docs/openapi.json`](openapi.json).

---

## 8. What each SOS status means

| Status | Meaning | Final? |
|---|---|---|
| `queued` | Saved; not yet at dispatch. Up to 30 minutes, then `failed`. | No |
| `received` | Dispatch has a pending call. Do not say "help is coming" yet. | No |
| `dispatched` | A dispatcher has acted. Live `units` may appear. | No |
| `closed` | Call closed, or 24 h tracking window ended. | Yes for the app |
| `failed` | Never delivered. | Yes |

Only `queued`, `received` and `dispatched` count as "open" for the one-open-SOS rule.

---

## 9. Rate limits

Defaults (deployment may change). `retryAfterSeconds` says how long to wait.

| Limit | Default | Answer |
|---|---|---|
| SOS per user | 3 per 24 h | 429 |
| SOS per phone (account) | 3 per 24 h | 429 |
| SOS per network address | 10 per hour | 429 |
| Whole intake | 30 SOS per 10 min | 503 `intake_busy` |
| Status polls per receipt | 1 per 5 s | 429 |
| Any request per network address | 120 per minute | 429 |

Auth limits are in [`auth-contract.md`](auth-contract.md). Accepted SOS count toward limits;
refusals and replays do not. Demo counters are separate.

---

## 10. The demo intake

Same as production except the SOS **never reaches real dispatchers**: `201 received`, then
`dispatched` after 30 s and `closed` after 90 s (defaults). Demo and real open-SOS rules and limits
are separate.

---

## 11. What is deliberately not available

| Not available | Instead |
|---|---|
| Device registration (`/v1/devices/*`) | Removed in the pilot. Sign in only. |
| Attestation (`X-Attestation`) | Removed in the pilot. See plan §9 before public release. |
| `X-Status-Token` | Removed. Use the access token. |
| SMS phone verification | Not built. Numbers are unverified in Core notes. |
| Cancelling or editing an SOS | Phone the emergency number. |
| Push notifications | Live socket while watching; reconnect as needed. |
| Caller location to Core | Socket `location` only, for distance. |
| Reading Core dispatch lists | Units inferred from `GetAllUnitStatuses` only. |