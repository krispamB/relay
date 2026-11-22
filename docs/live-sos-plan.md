# Live SOS plan: account-based one-tap SOS, voice recording, live call and unit status

| | |
|---|---|
| **Status** | Agreed in a design review on 2026-11-22. Not built. |
| **Replaces** | The device-token and attestation model of `app-api-contract.md` and `attestation-contract.md`, and email sign-in in `auth-contract.md`. |
| **Core facts** | `sos-app-PRD.md` §15 (Core as of 2026-11-19) and the v4 OpenAPI document at `{RESGRID_API_BASE}/swagger/v4/swagger.json`. Where this plan and Core disagree, Core wins and this plan is fixed. |

The relay keeps doing what it does today (authenticate the caller, create a pending call in Core,
track it), with four changes:

1. **The caller is the signed-in user.** No device token, no attestation, no form. Sign-in is by phone.
2. **One tap sends the SOS.** Name and callback number come from the account.
3. **A voice recording follows the SOS** and is attached to the Core call as a call file.
4. **A WebSocket streams the call's status and the units heading to it**, fed by polling Core.

This is a **pilot**: known testers, sideloaded or TestFlight builds, one department. Section 9 lists
what must change before a public release.

---

## 1. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Client | One client: the SOS app. The signed-in user who creates an SOS is the only one who can upload its recording or watch it. | No second audience to authorise. |
| D2 | SOS auth | `POST /v1/sos` takes the user's access token only. Device tokens, `/v1/devices/*` and attestation are removed. | Attestation (App Attest, Play Integrity) needs store-distributed builds, which the pilot will not use. |
| D3 | Abuse controls | Per-user SOS limit; hoax strikes and blocks keyed by **user id and phone hash** (was device and phone). The pending-call flow (a dispatcher confirms every call) stays the human check. | A new account with the same phone keeps its strikes. |
| D4 | Sign-in | Phone + password, replacing email + password. Phone is already unique. SMS verification comes later. | |
| D5 | Email | Removed from sign-up, from the `users` table and from sign-in. | No use for it without verification; data held for nothing. |
| D6 | SOS body | **One tap.** `intakeCode` plus `location`, or `address` when there is no usable fix. No `nature`, `name`, `phone` or `details`. Nature is fixed by the relay. Name is `users.full_name`; callback number is `users.phone`. No overrides. | The recording carries what happened. The callback number is always the one the future SMS check will vouch for. |
| D7 | Recording flow | The SOS goes out on the tap and recording starts at the same moment. The app uploads to `POST /v1/sos/{receiptId}/recording` when the user stops or the cap is reached. The relay attaches it with `SaveCallFile` once the Core call exists, retrying like delivery. | Help is never delayed by the recording. |
| D8 | Recording count | The relay is built for **N** recordings per SOS (`seq`, an idempotency key per upload, a configured cap). It ships with **N = 1**. | Raising N later is an app and config change, not a relay change. |
| D9 | Recording format and size | AAC in `.m4a`, mono, 16 kHz, 32 kbps, at most 60 s. The relay refuses a body over 400 KB without decoding it. | ~240 KB per minute; ~320 KB once Core's base64 JSON wraps it. |
| D10 | Recording storage | Postgres `bytea` in a `recordings` row. The bytes are cleared when Core answers 201 (the Core file id is kept). Undelivered audio is dropped when the SOS ends `failed`, when the call closes before the file is attached, and at the 24 h window. Railway's disk does not survive a deploy. | No new infrastructure; transactional with the submission; Core becomes the system of record for the audio. |
| D11 | What the caller sees about units | Unit **type**, status text, **coordinates** and **straight-line distance**, only for units whose status destination is this call, only while the call is active. No unit names or call signs. | Product asked for a ride-hailing style live view. Trimmed later if needed. |
| D12 | "Assigned" | A unit is on the call when `GetAllUnitStatuses` shows `DestinationType = 2` and `DestinationId = callId`. The relay cannot read the dispatch list. Before any unit qualifies the app shows "Help dispatched, waiting for a unit to respond". | Only signal Core gives the key. Opening the dispatch list to the key is a Core backlog item. |
| D13 | Polling | Fast only while the caller is watching (`live_watch_until` in the future): `GetCall` every 15 s, `GetAllUnitStatuses` every `UNIT_POLL_INTERVAL_S` (default 10 s) while any watched SOS is `dispatched`. Otherwise the current schedule (15 s received, 60 s dispatched, 5 min closed) and no unit polling. On subscribe the relay pushes its latest snapshot at once and polls as soon as the 15 s floor allows. | Cost follows attention. One unit poll covers every SOS in the department. |
| D14 | Caller movement | The app sends its location over the socket. It stays **on the relay**: used for distance and nothing else. It is never written to Core. | `EditCall` is a full replace: the relay would overwrite dispatcher edits, lose `DispatchList` (not readable) and write back `REDACTED` on protected departments. A narrow Core endpoint is a backlog item. |
| D15 | Socket auth | `Authorization: Bearer` on the upgrade, or a first `{type:"auth"}` message within 5 s. The app re-authenticates in-band before the 15 min token expires; otherwise close `4001`. Subscribing to an SOS the user does not own is refused. Revoking a session closes its sockets. | Works for React Native now and a browser later, with no token in a URL. |
| D16 | Fan-out | Postgres `LISTEN/NOTIFY` on channel `sos_live`, payload the submission id only. Every instance pushes from the database. "Watching" lives in the database (`live_watch_until`). | Works on today's single Railway instance and on two with no code change. |
| D17 | Distance | Haversine from each unit to the caller's latest live location, falling back to the incident location. No ETA. | A wrong ETA loses trust; a shrinking distance is honest. Road ETA can be added relay-side later. |
| D18 | Messages | Full, versioned snapshots. `version` only goes up; the app replaces its state and ignores older ones. On `closed` or `failed` the relay sends a final snapshot and closes `1000`. | Reconnects, deploys and missed notifications need no extra logic. |
| D19 | Legacy | Delete the device token, `/v1/devices/*`, attestation, `X-Status-Token`, the form fields and device-keyed abuse code, with a migration that drops their tables and columns. No client calls them (`auth-contract.md`: the demo app sends no SOS). | One auth model on the emergency path. |
| D20 | `AUTH_ENABLED` | Removed. Auth is always on, since the SOS route depends on it. | |

**Not in scope:** caller movement to Core, cancelling an SOS, road ETA, push notifications, reading
the dispatch list, SMS phone verification.

---

## 2. Core

### 2.1 Key scopes

The department key needs exactly: `calls.create`, `calls.read`, `calls.update`, `units.read`,
`reference.read`. Update `integration.md` §10 setup and the live checklist.

### 2.2 Calls the relay makes

| Call | Scope | Use |
|---|---|---|
| `POST Calls/SaveCall` | `calls.create` | Create the SOS, `IsPending: true`, `Idempotency-Key` = submission id. Unchanged except the field mapping (§3.2). |
| `GET Calls/GetPendingCalls` | `calls.read` | Unchanged: the `received` batch check. |
| `GET Calls/GetCall?callId=` | `calls.read` | State. Unchanged, but scheduled faster while watched (D13). |
| `POST CallFiles/SaveCallFile` | `calls.update` | Attach a recording. Body `{ CallId, UserId, Type: 1, Name, Data }`; `Data` is base64. Core ignores `UserId` and records the managing user, but the field is required, so send a fixed placeholder. 201 `{ Id }`. Active or pending calls only. |
| `GET UnitStatus/GetAllUnitStatuses` | `units.read` | Units heading to a call (D12) and their coordinates. |

`SaveCallFile` documents no `Idempotency-Key` (§15.3 says only `SaveCall` honours one; confirm in
Core before slice 5). Without it, a retry after a lost 201 can attach the audio twice. The
relay accepts that risk (a duplicate audio file is harmless to a dispatcher) and keeps the retry
count low (§4.4). `GetFilesForCall` is not open to the key, so the relay cannot check first.

### 2.3 Mock Core

`mock-core` gains `SaveCallFile` (stores the decoded size and the call id; refuses closed calls with
the same answer real Core gives) and `GetAllUnitStatuses` (a scripted list the tests can move). The
live checklist (`scripts/live-checklist.ts`) gains both, against a real dev instance.

---

## 3. HTTP API changes

### 3.1 Auth (`auth-contract.md`)

- `POST /v1/auth/signup`: fields `fullName`, `phone`, `password`, `device`. `email` is now an unknown
  field (`validation_failed`). `email_taken` is removed.
- `POST /v1/auth/signin`: fields `phone`, `password`, `device`. The constant-cost credential check is
  unchanged. The per-email limit becomes **10 per hour per phone**, counted by keyed phone hash.
- `GET /v1/me`: no `email`.

### 3.2 `POST /v1/sos`

- Headers: `Authorization: Bearer <accessToken>`, `Idempotency-Key` (UUID, one per SOS, unchanged).
  `X-Attestation` is removed.
- Body: `{ intakeCode, location?, address? }`. `location` keeps today's rules (at most 10 minutes
  old, not in the future, not 0,0). An unusable location with no address is a 400.
- Idempotency and one-open-SOS are per **user** (were per device), still split by demo/real.
- Limits: SOS per user (3 per 24 h), SOS per phone (3 per 24 h), SOS per IP (10 per hour), intake
  breaker. Same defaults, same answers.
- Mapping to `SaveCall`: `Name` `[PUBLIC SOS] SOS`; `Nature` `SOS – caller recording to follow`
  (the relay's fixed text, set in config as `SOS_NATURE_TEXT`); `ContactName` the user's full name;
  `ContactInfo` the user's phone; the note keeps "unverified member of the public" and
  "Phone: … (unverified)".
- Response: the receipt as today, without `statusToken`.

### 3.3 `GET /v1/sos/{receiptId}/status`

Authenticated by the owner's access token instead of `X-Status-Token`. Returns the same snapshot as
the socket (§5.3). Someone else's receipt is a 404, not a 403, so ids cannot be probed.

### 3.4 `POST /v1/sos/{receiptId}/recording` (new)

| | |
|---|---|
| Auth | The owner's access token. Not the owner: 404. |
| Headers | `Idempotency-Key` (UUID, one per recording, reused on every retry), `Content-Type: audio/mp4`, `X-Recording-Duration-Ms` (integer, 1–60000). |
| Body | The raw `.m4a` bytes, not JSON. At most 400 KB, else 413 `payload_too_large`. Empty: 400. |
| 202 | `{ recordingId, seq, status: "pending" }`. Stored; the relay will attach it. |
| 200 | The same body, for a replay of the same key and the same bytes. |
| 409 `recording_limit` | The SOS already has `RECORDINGS_PER_SOS` recordings (default 1). |
| 409 `sos_closed` | The SOS is `closed` or `failed`: the audio can never be attached. |
| 422 `idempotency_key_reused` | Same key, different bytes. |

The relay does not decode or transcode the audio. It checks the size, the `ftyp` box of an MP4
container and the declared duration, nothing else.

---

## 4. Recordings

### 4.1 Table

`recordings`: `id` (`rec_` + ULID), `submission_id` (cascade), `seq`, `idempotency_key`, `body_hash`,
`bytes` (`bytea`, nullable once cleared), `size`, `duration_ms`, `status`
(`pending` | `attached` | `dropped`), `core_file_id`, `attempts`, `next_attempt_at`, `drop_reason`,
`created_at`, `attached_at`. Unique `(submission_id, seq)` and `(submission_id, idempotency_key)`.

### 4.2 Upload

One transaction: lock the submission row, check ownership and status, check the cap, take the next
`seq`, insert. Bump the submission's `live_version` and `NOTIFY` (the snapshot shows
`recording.status`).

### 4.3 Attach worker

A job like the delivery worker, claiming due `pending` rows with `FOR UPDATE SKIP LOCKED`:

- Submission has no `core_call_id` yet: leave it, check again in 5 s.
- Submission is demo: mark `attached` with no Core call, clear the bytes.
- `SaveCallFile` 201: `attached`, store `core_file_id`, clear `bytes`.
- Core says the call is closed, or the submission is `closed`/`failed`: `dropped`, clear `bytes`.
- Timeout, 5xx, 429: back off (`delivery/backoff.ts`), at most 5 attempts, then `dropped`.
- 401/403: pause like delivery does (the key lost `calls.update`) and alert.

`Name` sent to Core: `{reference}-{seq}.m4a`, e.g. `SOS-7KQ2-1.m4a`.

### 4.4 Purge and logs

The purge job clears `bytes` of any row still `pending` when its submission leaves the 24 h window,
and deletes `recordings` rows with their submission (cascade, 30 days). Audio bytes and the
`Data` field are never logged; add them to the redaction paths.

---

## 5. Live status

### 5.1 Polling (D13)

- `submissions.live_watch_until` is set to `now + 60 s` on subscribe and on every heartbeat.
- While it is in the future, the poller schedules `GetCall` for that SOS every 15 s, whatever its
  status. When it lapses, the next poll falls back to the normal interval.
- **Unit poll.** A new step in the poller. When at least one watched SOS is `dispatched`, and
  `relay_state.units_next_poll_at` has passed, claim the step (advisory lock, like the received
  batch), call `GetAllUnitStatuses` once, and in one transaction per affected SOS replace its rows in
  `submission_units` and bump `live_version` if anything changed.
- `submission_units`: `submission_id`, `unit_key` (HMAC of the Core unit id, so the app can keep a
  marker without learning the id), `unit_type`, `status_text`, `lat`, `lon`, `status_at`. Rows are
  deleted when the SOS leaves `dispatched`.
- Coordinates are stored only for units with `DestinationType = 2` and `DestinationId` equal to the
  call id. Everything else from the response is discarded.

### 5.2 Socket

`GET /v1/live`, upgraded with `@fastify/websocket`.

App → relay:

| Message | Effect |
|---|---|
| `{type:"auth", token}` | First message when the upgrade had no `Authorization`, and again before each token expires. Must belong to the same user. |
| `{type:"subscribe", receiptId}` | Watch one SOS. Answered with its snapshot. One SOS per socket; a second subscribe replaces the first. |
| `{type:"location", lat, lon, accuracyM?, capturedAt}` | The caller's position. Same validation as the SOS body. Kept on the submission as `live_lat`, `live_lon`, `live_at`. At most one per 5 s is stored; extras are ignored. Never sent to Core. |
| `{type:"ping"}` | Heartbeat every 25 s. Refreshes `live_watch_until`. Answered with `{type:"pong"}`. |

Relay → app: `{type:"state", …}` (§5.3), `{type:"pong"}`, `{type:"error", code}`.

| Close code | Meaning | App does |
|---|---|---|
| `1000` | The SOS is final (`closed` or `failed`). | Stops. Shows the final state. |
| `4001` | No valid token in time, or the token expired. | Refreshes, reconnects. |
| `4003` | Session revoked. | Signs out. |
| `4004` | No such SOS for this user, or it was purged. | Stops. |
| `4008` | No ping for 60 s. | Reconnects. |
| `1012` | The relay is restarting (deploy). | Reconnects with backoff. |

After the 24 h window the SOS is `closed` (today's rule), so a subscribe gets the final snapshot and a
`1000`. After the 30-day purge it is `4004`.

### 5.3 Snapshot

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

- `units` is empty unless `status` is `dispatched`. `distanceM` is from the caller's live location
  if it is under 2 minutes old, else from the incident location, else absent.
- `recording.status` is `none`, `pending`, `attached` or `dropped` (the last recording's status).
- `version` is `submissions.live_version`, bumped in the same transaction as any change that shows.

### 5.4 Fan-out (D16)

Every transaction that bumps `live_version` runs `NOTIFY sos_live, '<submission id>'`. Each instance
holds one listening connection (outside the Kysely pool), keeps a map of submission id → sockets,
and on a notification reads the snapshot once and sends it to each. A dropped listener reconnects
and pushes a fresh snapshot to every socket it holds, so a missed notification costs at most one
interval.

---

## 6. Data model changes

One migration (`006_live_sos.sql`), in this order:

- `users`: drop `email`.
- `signin_attempts`: `email_hash` becomes `phone_hash`.
- `submissions`: add `user_id` (FK `users`, cascade); drop `device_id`, `nature_id`, `name`,
  `details`; `nature_label` stays as the fixed text. Idempotency unique and one-open index on
  `(user_id, …)`. Add `live_version bigint NOT NULL DEFAULT 0`, `live_watch_until`, `live_lat`,
  `live_lon`, `live_at`.
- `strikes`, `blocks`: `subject_type` `device` becomes `user`.
- `relay_state`: add `units_next_poll_at`.
- New `recordings`, `submission_units`.
- Drop `devices`, `device_registrations`, `nonces`.

Existing submissions belong to devices, and no app has sent a real SOS, so the migration **deletes
all existing submissions** rather than mapping them to users. Say so in the release note.

---

## 7. Slices

Each slice is built test-first against real Postgres in testcontainers, like the existing suite,
and lands as its own commit.

1. **Phone sign-in, no email.** Migration parts for `users` and `signin_attempts`; validator, sign-up,
   sign-in, `/v1/me`, tests, `auth-contract.md`.
2. **SOS on the user token, one tap.** `submissions.user_id`; `requireUser` on `/v1/sos` and status;
   the new body; mapping from the user; limits and strikes keyed by user and phone; owner-only status.
   Remove `AUTH_ENABLED`.
3. **Delete the device model.** `/v1/devices/*`, `src/devices`, `src/attestation`, `X-Status-Token`,
   their config (`ATTESTATION_MODE`, `IOS_*`, Play Integrity), tests and migration drops.
   `attestation-contract.md` marked retired.
4. **Recording upload.** `recordings` table, `POST /v1/sos/{id}/recording`, idempotency, cap, size and
   container checks.
5. **Recording attach worker.** Core client `saveCallFile`, mock-core endpoint, worker, backoff,
   drop rules, purge, redaction, metrics (`recordings_attached_total`, `recordings_dropped_total` by
   reason).
6. **Snapshot and live version.** `live_version` bumps everywhere a status, recording or unit change
   commits; `GET /v1/sos/{id}/status` returns the snapshot.
7. **Socket.** `@fastify/websocket`, auth and re-auth, subscribe, ping, close codes, session-revoke
   closes, caller location, `LISTEN/NOTIFY` fan-out, `live_watch_until`.
8. **Fast polling and units.** Watched scheduling for `GetCall`; the unit poll step; mock-core
   `GetAllUnitStatuses`; `submission_units`; distance; `UNIT_POLL_INTERVAL_S`.
9. **Docs and checklist.** `app-api-contract.md` rewritten for the new flow, `sos-relay-PRD.md`
   (media upload and live status are now in scope), `integration.md` (scopes, `SaveCallFile`,
   `GetAllUnitStatuses`), OpenAPI export, README, live checklist against a real Core.

Slices 1–3 are the auth change and can ship alone. 4–5 and 6–8 are independent of each other.

---

## 8. Tests that matter most

- A recording uploaded while the SOS is still `queued` is attached once the call exists, and never
  twice for one idempotency key.
- A recording for a call a dispatcher closed first ends `dropped`, with its bytes cleared.
- A socket on instance A receives a change committed by the poller on instance B (two app instances
  on one database).
- A user cannot subscribe to, upload to or read the status of another user's SOS (404/4004).
- A unit with a different destination never appears, and its coordinates are never stored.
- Watched polling never reads one call more often than every 15 s, across two instances.
- Token expiry and session revocation close open sockets.

---

## 9. Before a public release

- SMS phone verification before a Core-bound SOS.
- Attestation bound to the user session (store builds), or another proof of a genuine install.
- A second relay instance.
- Re-check D11 (live unit positions to the public) with the department.
- Core backlog: a key-readable list of a call's dispatched units; a narrow endpoint that records
  caller movement without replacing the call.
