# sos-relay

The relay is the only server the public SOS mobile app talks to. It checks that a request comes from a genuine app install, applies abuse limits, and creates a **pending call** in one Resgrid (Core) department, then reports a simple status back to the app: `queued`, `received`, `dispatched`, `closed` or `failed`. It holds the department's Resgrid API key; the app holds no secret. One Node 22 / Fastify 5 / TypeScript process, with Postgres as its only stateful dependency.

| Read this | For |
|---|---|
| [`sos-relay-PRD.md`](sos-relay-PRD.md) | What the relay does, the public API, delivery rules, limits, deployment, acceptance criteria, open risks. The source of truth for behaviour. |
| [`integration.md`](integration.md) | The contract with Resgrid Core: endpoints, auth, errors, the Core-side setup (section 10) and the live test checklist (section 11). Wins over the PRD on anything about Core. |
| [`docs/app-api-contract.md`](docs/app-api-contract.md) | **For the app team:** every endpoint the app uses, what to send, every answer and what to do with it, retries, limits. The OpenAPI document is [`docs/openapi.json`](docs/openapi.json) (served at `/v1/openapi.json`; regenerate with `npm run openapi`). |
| [`docs/attestation-contract.md`](docs/attestation-contract.md) | What the app must send so the relay can verify an install (Play Integrity, App Attest). |
| [`docs/auth-contract.md`](docs/auth-contract.md) | **For the demo app:** sign-up, sessions, `GET /v1/me`, with their own error codes. Built behind `AUTH_ENABLED`; see [Auth (demo app)](#auth-demo-app). Plan: [`docs/auth-implementation-plan.md`](docs/auth-implementation-plan.md). |

Also: [`sos-app-PRD.md`](sos-app-PRD.md) (the app), [`mock-core/README.md`](mock-core/README.md) (the mock Core and its `/__control` endpoints), [`.env.example`](.env.example) (every setting).

## Status: read this before relying on anything below

Everything here is tested against the in-repo mock Core only. **Nothing has been run against a real Resgrid Core, and no real device attestation (Play Integrity, App Attest) has been tested.** See [Before go-live](#before-go-live).

## Quick start (Docker Compose)

Needs Docker with Compose. This starts Postgres, the mock Core, a one-shot migration, and the relay in `permissive` attestation mode, with the example intakes from `intakes.example.json`.

```sh
docker compose up --build
```

| What | Where |
|---|---|
| Public API | `http://localhost:3000` |
| Admin API | `http://localhost:3001` (bound to 127.0.0.1) |
| Mock Core | `http://localhost:4010` (control endpoints under `/__control`) |
| Intakes | `EXAMPLE-FD-01` (real path, delivers to the mock Core), `DEMO-INTAKE-01` (demo, never reaches Core) |
| Dev admin token | `dev-only-admin-token-not-for-production-000000001` |

### Walk-through with curl

Needs `curl` and `jq`. Each step uses the request shapes of the route schemas in `src/routes/` and `src/sos/schemas.ts`.

```sh
RELAY=http://localhost:3000
MOCK=http://localhost:4010
CODE=EXAMPLE-FD-01

# 1. The intake: department, natures, whether it can take an SOS right now.
curl -s $RELAY/v1/intake/$CODE | jq

# 2. A single-use nonce (5 minute life).
NONCE=$(curl -s $RELAY/v1/devices/nonce | jq -r .nonce)

# 3. Register a device. The relay is in permissive mode, so no attestation is sent.
TOKEN=$(curl -s -X POST $RELAY/v1/devices/register \
  -H 'content-type: application/json' \
  -d "{\"platform\":\"android\",\"nonce\":\"$NONCE\"}" | jq -r .deviceToken)

# 4. Send an SOS. The Idempotency-Key must be a UUID; reuse it on every retry of this SOS.
SOS=$(curl -s -X POST $RELAY/v1/sos \
  -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -H 'content-type: application/json' \
  -d '{"intakeCode":"EXAMPLE-FD-01","nature":"medical","phone":"+2348012345678","address":"12 Marina Road","name":"Test caller","details":"Walk-through test"}')
echo "$SOS" | jq
RECEIPT=$(echo "$SOS" | jq -r .receiptId)
STATUS_TOKEN=$(echo "$SOS" | jq -r .statusToken)

# 5. Its status (database only; never calls Core). Do not poll faster than once per 5 s.
curl -s $RELAY/v1/sos/$RECEIPT/status -H "x-status-token: $STATUS_TOKEN" | jq

# 6. What the relay created in the mock Core: one pending call (InitialState 8).
curl -s $MOCK/__control/calls | jq '.[0] | {CallId, State, InitialState, Name, ExternalId, ReferenceId}'

# 7. Play dispatcher: dispatch that call in the mock (state 0; 1 to 7 are the close variants).
CALL_ID=$(curl -s $MOCK/__control/calls | jq -r '.[0].CallId')
curl -s -X POST $MOCK/__control/calls/$CALL_ID/state -H 'content-type: application/json' -d '{"state":0}'

# 8. The status poller reads Core every 15 s while a call is `received`, so wait, then ask again.
sleep 20
curl -s $RELAY/v1/sos/$RECEIPT/status -H "x-status-token: $STATUS_TOKEN" | jq
```

Expected: step 4 returns HTTP 201 with `"status": "received"`; step 6 shows one call with `InitialState` 8; step 8 shows `"status": "dispatched"`. A device may have one open SOS at a time, so a second step 4 with the same token returns 409 until the first call is closed: dispatch it as in step 7 with `{"state":1}` and wait for the status to read `closed`, or register another device.

To try the demo intake, use `"intakeCode":"DEMO-INTAKE-01"` in step 4: it answers `received` at once and never touches the mock Core, then moves to `dispatched` after 30 s and `closed` after 90 s.

**Verified** on 2026-11-17 from a clean `docker compose up --build` (host ports remapped, because 3000 and 3001 were taken on that machine): steps 1 to 8 gave the expected results, a repeat of step 4 with the same key returned the same receipt without a second call in the mock, and the demo intake moved to `dispatched` without reaching the mock Core.

Stop with `docker compose down` (add `-v` to drop the database).

## Local development (no Docker for the app)

Node 22 and npm. Postgres is needed for the tests and to run the relay.

```sh
npm ci
npm run typecheck        # tsc --noEmit
npm run lint             # biome check .
npm run format           # biome check --write .
npm test                 # vitest run
npm run mock-core        # mock Core on :4010 (PORT, MOCK_CORE_API_KEY override)
npm run openapi          # regenerate docs/openapi.json after changing a route schema (a test fails if it is stale)
npm run migrate:dev      # apply migrations to DATABASE_URL
npm run dev              # relay with file watching (reads the environment; see .env.example)
npm run build && npm start   # compiled build, as in the Docker image
```

**Tests and Postgres.** The suite starts one throwaway `postgres:16-alpine` container through Testcontainers, so **Docker must be running**. To use a database you already have instead, set `TEST_DATABASE_URL` (the tests empty its tables, so never point it at data you care about):

```sh
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/relay_test npm test
```

`test/e2e/` wires the real public app, the real Core client, the mock Core and Postgres together; only attestation and the clock are fake. `npx vitest run test/e2e` runs just those.

## Configuration

[`.env.example`](.env.example) documents every variable and its default; `src/config.ts` is the source of truth, and the process exits at startup with every problem listed if a required value is missing or malformed. The ones that matter most:

| Variable | Why it matters |
|---|---|
| `DATABASE_URL` | Required. The only stateful dependency. |
| `RESGRID_API_BASE`, `RESGRID_API_KEY`, `RESGRID_API_KEY_EXPIRES_ON` | The Core instance and key. Core has no endpoint to read a key's expiry, so you must give the date; the relay warns at 30 and 7 days. |
| `RESGRID_CALL_TYPE_NAME`, `RESGRID_PRIORITY_ID` | Must match Core exactly (the type name is case-sensitive). A mismatch makes the intake unavailable. |
| `INTAKES_JSON` or `INTAKES_FILE` | The intakes (see `intakes.example.json`). `INTAKES_JSON` wins when both are set. |
| `PHONE_HASH_SECRET`, `ADMIN_TOKEN` | At least 32 bytes each (`openssl rand -hex 32`). Changing the first orphans existing phone strikes and blocks. |
| `AUTH_TOKEN_SECRET` | Required, at least 32 bytes (`openssl rand -hex 32`). Auth is always on: the SOS routes take the signed-in user's access token (`AUTH_ENABLED` is gone). It signs access tokens and derives refresh tokens: changing it signs every user out. |
| `SOS_NATURE_TEXT` | The Nature of every SOS call in Core (default `SOS – caller recording to follow`), at most 200 characters. The caller sends no nature: the recording carries what happened. |
| `CLIENT_IP_HEADER` | Header holding the caller's address. Unset locally. On Railway: `x-real-ip`. Wrong value means every caller shares one IP and the per-IP limits misfire. |
| `ALERT_WEBHOOK_URL` | Where alerts go. Unset means alerts are only logged. |
| `RUN_JOBS` | `false` runs the HTTP servers only (jobs elsewhere). |

## Auth (demo app)

The demo app signs users up and keeps them signed in. It sends no SOS. The endpoints are `POST /v1/auth/signup`, `POST /v1/auth/signin`, `POST /v1/auth/refresh`, `POST /v1/auth/signout` and `GET /v1/me`, specified in [`docs/auth-contract.md`](docs/auth-contract.md) (the contract; its section 7 is the acceptance checklist, walked by `test/e2e/auth.e2e.test.ts`) and built as in [`docs/auth-implementation-plan.md`](docs/auth-implementation-plan.md). They are off unless `AUTH_ENABLED=true`, and need `AUTH_TOKEN_SECRET`. Sign-in returns a new session for an existing account: 20 attempts per hour per client IP and 10 per hour per email address.

- **Separate from SOS.** An access token (15 minutes) is never accepted on the SOS routes, and a device token is never accepted on the auth routes. An account and a registered device are not linked.
- **Own error codes.** The auth endpoints answer with the codes in the auth contract; the SOS routes keep the ones in the app API contract.
- **Migration.** `migrations/004_auth.sql` and `migrations/005_signin_attempts.sql` run with the others, whether or not auth is on.
- **OpenAPI.** `docs/openapi.json` documents the auth routes (tag `auth`, security scheme `accessToken`, next to `deviceToken`). A relay with `AUTH_ENABLED=false` serves the same document without them.
- **Data retention.** Accounts are **not** purged: every demo account is deleted by an operator before a public release (contract section 8). The purge job deletes refresh tokens 7 days after they expire or are revoked, sign-up idempotency records and phone attempt records 24 hours after they are created, and sign-in attempt records 1 hour after they are created. SOS data keeps its 30 days.

## Deploying on Railway

Follows [PRD section 14](sos-relay-PRD.md#14-deployment-railway). The repo carries a multi-stage `Dockerfile` and `railway.json` (Dockerfile build, pre-deploy migration `node dist/src/db/migrate.js`, health check `/healthz`). Nothing here has been deployed yet.

1. **Core first.** Do the Core-side setup below, so you have the key, call type name and priority id.
2. **Create the project and a Postgres service.** Note the backup setting in step 8.
3. **Create the relay service from this repo.** Railway uses `railway.json`: builds the Dockerfile, runs the migration as a pre-deploy step (never at boot), and checks `/healthz`.
4. **Set the variables** on the relay service (secrets as secret variables):
   - `DATABASE_URL` = reference to the Postgres service's `DATABASE_URL`.
   - `NODE_ENV=production`.
   - `RESGRID_API_BASE`, `RESGRID_API_KEY`, `RESGRID_API_KEY_EXPIRES_ON`, `RESGRID_CALL_TYPE_NAME`, `RESGRID_PRIORITY_ID`.
   - `INTAKES_JSON` = the intakes array on one line. Do **not** set `INTAKES_FILE` (the image has no intakes file).
   - `CLIENT_IP_HEADER=x-real-ip` (Railway's edge sets it and does not send `X-Forwarded-For`).
   - `AUTH_TOKEN_SECRET`, `PHONE_HASH_SECRET`, `ADMIN_TOKEN`, and `ALERT_WEBHOOK_URL`.
   - Leave `PORT` to Railway; leave `HOST` unset (it defaults to `::`, which Railway's private network needs). `ADMIN_PORT` defaults to 3001 and must differ from `PORT`.
5. **Static outbound IP, then the key allowlist.** Enable Railway's static outbound IPs on the relay service (Pro plan), then put those addresses in the Resgrid key's IP allowlist. They change if the service moves region and may be shared with other Railway customers, so the allowlist narrows where a leaked key works but does not tie it to this service alone. Core caches key changes for up to 60 seconds.
6. **Public domain.** Add a domain to the relay service targeting `PORT`. Railway issues and renews a Let's Encrypt certificate; the app pins the ISRG Root X1 and X2 public keys, not the relay's (PRD section 10.2). Do not add a public domain or TCP proxy for `ADMIN_PORT`.
7. **Check it.** `GET https://<domain>/healthz` returns 200. `GET https://<domain>/v1/intake/<code>` should show `"available": true` once the startup checks have passed (the real intake is unavailable until a check against Core has succeeded; see PRD section 6.4).
8. **Backups.** Set Postgres backup retention to **30 days or less**. The relay deletes data after 30 days; a longer-lived backup breaks that promise (PRD section 10.5).
9. **Admin API.** It is reachable only on the private network (`<relay service>.railway.internal:3001`). Run admin commands from inside it: from another service in the same project, or from a shell in the relay container. The image is `node:22-slim`, which has no `curl`, so from a shell in that container use Node:
   ```sh
   node -e 'fetch("http://localhost:3001/admin/v1/health",{headers:{authorization:"Bearer "+process.env.ADMIN_TOKEN}}).then(r=>r.text()).then(console.log)'
   ```
10. **Two instances** are safe (workers claim rows with `FOR UPDATE SKIP LOCKED`). Jobs may run on one or both; `RUN_JOBS=false` makes an HTTP-only instance.

### Core-side setup

From [`integration.md` section 10](integration.md#10-core-side-setup-configuration-only); a department admin does this once in the Resgrid web UI:

1. Create a call type named exactly as `RESGRID_CALL_TYPE_NAME` (for example `Public SOS`).
2. Pick the call priority for SOS calls; note its numeric id (`RESGRID_PRIORITY_ID`). It is also visible through `GetAllCallPriorites`.
3. Security, API Keys: create a key with scopes `calls.create`, `calls.read`, `reference.read` only. Set the IP allowlist to the relay's egress IP. Set an expiry of 730 days or less and record the date as `RESGRID_API_KEY_EXPIRES_ON`.
4. Review the new-call field policy ([integration.md section 7](integration.md#7-required-field-policy-get-callsgetnewcallfieldpolicy)). If it requires `what3words`, `incidentId` or `destinationPoi`, the relay cannot meet it and the intake stays unavailable.
5. Confirm the department's managing user is allowed to create calls (true by default for a department admin).

## Operating it

### Admin API

Port `ADMIN_PORT` (default 3001), never public. Every request needs `Authorization: Bearer <ADMIN_TOKEN>`. Examples use the Compose dev token:

```sh
A=http://localhost:3001
H="authorization: Bearer dev-only-admin-token-not-for-production-000000001"

# Health: paused or not and why, availability, last check, key expiry, queue depth and age.
curl -s $A/admin/v1/health -H "$H" | jq

# Pause delivery by hand (optional JSON body {"reason": "..."}).
curl -s -X POST $A/admin/v1/delivery/pause -H "$H" -H 'content-type: application/json' -d '{"reason":"maintenance"}' | jq

# Resume: asks Core (GetNewCallFieldPolicy) whether the key works; stays paused if it does not.
curl -s -X POST $A/admin/v1/delivery/resume -H "$H" | jq

# One submission by its reference (no personal data).
curl -s $A/admin/v1/submissions/SOS-7KQ2 -H "$H" | jq

# Blocks: list, add (by device id or phone number), remove.
curl -s $A/admin/v1/blocks -H "$H" | jq
curl -s -X POST $A/admin/v1/blocks -H "$H" -H 'content-type: application/json' \
  -d '{"phone":"+2348012345678","reason":"repeat hoax","days":30}' | jq
curl -s -X DELETE $A/admin/v1/blocks/<block id> -H "$H" | jq

# Erase submissions by phone number or by reference.
curl -s -X POST $A/admin/v1/erasure -H "$H" -H 'content-type: application/json' -d '{"reference":"SOS-7KQ2"}' | jq

# Prometheus metrics.
curl -s $A/metrics -H "$H"
```

A body with `{"deviceId": "dev_..."}` instead of `phone` blocks a device. Resume returns 409 `core_auth_failed` if Core still refuses the key, and 503 `core_unreachable` if Core cannot be reached.

### Alerts

One outbound webhook (`ALERT_WEBHOOK_URL`); body `{severity, code, text, reference, receiptId, at}`. The `text` field works as-is in Slack and Discord. The same code is sent at most once per 15 minutes, except a failed submission, which always sends. Every alert is also a log line.

| Code | Severity | Meaning | What to do |
|---|---|---|---|
| `delivery_paused` | critical | Core answered 401 or 403 to `SaveCall` (or an operator paused). No Core calls are made and new SOS get 503. If the 401/403 came during a caller's own request, that caller was answered 503 too and the SOS was marked `failed` (never delivered, even after resume; `GET /admin/v1/submissions/<reference>` shows `failure_reason: not sent: ...`). SOS already answered 202 `queued` wait, and fail at 30 minutes unless delivery resumes first. Repeats every 15 minutes while paused. | Find out why Core refuses the key: expired, revoked, wrong environment, relay egress IP not in the key's allowlist, or the key lacks `calls.create` (403). Fix the key (a new key means updating `RESGRID_API_KEY` and redeploying). **Then** `POST /admin/v1/delivery/resume`. Do not resume before the key is fixed: repeated unrecognised keys can trip Core's lockout. |
| `field_policy_unmeetable` | critical | Core's field policy requires `what3words`, `incidentId` or `destinationPoi`. The intake is unavailable. | Change the field policy in Resgrid. The next hourly check clears it. |
| `core_reference_mismatch` | critical | The configured call type name or priority id was not found in Core. The intake is unavailable. | Fix `RESGRID_CALL_TYPE_NAME` / `RESGRID_PRIORITY_ID` or the data in Resgrid. |
| `intake_breaker_tripped` | critical | More than 30 SOS in 10 minutes (defaults): the whole intake refuses with 503. | Check for a flood or a hoax campaign; see the blocks API. It clears as the window passes. |
| `submission_failed` | high | A submission ended `failed`, for example it was not delivered within 30 minutes. The caller was told, and should have phoned. | Look it up with `GET /admin/v1/submissions/<reference>`; find why Core was unreachable. |
| `core_rejected_call` | high | Core rejected a `SaveCall` with a 4xx; it is not retried. A message like `Required call fields are missing: ...` is a field-policy problem. | Fix the Core configuration or the relay mapping; this is a configuration problem or a relay bug. |
| `resgrid_key_expiring` | warning | The key expires within 30 days, and again within 7. | Issue a new key, update the variable and the expiry date, redeploy. |
| `unknown_call_state` | warning | Core returned a call `State` the relay does not know; the status is left unchanged. | Check which state it is; it may need adding to the mapping. |
| `queue_backlog` | warning | Queue depth or oldest queued age is over the threshold (`QUEUE_DEPTH_WARN`, `OLDEST_QUEUED_WARN_S`). | Check Core health; see `delivery_paused`. |
| `automatic_block` | warning | A device was blocked after repeated unfounded or false-alarm closures, or such a block was lifted because a closure was reversed in Core. | Review it; unblock through the blocks API if it was a real caller (PRD risk R5). |
| `phone_hoax_threshold` | warning | A phone number reached `HOAX_STRIKES_TO_BLOCK` unfounded or false-alarm closures. It was **not** blocked: phone numbers are unverified, so a hoaxer could give a stranger's number. The alert names the SOS reference, never the number. | Look the reference up in Resgrid, review the calls, and block the number through the blocks API (`{"phone": "+..."}`) only if you judge it warranted (PRD section 9.2). |

### Metrics

`GET /metrics` on the admin port (Prometheus text format), behind the admin token. Counters: submissions by outcome, Core calls by endpoint and result, attestation results, rate-limit refusals by rule, and with auth on `auth_signups_total` (created, replay), `auth_signins_total` (success, invalid_credentials, rate_limited), `auth_refreshes_total` (rotated, grace, reuse_detected, revoked, invalid, rate_limited) and `auth_signouts_total` (revoked, noop). Histograms: Core latency and `POST /v1/sos` latency. Gauges: `sos_queue_depth`, `sos_oldest_queued_age_seconds`, `sos_delivery_paused`. Metrics and logs carry no phone number, name, coordinate or free text.

## Before go-live

None of this is done. Do not point a public app at this relay until each item is ticked.

1. **Live checklist against a real Core.** [`scripts/live-checklist.ts`](scripts/live-checklist.ts) automates [`integration.md` section 11](integration.md#11-integration-test-checklist) against a real Resgrid **test** department. It **creates real pending calls** in the department the key belongs to, and Core's API offers the relay no way to delete them, so you must close or delete them by hand. It needs an explicit flag:
   ```sh
   RESGRID_API_BASE=https://... RESGRID_API_KEY=rgk_... \
   RESGRID_CALL_TYPE_NAME="Public SOS" RESGRID_PRIORITY_ID=3 \
   npx tsx scripts/live-checklist.ts --yes-create-test-calls            # interactive: asks you to dispatch, close, delete, paste throwaway keys
   npx tsx scripts/live-checklist.ts --yes-create-test-calls --no-interactive   # skips every item that needs a human
   ```
   Items that need a human or another key (no notification sent, a key without `calls.create`, an address outside the IP allowlist, revoking a key, changing the field policy, dispatching and closing a call) are printed as manual steps; a `--no-interactive` run leaves them **unproven**. It also records the two measurements the PRD wants: what `GetCall` returns for a deleted call, and the longest `Name`, `Nature`, `Address` and `Note` Core accepts. It has been run only against the mock Core.
2. **Real-device attestation.** Verifiers are tested against fixtures only. Test registration and SOS with real Play Integrity tokens (Play internal testing track) and real App Attest (TestFlight), in `enforce` mode, using [`docs/attestation-contract.md`](docs/attestation-contract.md). Needs the app.
3. **Acceptance criteria.** Walk through [PRD section 15.3](sos-relay-PRD.md#153-acceptance-criteria) (AC1 to AC16) in the deployed environment, including killing the process and restarting, and a Core 401.

### Open risks, not yet verified

From [PRD section 17](sos-relay-PRD.md#17-risks-and-open-items):

- **R1 Live attestation is unproven.** Fixtures only.
- **R2 Not run against a real Core.** Everything passes against the mock, which was written from `integration.md`, not from a real instance. Where the two differ, Core wins.
- **R3 Core text length limits are unknown.** The live checklist measures them.
- **R4 Deleted calls.** What `GetCall` returns for a deleted call is unverified. The relay maps both plausible answers to a sensible status.
- **R5 Automatic device blocks can lock out a real caller.** Two unfounded closures block a device for 30 days; tune `HOAX_STRIKES_TO_BLOCK` (0 = no automatic blocks and no strike alerts) and review during the pilot. Phone numbers are never blocked automatically.
- **R6 24-hour forced close.** A call still active after 24 hours shows as closed in the app.
- **R7 Phone numbers are unverified.** The per-phone limit and manual phone blocks can be dodged by typing another number, and a hoaxer can give a stranger's number, so phone strikes only alert (`phone_hoax_threshold`); device limits rest on attestation.
- **R8 Shared static egress IP.** See Railway step 5.
- **R9 Single department.** A second department needs a schema migration and per-department config.
