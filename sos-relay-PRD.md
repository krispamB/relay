# PRD: SOS Relay

| | |
|---|---|
| **Status** | Draft v1, awaiting sign-off |
| **Date** | 2026-11-17 |
| **Component** | `sos-relay`: Node.js / Fastify service |
| **Serves** | The public SOS mobile app (`sos-app-PRD.md`) |
| **Talks to** | Resgrid Core (Sentinel) v4 REST API (`integration.md`) |
| **Precedence** | For anything about Core, `integration.md` wins over this document. For the public `/v1` API, this document wins over `sos-app-PRD.md` (see §16). |

Section numbers are kept compatible with the references in `sos-app-PRD.md` and `integration.md` (§5 Core, §6 department, §7.2 to §7.5 public API, §8 delivery, §10.2 pinning, §10.5 retention, §13.2 startup checks).

---

## 1. Summary

The relay is the only server the public SOS app talks to. It checks that a request comes from a genuine app install, applies abuse limits, and creates a **pending call** in one Resgrid department. It then tracks that call and reports a simple status back to the app: `queued`, `received`, `dispatched`, `closed` or `failed`.

The relay holds the department's Resgrid API key. The app holds no secret.

The rule that shapes most decisions here: **never let a caller believe an SOS reached dispatch when it did not.** When the relay cannot deliver, it says so quickly, so the caller phones instead.

---

## 2. Goals and non-goals

### Goals
- G1. Accept an SOS from an attested app install and create a pending call in Resgrid, exactly once.
- G2. Answer `POST /v1/sos` within 8 seconds, with a true statement of what happened.
- G3. Lose no accepted SOS to a restart, a crash or a Core outage shorter than 30 minutes.
- G4. Protect dispatchers from floods and repeat hoaxers without locking out real callers.
- G5. Keep personal data for 30 days and no longer.
- G6. Tell an operator at once when SOS delivery is broken.

### Non-goals (v1)
- More than one department. The schema is single-tenant; a second department is a later migration.
- SMS phone verification (§7.3).
- Cancelling or editing an SOS.
- Push notifications, chat, media upload.
- An admin UI, operator accounts or roles.
- Provisioning infrastructure, DNS, certificates or a live Resgrid key. The build ends at a relay that runs under Docker Compose and is ready to deploy on Railway (§14).

---

## 3. Actors

| Actor | Interaction |
|---|---|
| **App** | Calls the public `/v1` API. |
| **Core** | Receives `SaveCall`; answers state reads. |
| **Operator** | Uses the admin API from inside the private network; receives alerts. |
| **Dispatcher** | Never touches the relay. Works the pending call in Resgrid. |

---

## 4. Architecture

- **One process, one image.** It runs the public HTTP server, the admin HTTP server (separate port), the delivery worker, the status poller, the policy checker and the purge job. `RUN_JOBS=false` starts the HTTP servers only, so jobs can run as a separate instance.
- **Postgres is the only stateful dependency.** No Redis, no broker.
- **The `submissions` table is the delivery queue.** Workers claim rows with `FOR UPDATE SKIP LOCKED`, so two instances are safe.
- **Uniqueness is enforced by the database:** one submission per device and idempotency key, and one open submission per device, counted separately for real and demo submissions (partial unique index).
- **All time comes from an injected clock,** so every time-based rule is testable.
- **Graceful shutdown:** on SIGTERM stop accepting requests, finish the in-flight delivery, exit.

---

## 5. Core integration

`integration.md` is the specification. This section only lists what the relay uses.

### 5.1 Endpoints
`POST Calls/SaveCall`, `GET Calls/GetCall`, `GET Calls/GetPendingCalls`, `GET Calls/GetNewCallFieldPolicy`, `GET CallTypes/GetAllCallTypes`, `GET CallPriorities/GetAllCallPriorites`.

### 5.2 Rules the relay follows
- Auth with `X-Resgrid-ApiKey` only. Never send `Authorization` to Core.
- `SaveCall` always sends `IsPending: true` and `Idempotency-Key: <submission id>`. Success is 201 or 200 with an `Id`.
- Read `Status` in the envelope, not just the HTTP code. Not found is `"not_found"`.
- Timeouts: 6 s for `SaveCall`, 5 s for reads.
- Log Core's `RequestId` with every call.
- One Core call at a time for delivery. Never poll a call faster than once per 15 s.

### 5.3 Never-send list
The `SaveCall` body is built from an allowlist of twelve fields (`integration.md` §4.2). Empty values are omitted, never sent as `null`, `""` or `[]`. A unit test fails if any other key appears.

---

## 6. Department and intakes

### 6.1 Department
One department, configured by environment (§13.1): Core base URL, API key, key expiry date, call type name, priority id. The key is never written to the database.

### 6.2 Intakes
Intakes are defined in a JSON file named by `INTAKES_FILE`, or inline in `INTAKES_JSON` (for Railway, which has no file to mount), and validated at startup.

| Field | Notes |
|---|---|
| `code` | Public intake code, 6 to 32 characters, `[A-Za-z0-9-]`. |
| `displayName` | Shown in the app. |
| `emergencyPhone` | Shown on every app screen. |
| `natures` | List of `{ id, label }`. At least one. |
| `enabled` | `false` makes the intake return 410. |
| `demo` | `true` marks the demo intake (§6.3). At most one. |

`requireVerifiedPhone: true` is rejected at startup, because verification is not built (§7.3).

### 6.3 Demo intake
For store reviewers and production smoke tests.

- The whole public path runs for real: attestation, validation, limits, idempotency, receipt.
- The delivery worker **never calls Core** for a demo submission. It marks it `received` at once.
- Status then moves to `dispatched` after `DEMO_DISPATCH_AFTER_S` (default 30) and `closed` after `DEMO_CLOSE_AFTER_S` (default 90).
- Demo submissions have their own rate-limit counters, create no strikes, and are excluded from operational metrics and alerts.
- A test proves a demo submission can never reach the Core client.

### 6.4 Availability
The real intake is **unavailable** when any of these is true:
- delivery is paused (§8.4);
- the last policy check found a requirement the relay cannot meet (§13.3);
- the configured call type or priority was not found in Core (§13.2);
- no successful startup check has completed in the last 24 hours.

While unavailable, `POST /v1/sos` returns 503 without persisting, and `GET /v1/intake/:code` returns `available: false`. The demo intake is not affected.

---

## 7. Public API `/v1`

JSON over TLS. No cookies. Unknown body fields are rejected with 400.

**Error body** (all non-2xx):
```json
{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 3600 } }
```
`retryAfterSeconds` is present on 429 and 503, with a matching `Retry-After` header. A 403 never says why.

### 7.1 `GET /v1/intake/:intakeCode`
No auth.

```json
{
  "intakeCode": "LAGOS-FIRE",
  "displayName": "Lagos Fire Service",
  "emergencyPhone": "112",
  "natures": [{ "id": "medical", "label": "Medical emergency" }],
  "requireVerifiedPhone": false,
  "available": true,
  "demo": false,
  "required": { "location": false, "address": false, "name": false }
}
```
- 404 unknown code. 410 disabled intake.
- `required` reflects the Core field policy (§13.3) so the form can ask up front.

### 7.2 Device registration

**`GET /v1/devices/nonce`** returns `{ "nonce": "…", "expiresAt": "…" }`. Random 32 bytes, single use, 5-minute life, stored in Postgres.

**`POST /v1/devices/register`**
```json
{ "platform": "android", "nonce": "…", "attestation": { "integrityToken": "…" } }
{ "platform": "ios",     "nonce": "…", "attestation": { "keyId": "…", "attestationObject": "<base64>" } }
```
Response 201: `{ "deviceId": "dev_…", "deviceToken": "…", "expiresAt": "…" }`.

- **Android:** a classic Play Integrity token carrying the nonce. The relay decodes it through Google with a service account and requires: the nonce matches, package name and signing certificate digest match config, the app is Play-recognised, the device meets device integrity.
- **iOS:** the App Attest attestation object, verified locally: certificate chain to Apple's App Attest root, nonce, app ID hash, key ID. The relay stores the public key and the counter.
- **Device token:** 32 random bytes, opaque, stored only as a SHA-256 hash, valid 30 days.
- **Renewal:** the app registers again with a fresh attestation and sends its current token in `Authorization: Bearer`. If that token is known (even expired, up to 30 days), the relay keeps the same `deviceId`, so limits, strikes and blocks carry over. Without it, a new device is created.
- **Failures:** 400 bad or used nonce; 403 attestation failed or device blocked; 429 registration limit.

### 7.3 Phone verification
**Not built in v1.** The `verify-phone` routes are not registered and return 404. Callback numbers are unverified, and every call note says so. The device row keeps a nullable `phone_verified_at` so a later version adds routes and an SMS provider without a schema redesign.

### 7.4 `POST /v1/sos`

**Headers**

| Header | Notes |
|---|---|
| `Authorization: Bearer <deviceToken>` | Required. |
| `Idempotency-Key` | Required. UUID. One per SOS, reused on every retry. |
| `X-Attestation` | Fresh per attempt. Android: a standard Play Integrity token, as issued. iOS: an App Attest assertion, base64. Exact encodings are in `docs/attestation-contract.md`. |

**Attestation binding.** Let `h = SHA-256(Idempotency-Key + "\n" + raw request body bytes)`. The relay hashes the bytes as received, not re-serialised JSON.
- **iOS:** the assertion's `clientDataHash` is the 32 bytes of `h`. The counter must be greater than the stored one.
- **Android:** the token's `requestHash` is `h` in lowercase hex. The token must be under 5 minutes old and meet the same app and device checks as registration.

**Body**

| Field | Rules |
|---|---|
| `intakeCode` | Required. |
| `nature` | Required. One of the intake's nature ids. |
| `phone` | Required. Valid per `libphonenumber-js`. Accepted in E.164; stored and sent as E.164. |
| `location` | Optional: `lat`, `lon`, `accuracyM`, `capturedAt`, `source`. |
| `location.source` | `gps`, `network` or `last_known`. |
| `address` | Optional, up to 500 characters. Required when there is no usable `location`. |
| `name` | Optional, up to 100 characters. |
| `details` | Optional, up to 1000 characters. |

- **Location checks:** `lat` and `lon` in range and not `0,0`; `capturedAt` at most 10 minutes old and not in the future. A location that fails is dropped when an address is present, and is a 400 when it is not.
- **Sanitising:** strip control characters, collapse whitespace, trim. No HTML escaping.

**Order of checks**

1. Device token valid → else 401.
2. Device not blocked → else 403.
3. Headers and body valid → else 400.
4. Attestation valid → else 403 (see modes, §10.1).
5. Intake known and enabled → else 404 / 410.
6. Same device and `Idempotency-Key` seen before → return that submission (replay).
7. Device already has an open submission of the same kind (real or demo) → 409. A demo SOS never blocks, or stands in for, a real one.
8. Phone number not blocked → else 403.
9. Rate limits (§9.1) → 429, or 503 for the whole-intake breaker.
10. Intake available (§6.4) → else 503.
11. Persist as `queued`, then deliver (§8.1).

**Responses**

| HTTP | `status` | Meaning |
|---|---|---|
| 201 | `received` | Core created the pending call. |
| 201 | `failed` | Core rejected the call. It will not be retried. |
| 202 | `queued` | Saved; delivery is being retried. |
| 201 / 202 | any | Replay of an earlier request with the same key: the current state. 202 if still `queued`, otherwise 201. |
| 409 | – | An SOS from this device is already open. |

Success and replay body:
```json
{ "receiptId": "sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD", "statusToken": "…", "reference": "SOS-7KQ2",
  "status": "received", "submittedAt": "2026-11-17T14:03:22Z" }
```
The 409 body carries the error object plus the same five fields for the open submission.

- **`receiptId`** is the submission id: `sos_` + ULID. It is also Core's `Idempotency-Key` and `ExternalId`.
- **`reference`** is `SOS-` + 4 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, unique among stored submissions.
- **`statusToken`** is `HMAC-SHA256(STATUS_TOKEN_SECRET, receiptId)`, base64url. It is derived, not stored, so a replay or a 409 can return it again. This matters: after a timeout the app has no token, and the retry is how it gets one.

### 7.5 `GET /v1/sos/:receiptId/status`
Header `X-Status-Token`. No device token needed.

```json
{ "status": "dispatched", "reference": "SOS-7KQ2", "updatedAt": "2026-11-17T14:09:10Z" }
```
- **Reads the database only. Never calls Core.**
- A wrong or missing token, or an unknown receipt, returns 404. Tokens are compared in constant time.
- 429 if polled faster than once per 5 seconds for one receipt.
- Nothing from Core's call data is ever returned.

### 7.6 Health
`GET /healthz` on the public port returns 200 when the process is up and the database answers, else 503. It reveals nothing else.

---

## 8. Delivery

### 8.1 Flow
1. **Persist.** The row is committed as `queued` before any Core call.
2. **Inline attempt.** One `SaveCall`. The request has a 7.5-second total budget; the inline attempt is given what remains of it, at most 6 s. If the budget runs out, the response is `202 queued` and the worker takes over.
3. **Outcome:**

| Core result | Submission | Response |
|---|---|---|
| 201 / 200 with `Id` | `received`, call id stored | 201 `received` |
| 400 or another unlisted 4xx | `failed`, high alert | 201 `failed` |
| 401 / 403 | stays `queued`; delivery pauses (§8.4) | 202 `queued` |
| 409, 429, 5xx, timeout, network error | stays `queued` | 202 `queued` |

4. **Worker.** Retries `queued` submissions one at a time, oldest first.
5. **Hard stop.** 30 minutes after acceptance a `queued` submission becomes `failed`, with a high alert. A late SOS with a stale location is worse than a clear failure.

### 8.2 Mapping to the Core call

| Core field | Value |
|---|---|
| `IsPending` | `true` |
| `Priority` | `RESGRID_PRIORITY_ID` |
| `Type` | `RESGRID_CALL_TYPE_NAME` |
| `Name` | `[PUBLIC SOS] {nature label}`, cut to 100 characters |
| `Nature` | `{nature label}`, then `. {details}` when given |
| `Geolocation` | `lat,lon` with six decimals, dot separator, no spaces. Omitted without a location. |
| `Address` | Caller's address. `See map location` when the policy requires an address and only GPS was sent. |
| `ContactName` | Caller's name. `Unknown caller` when the policy requires a name and none was given. |
| `ContactInfo` | Phone in E.164 |
| `ExternalId` | `receiptId` |
| `ReferenceId` | `reference` |
| `Note` | The block below |

```
Public SOS submission (unverified member of the public)
Submitted: 2026-11-17T14:03:22Z   Reference: SOS-7KQ2
Phone: +2348012345678 (unverified)
Location: 6.524400,3.379200  accuracy ±12 m  source gps  captured 8 s before submission
Address given: 12 Marina Rd
```
Lines with no data are left out.

### 8.3 Retries and idempotency
- **Schedule:** 5 s, 15 s, 30 s, 60 s, then every 60 s. `Retry-After` on a 429 overrides the next delay.
- **Same `Idempotency-Key` on every attempt.** Core returns the same call id for a repeat, so a retry after an ambiguous timeout cannot create a second call.
- **App-side idempotency:** unique on device and `Idempotency-Key`. A repeat returns the stored submission and sends nothing. The body is not compared.
- **Inline and worker never overlap:** a new row is created with its next attempt time set past the inline budget.

### 8.4 Pause
- **Trigger:** a 401 or 403 from `SaveCall`. For a 401 from a read, the relay first calls `GetNewCallFieldPolicy`; it pauses only if that is also 401 (`integration.md` §5.1).
- **While paused:** no Core calls of any kind. New SOS get 503. Queued submissions stay queued and fail at their normal 30-minute mark.
- **State** is a row in Postgres, so it survives restarts.
- **Alert:** critical, at once, and again every 15 minutes until resumed.
- **Resume:** only by the admin API. Resume first calls `GetNewCallFieldPolicy`; if that fails with 401 or 403 the relay stays paused and says so.

### 8.5 Status poller
The poller owns every Core read.

| Submission status | Core read | Interval |
|---|---|---|
| `received` | One `GetPendingCalls` for all of them. A call missing from the list gets one `GetCall`. | 15 s, only while any exist |
| `dispatched` | `GetCall` each | 60 s |
| `closed` | `GetCall` each, to catch a re-open | 5 min |

- State mapping follows `integration.md` §5.3. An unknown state keeps the last status and raises a warning.
- **24-hour window,** from acceptance. After it, polling stops, and a submission still `received` or `dispatched` is set to `closed`. Otherwise a call nobody closes in Resgrid would stop that device from ever sending again.
- A transition into state 3 (Unfounded) or 7 (False alarm) records a strike (§9.2). A later re-open removes it.

---

## 9. Abuse controls

### 9.1 Limits
Defaults; all are configuration.

| Limit | Default | Response |
|---|---|---|
| SOS per device | 3 per 24 h | 429 |
| SOS per phone number | 3 per 24 h | 429 |
| SOS per IP address | 10 per hour | 429 |
| Registrations per IP address | 10 per hour | 429 |
| Whole intake | 30 SOS per 10 min | 503, critical alert |
| Status polls per receipt | 1 per 5 s | 429 |
| Any request, per IP address | 120 per minute | 429 |

- SOS limits count **accepted** submissions in the window, read from the `submissions` table. Refused requests and replays do not count.
- The open-SOS check (409) runs before the limits.
- The last two limits are held in memory per instance; they only protect the relay itself.
- Demo submissions are counted separately.

### 9.2 Strikes and blocks
- **Strike:** one for the device and one for the phone number each time a call is closed as Unfounded or False alarm. Strikes last 30 days.
- **Automatic block:** `HOAX_STRIKES_TO_BLOCK` (default 2) live strikes block that device or phone number for 30 days. Set it to 0 for alert-only. Every automatic block raises a warning alert.
- **Manual block and unblock** through the admin API.
- **Effect:** a blocked device or phone number gets 403 on `POST /v1/sos`, and a blocked device on register. No reason is given.
- **Phone numbers in strikes and blocks** are stored as `HMAC-SHA256(PHONE_HASH_SECRET, e164)`, never in the clear.

Known gap: the phone number is unverified, so the per-phone limit and phone blocks can be dodged by typing another number. Device limits rest on attestation and are the real control. A reinstall produces a new device; the registration limit slows that down but does not stop it.

---

## 10. Security and privacy

### 10.1 Attestation modes
`ATTESTATION_MODE` is `enforce` or `permissive`.
- **`enforce`:** any failed or missing attestation is a 403.
- **`permissive`:** the same checks run and the result is logged, but the request is accepted, including with no attestation. For simulators and staging.
- The process refuses to start in `permissive` when `NODE_ENV=production`, unless `ALLOW_PERMISSIVE_IN_PRODUCTION=true`.

### 10.2 TLS and pinning
- TLS is terminated by the platform edge (§14). The relay itself speaks plain HTTP inside the private network.
- **Pinning contract:** the app pins the public keys of the Let's Encrypt roots (ISRG Root X1 and X2), not the relay's own key. The platform issues and renews the relay's certificate and its key cannot be held stable, so a leaf pin could break every install at a renewal.
- This blocks interception through any other CA or a user-installed root. It does not block a certificate mis-issued by Let's Encrypt; attestation and the request-bound assertion still protect the SOS in that case.

### 10.3 Tokens and secrets
| Secret | Handling |
|---|---|
| Resgrid API key | Environment only. Never stored, logged or returned. |
| Device token | Stored as a SHA-256 hash. |
| Status token | Derived by HMAC; nothing stored. |
| Admin token | Environment. Constant-time compare. |
| Google service account | Environment (JSON). |

### 10.4 Logging
- `pino`, JSON. Redaction paths cover the Resgrid key, `Authorization`, `X-Status-Token`, `X-Attestation` and attestation payloads.
- Request bodies are never logged. Submissions appear in logs by `receiptId` and `reference` only.
- No phone number, name, coordinates, address or free text in logs, alerts or metrics.

### 10.5 Retention
- **Submissions** and their status history are hard-deleted 30 days after acceptance by an hourly purge job. No soft delete, no archive.
- **Devices** are deleted once their token has been expired for 30 days. **Registration records** (a keyed hash of the registering IP) are deleted after 30 days.
- **Strikes and blocks** are deleted when they expire. **Nonces** when they expire.
- **IP addresses** are stored on the submission for abuse investigation and go with it.
- **Erasure on request:** an admin endpoint deletes all submissions for a phone number or a reference.
- **Backups** must also age out within 30 days, or the retention promise is not true. This is a deployment setting (§14).
- **Encryption at rest** is the database's disk encryption. There is no column-level encryption: the relay must read the data to deliver it, so the key would sit beside the data.

---

## 11. Admin API, alerts and metrics

### 11.1 Admin API
Served on `ADMIN_PORT`, which is not exposed publicly. `Authorization: Bearer <ADMIN_TOKEN>`.

| Method and path | Purpose |
|---|---|
| `GET /admin/v1/health` | Paused or not and why, availability, last policy check, key expiry, queue depth, oldest queued age |
| `POST /admin/v1/delivery/pause` | Pause by hand |
| `POST /admin/v1/delivery/resume` | Check the key, then resume |
| `GET /admin/v1/submissions/:reference` | Status, timestamps, attempts, Core call id. No personal data. |
| `GET /admin/v1/blocks` | List live blocks |
| `POST /admin/v1/blocks` | Block a device id or phone number |
| `DELETE /admin/v1/blocks/:id` | Unblock |
| `POST /admin/v1/erasure` | Delete submissions by phone number or reference |
| `GET /metrics` | Prometheus metrics |

### 11.2 Alerts
One outbound webhook, `ALERT_WEBHOOK_URL`. Body:
```json
{ "severity": "critical", "code": "delivery_paused", "text": "[critical] SOS delivery paused: Core returned 401",
  "reference": null, "receiptId": null, "at": "2026-11-17T14:03:22Z" }
```
The `text` field makes the body usable by Slack and Discord webhooks as it is.

| Severity | Events |
|---|---|
| **Critical** | Delivery paused; field policy cannot be met; call type or priority not found; whole-intake breaker tripped |
| **High** | A submission ended `failed`; Core rejected a call with a 4xx |
| **Warning** | Key expires within 30 days, and again within 7; unknown call state; queue depth or oldest queued age over threshold; automatic block applied |

- 3-second timeout, three tries, never on the SOS request path.
- The same code is sent at most once per 15 minutes, except a failed submission, which always sends.
- Every alert is also a log line, so nothing is lost if the webhook is down.
- With no webhook configured, alerts are logged only, and startup logs a warning.

### 11.3 Metrics
Counters for submissions by outcome, Core calls by endpoint and result, attestation results by platform, rate-limit refusals by rule. Histograms for Core latency and `POST /v1/sos` latency. Gauges for queue depth, oldest queued age and paused state.

---

## 12. Data model

| Table | Holds |
|---|---|
| `devices` | id, platform, token hash, token expiry, iOS public key and counter, attested flag, registration IP hash, `phone_verified_at` (unused), timestamps |
| `nonces` | nonce, expiry, used flag |
| `submissions` | id, device id, idempotency key, intake code, demo flag, reference, status, nature, phone, name, location fields, address, details, IP, attempts, next attempt time, Core call id, Core state, failure reason, next poll time, accepted / delivered / closed timestamps |
| `submission_events` | submission id, from status, to status, time, cause |
| `strikes` | subject type (device or phone), subject, submission id, expiry |
| `blocks` | subject type, subject, reason, source (automatic or manual), expiry |
| `relay_state` | single row: paused flag, reason and time; last policy check result and time; last startup check time |
| `alert_log` | alert code, last sent time (for de-duplication) |

Key indexes: unique `(device_id, idempotency_key)`; unique `reference`; partial unique on `device_id` where status is `queued`, `received` or `dispatched`; the queue index on `(status, next_attempt_at)`.

---

## 13. Configuration and startup

### 13.1 Environment

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `ADMIN_PORT`, `HOST` | Runtime. `HOST` defaults to `::`. |
| `DATABASE_URL` | Postgres |
| `RUN_JOBS` | `false` to run the HTTP servers only |
| `CLIENT_IP_HEADER` | Header holding the client address. On Railway: `x-real-ip`. Required when `NODE_ENV=production`, because behind a proxy every caller would otherwise share one address and one rate limit; `ALLOW_SOCKET_IP_IN_PRODUCTION=true` overrides this for a relay reached directly. |
| `RESGRID_API_BASE`, `RESGRID_API_KEY`, `RESGRID_API_KEY_EXPIRES_ON` | Core |
| `RESGRID_CALL_TYPE_NAME`, `RESGRID_PRIORITY_ID` | Call defaults |
| `INTAKES_FILE` or `INTAKES_JSON` | Path to the intake definitions, or the JSON itself |
| `ATTESTATION_MODE`, `ALLOW_PERMISSIVE_IN_PRODUCTION` | §10.1 |
| `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_SHA256`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Play Integrity |
| `IOS_TEAM_ID`, `IOS_BUNDLE_ID`, `IOS_APP_ATTEST_ENV` | App Attest |
| `STATUS_TOKEN_SECRET`, `PHONE_HASH_SECRET`, `ADMIN_TOKEN` | Secrets, at least 32 bytes each |
| `ALERT_WEBHOOK_URL` | Optional |
| `DEMO_DISPATCH_AFTER_S`, `DEMO_CLOSE_AFTER_S` | Demo timing |
| Limit and threshold values | Every number in §9, with the defaults shown |

The process exits with a clear message if a required value is missing or malformed. `.env.example` documents every variable.

### 13.2 Startup checks
Run at start and then hourly, unless paused.
1. `GetAllCallTypes`: the configured name matches a `Name` exactly.
2. `GetAllCallPriorites`: the configured id exists and is not deleted.
3. `GetNewCallFieldPolicy`: see §13.3.
4. Key expiry date against today.

Outcomes:
- **A mismatch** makes the intake unavailable and raises a critical alert. The process keeps running.
- **A 401 or 403** pauses delivery (§8.4).
- **Core unreachable** is retried with backoff. The intake stays available if a check passed in the last 24 hours, and is unavailable otherwise.
- The process never exits on a Core failure. A crash loop sending a bad key could trip Core's lockout.

### 13.3 Field policy
| Required key | Relay behaviour |
|---|---|
| `what3words`, `incidentId`, `destinationPoi` | Cannot be met: intake unavailable, critical alert |
| `address` | `required.address` stays `false`; the relay sends `See map location` when only GPS is given |
| `contactName` | `required.name` stays `false`; the relay sends `Unknown caller` |
| `geolocation` | `required.location` becomes `true`; an SOS with no usable location is a 400 |
| Anything else | Always met, or not enforced for pending calls |

---

## 14. Deployment (Railway)

Deployment itself is outside this build. The repo carries what it needs.

- **Image:** multi-stage `Dockerfile`, Node 22, non-root user.
- **Local:** `docker-compose.yml` runs the relay, Postgres and the mock Core.
- **Migrations:** `npm run migrate`, run as a pre-deploy step, never at boot.
- **Static egress:** enable Railway's static outbound IPs (Pro plan) and put the addresses in the Resgrid key's allowlist. They change if the service moves region, and may be shared with other Railway customers, so the allowlist narrows where a leaked key works but not to this service alone.
- **Public and admin ports:** the public domain targets `PORT`. `ADMIN_PORT` is reachable only on the private network.
- **Client address:** set `CLIENT_IP_HEADER=x-real-ip`. Railway's edge sets it and does not send `X-Forwarded-For`.
- **TLS:** Railway issues and renews a Let's Encrypt certificate for the custom domain. See §10.2 for what that means for pinning.
- **Health check:** `/healthz`.
- **Backups:** set Postgres backup retention to 30 days or less (§10.5).
- **Two instances** are safe. Run jobs on one or both.

---

## 15. Stack, testing and acceptance

### 15.1 Stack
TypeScript strict, ES modules, Node 22, npm. Fastify 5. TypeBox schemas, with an OpenAPI document published by `@fastify/swagger` for the app to generate its client from. Kysely over `pg` with plain SQL migrations. `undici` for Core. `pino`. `libphonenumber-js`. `google-auth-library` for the Play Integrity decode call. An in-repo App Attest verifier on Node's crypto and a CBOR decoder. Biome. Vitest.

### 15.2 Testing
- **Unit:** Core body allowlist, state mapping, sanitising, reference codes, backoff schedule, limit windows, note block, attestation verifiers against fixtures.
- **Integration:** the real app against a real Postgres (Testcontainers) and the in-repo **mock Core**, which reproduces `integration.md`: 201 with `Id`, idempotent replay, 409 while in flight, 401, 403, field-policy 400, 429 with `Retry-After`, 5xx, slow responses, `not_found` envelopes.
- **Coverage required:** every row of `sos-app-PRD.md` §7.1, of `integration.md` §4.6 and §5.3, and of §7.4 and §8.1 here.
- **Live checklist:** `integration.md` §11 as a script run by hand against a real Sentinel test department. Not part of the automated suite.
- **CI:** GitHub Actions runs lint, typecheck and tests.

### 15.3 Acceptance criteria
- [ ] AC1. `docker compose up` gives a relay that accepts an SOS in permissive mode and creates a pending call in the mock Core.
- [ ] AC2. `POST /v1/sos` answers within 8 s in every Core failure mode.
- [ ] AC3. A retry with the same `Idempotency-Key` creates no second submission and no second Core call, and returns the status token.
- [ ] AC4. Killing the process after acceptance and restarting it still delivers the SOS.
- [ ] AC5. A Core 401 pauses delivery, raises a critical alert, makes new SOS return 503, and survives a restart. Resume works only through the admin API.
- [ ] AC6. A queued submission becomes `failed` at 30 minutes and raises an alert.
- [ ] AC7. A second SOS from a device with one open returns 409 with the open receipt.
- [ ] AC8. A dispatch in Core shows as `dispatched` within 15 s; a close as `closed` within 60 s.
- [ ] AC9. The status endpoint makes no Core call, and returns 404 for a wrong token.
- [ ] AC10. No `SaveCall` body ever contains a key outside the allowlist.
- [ ] AC11. A demo submission never reaches Core and walks through `received`, `dispatched`, `closed`.
- [ ] AC12. Each limit in §9.1 refuses at its threshold; two hoax closures block the device.
- [ ] AC13. In `enforce` mode a missing or invalid attestation is a 403; the process refuses `permissive` in production without the override.
- [ ] AC14. Submissions older than 30 days are gone after the purge job runs.
- [ ] AC15. No log line, alert or metric contains a phone number, name, coordinate, free text, token or key.
- [ ] AC16. Lint, typecheck and the full test suite pass.

---

## 16. Changes this makes to `sos-app-PRD.md`

| App PRD | Change |
|---|---|
| Q1 | Settled: the per-request attestation is bound to `SHA-256(Idempotency-Key + "\n" + raw body)` (§7.4). It travels in the `X-Attestation` header. |
| Q2 | Settled: `location.source` is `gps`, `network` or `last_known`. |
| Q3, §12.3 | Settled: the demo intake lives on the production relay and never reaches Core (§6.3). |
| §10.3, §10.4 | Pin the Let's Encrypt root keys, not the relay's leaf key (§10.2). |
| §7.1, 503 row | A 503 also means "the relay cannot deliver right now" (paused or unhealthy). The copy "Too many requests" is wrong for that case; the action (show the call button, no auto-retry) is right. |
| §7.1, 201 rows | A replay can return 201 with `dispatched` or `closed`, not only `received` or `failed`. |
| §7.1, 409 row | The 409 body includes `statusToken`, `reference` and `status` as well as `receiptId`. |
| §7, registration | On renewal, send the current device token so the device keeps its identity (§7.2). On iOS a renewal attests a new key. |
| §5, intake config | The response adds `available`, `demo` and `required` (§7.1). |
| §6.5, polling | The status endpoint can return 429 if polled faster than once per 5 s. |
| §4 | `requireVerifiedPhone` is always `false` in v1. |

---

## 17. Risks and open items

| # | Item | Notes |
|---|---|---|
| R1 | Live attestation is unproven | The verifiers are tested against fixtures. Real Play Integrity and App Attest need real devices from the Play internal track and TestFlight, which need the app. |
| R2 | Not yet run against a real Core | Everything is tested against the mock. The `integration.md` §11 checklist must pass against a Sentinel test department before go-live. |
| R3 | Core text length limits unknown | `integration.md` §4.2. The live checklist records the longest accepted `Nature`, `Address` and `Note`. |
| R4 | Deleted calls | What `GetCall` returns for a deleted call is unverified. Either answer maps to a sensible status. |
| R5 | Automatic blocks can lock out a real caller | Two "unfounded" closures block for 30 days. Tunable, and can be set to alert-only (§9.2). Review during the pilot. |
| R6 | 24-hour forced close | A call still active after 24 hours shows "Closed" in the app. |
| R7 | Unverified phone numbers | See §9.2. |
| R8 | Shared static egress IP | See §14. |
| R9 | Single department | A second department needs a schema migration and per-department config. |
