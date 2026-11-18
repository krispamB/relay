# Auth implementation plan (demo)

Implements [`auth-contract.md`](auth-contract.md) inside the relay. The contract wins over this plan;
if they disagree, fix the plan. Every slice is built test-first (red, green, refactor) against real
Postgres in testcontainers, like the existing suite, and lands as its own commit.

## Decisions

| Topic | Decision |
|---|---|
| Where | Inside the relay, as `src/auth/`, registered as an encapsulated Fastify plugin (`app.register`) so it has its own error handler. The SOS routes keep theirs. |
| Switch | `AUTH_ENABLED` (default `false`). When off, no auth route is mounted and the relay behaves exactly as today. |
| Secret | `AUTH_TOKEN_SECRET`, required when auth is on, at least 32 bytes. Three keys are derived from it with HKDF: access-token signing, refresh-token derivation, sign-up body hashing. |
| Password hashing | `@node-rs/argon2`, Argon2id, library defaults (19 MiB, 2 passes). Node's built-in `crypto.argon2` needs Node 24.7+ and is a release candidate; the image is `node:22-slim`. |
| Access token | HS256 JWT signed with `node:crypto` (no new dependency). Claims: `sub` (user id), `fam` (family id), `jti` (refresh-token row id), `iat`, `exp`. Fully deterministic: no random claims. |
| Refresh token | `rt_` + base64url(HMAC(K_refresh, parentToken)) for a rotation; `rt_` + 32 random bytes for a new family. Stored only as a SHA-256 hash. |
| Grace window | Re-presenting a parent within 30 s re-derives the child, looks up its row, and re-signs the access token from the stored `iat`/`exp`: the same pair, byte for byte. Nothing secret is stored readably. |
| Ids | UUID v4 (`crypto.randomUUID`) for users and families. |
| Time | Always `ctx.clock`, so tests drive the 30 s, 15 min and 90 day rules with `FakeClock`. |

## Slices

### 1. Config and schema
- `AUTH_ENABLED`, `AUTH_TOKEN_SECRET` in `src/config.ts`, validated at start-up with the other secrets.
- `migrations/004_auth.sql`:
  - `users`: id, full_name, phone (unique), email (unique, stored lowercased), password_hash, created_at, updated_at.
  - `token_families`: id, user_id (cascade), install_id, platform, app_version, created_at, revoked_at.
  - `refresh_tokens`: id, family_id (cascade), user_id, parent_id, token_hash (unique), issued_at, expires_at, rotated_at, access_iat, access_exp.
  - `signup_idempotency`: key (pk), body_hmac, user_id, created_at.
  - `signup_phone_attempts`: phone_hash, created_at (for the 3-per-day limit).
- Types in `src/db/types.ts`.
- Tests: the migration applies; config refuses a missing or short secret when auth is on.

### 2. Tokens (`src/auth/tokens.ts`): pure functions, no HTTP
- `signAccessToken`, `verifyAccessToken` returning `valid | expired | invalid` (expired = good signature, past `exp`).
- `newRefreshToken`, `deriveChildRefreshToken`, `refreshTokenHash`.
- Tests: re-signing is byte-identical; wrong key, tampering, `alg` other than HS256 and malformed input are `invalid`; expired is told apart from invalid.

### 3. Validation and errors (`src/auth/validate.ts`, `src/auth/errors.ts`)
- A hand-written validator collecting **every** invalid field as `{ field, code }`. Not an object, wrong JSON types or bad JSON: `malformed_request`. Unknown field: `validation_failed`.
- The plugin's error handler maps to the contract's codes, including `413 payload_too_large`, and sets `Retry-After` on 429 and 503.
- Table-driven tests for every field error code in the contract.

### 4. `POST /v1/auth/signup`
- Order: idempotency replay, validation, rate limits, uniqueness, hash, then one transaction creating user, family, refresh token and idempotency row.
- Same key and same body: replay (same user, new session). Same key, different body: `422 idempotency_key_reused`. A concurrent duplicate loses on the primary key, re-reads, and answers as a replay.
- Unique violations map to `email_taken` / `phone_taken`; both taken is `email_taken`.
- Limits: 5/hour per IP (in memory, `WindowLimiter`); 3/day per phone (counted in `signup_phone_attempts` by keyed phone hash, survives restarts). Replays do not count.

### 5. `POST /v1/auth/refresh`
- One transaction, `SELECT … FOR UPDATE` on the token row by hash:
  - not rotated: derive child, insert it, mark parent rotated, return the new pair;
  - rotated under 30 s ago: re-derive, look up the child row, re-sign, return the identical pair;
  - rotated longer ago: revoke the family, `401 session_revoked`;
  - family revoked: `session_revoked`; unknown, expired or malformed: `invalid_refresh_token`.
- Limit: 30/hour per family.
- Tests: concurrent refreshes; byte-identical grace reply; reuse at 31 s revokes the family and every descendant.

### 6. `GET /v1/me`, `POST /v1/auth/signout`, `requireUser`
- `requireUser`: verify token, then one indexed family lookup, giving `token_expired`, `invalid_token` or `session_revoked`. A deleted user is `session_revoked`.
- Sign-out accepts an expired access token with a valid signature; revokes the refresh token's family only when both belong to the same user; otherwise `204` and nothing changes.
- Limit: 120/minute per user.

### 7. Logs, purge, metrics
- Add `password`, `refreshToken`, `accessToken`, `fullName`, `email`, `phone` (any depth) and the `idempotency-key` header to `REDACT_PATHS`. A test asserts none of them reaches the log.
- Extend `src/jobs/purge.ts`: refresh tokens 7 days after expiry or revocation; revoked families with no tokens left; idempotency rows after 24 h; phone attempts after 24 h.
- Counters: sign-ups, refreshes (rotated, grace replay, reuse detected), sign-outs.

### 8. Isolation and docs
- Tests: a device token on `/v1/me` is `invalid_token`; an access token on `POST /v1/sos` is `unauthorized`; the whole existing suite passes with `AUTH_ENABLED` both on and off.
- Regenerate `docs/openapi.json` (auth routes tagged, their own bearer scheme). README and env example list the new settings. `app-api-contract.md` points to the auth contract.
- An end-to-end test walking every item of the contract's acceptance checklist.

## Out of scope

Sign-in (§6 of the contract; its building blocks exist, no route), account ↔ device link, account
deletion, password reset.
