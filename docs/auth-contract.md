# SOS Auth: API contract for the mobile app (demo)

This document is the contract between the SOS app and the auth backend for the demo. The app and the
backend are built against it at the same time. Until the backend is ready, the app runs against a mock
that implements this contract, so the backend must match it exactly. If a change is needed, change this
document first, and change the app and the backend together.

For the demo, **sign-up** and **sign-in** must work end to end. The app also uses refresh, sign-out and
`GET /v1/me` to keep the session alive. Sign-in ([section 6](#6-sign-in)) is how a user gets back into
their account after a session ends: there is no other way back, since signing up again with the same
email or phone is refused.

The demo app **sends no SOS**. It does not call the relay's SOS endpoints (`/v1/intake`, `/v1/devices/*`,
`/v1/sos`), which stay deployed and unchanged, as described in [`app-api-contract.md`](app-api-contract.md).
An account and a registered device are separate, with nothing linking them. The link is decided later,
together with sending an SOS from a signed-in app ([section 8](#8-not-in-the-demo)).

## Contents

1. [Basics](#1-basics)
2. [The error body](#2-the-error-body)
3. [Tokens and the session](#3-tokens-and-the-session)
4. [Endpoints](#4-endpoints)
   - [`POST /v1/auth/signup`](#41-post-v1authsignup)
   - [`POST /v1/auth/refresh`](#42-post-v1authrefresh)
   - [`POST /v1/auth/signout`](#43-post-v1authsignout)
   - [`GET /v1/me`](#44-get-v1me)
5. [Rate limits](#5-rate-limits)
6. [`POST /v1/auth/signin`](#6-sign-in)
7. [Acceptance checklist for the backend](#7-acceptance-checklist-for-the-backend)
8. [Not in the demo](#8-not-in-the-demo)

---

## 1. Basics

| Topic | Rule |
|---|---|
| Base URL | `EXPO_PUBLIC_AUTH_BASE_URL`, configured per build variant. All paths below are relative to it. Auth runs on the relay, so this is the same value as `EXPO_PUBLIC_RELAY_BASE_URL`. |
| TLS | HTTPS only. The host is the relay's, so pinning is the relay's: the app pins the SPKI of the Let's Encrypt roots ISRG Root X1 and X2. |
| Format | JSON in both directions. Requests send `Content-Type: application/json`, and responses use `application/json; charset=utf-8`. |
| Unknown fields | A request body that contains a field not listed here is refused with `400 validation_failed`. Responses may add new fields at any time, and the app ignores fields it does not know. |
| Body size | At most 16 384 bytes. A larger body gets `413 payload_too_large`. |
| Times | RFC 3339 in UTC, for example `2026-11-18T12:00:00Z`. |
| Ids | Strings, treated as opaque by the app. UUIDs are recommended. |
| Auth header | `Authorization: Bearer <accessToken>` on authenticated endpoints. The scheme is matched exactly as `Bearer` (capital B, one space). |
| Cookies | None. |
| Client timeout | The app gives up after 10 seconds. Every endpoint must answer within 8. |

---

## 2. The error body

Every response that is not 2xx has the same envelope as the relay's errors (`{ "error": { "code", "message", … } }`),
but the auth endpoints use **their own codes** and add `fields`. The relay's SOS endpoints keep their codes
(`invalid_request`, `unauthorized`, …) exactly as in [`app-api-contract.md`](app-api-contract.md). The app
reads the codes in this section only for the paths in this document.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields are invalid.",
    "retryAfterSeconds": 60,
    "fields": [{ "field": "phone", "code": "invalid_phone" }]
  }
}
```

| Field | Meaning |
|---|---|
| `code` | Required. A stable, machine-readable code from the tables below. The app switches on it. |
| `message` | Optional. English text for logs. The app never shows it to the user. |
| `retryAfterSeconds` | Present on `429` and, when known, on `503`. An integer of at least 1. |
| `fields` | Present only on `400 validation_failed`: one entry per invalid field. `field` is the request field name, and `code` is a field error code from [4.1](#field-error-codes). |

Codes every endpoint can return:

| Status | `code` | App behaviour |
|---|---|---|
| 400 | `validation_failed` | Shows the matching message next to each field in `fields`. |
| 400 | `malformed_request` | The body is not JSON or has the wrong types. Treated as a bug: shows "Something went wrong". |
| 413 | `payload_too_large` | Same as `malformed_request`. |
| 429 | `rate_limited` | Shows "Too many attempts, try again in N minutes". |
| 500 | `internal_error` | Shows "Something went wrong, try again". |
| 503 | `unavailable` | Shows "Service unavailable, try again shortly". |

---

## 3. Tokens and the session

The user stays signed in **until they sign out**. This uses a short-lived access token and a long-lived,
rotating refresh token.

| Token | Lifetime | Notes |
|---|---|---|
| `accessToken` | 15 minutes | Opaque to the app (it may be a JWT, but the app never decodes it). Sent as a Bearer token. |
| `refreshToken` | **90 days, sliding**: each successful refresh issues a new token with a fresh 90 days. There is no absolute maximum. | Opaque, at least 32 bytes of randomness. Single use (see rotation below). Store only a hash on the server. |

A user who opens the app at least once every 90 days therefore never has to sign in again.

### 3.1 The session object

Sign-up, refresh and sign-in all return this object:

```json
{
  "accessToken": "eyJhbGciOi...",
  "accessTokenExpiresAt": "2026-11-18T12:15:00Z",
  "refreshToken": "rt_9f2c0d7e4b8a4c1e9d3b6a5f2e1c0b9a8d7e6f5a",
  "refreshTokenExpiresAt": "2027-02-16T12:00:00Z"
}
```

### 3.2 Rotation and reuse

- Each call to `POST /v1/auth/refresh` **consumes** the refresh token it is given and returns a new pair.
- **Grace window:** if the same refresh token is presented again **within 30 seconds** of being rotated,
  return the **same** new pair that was already issued. This covers a request that succeeded on the
  server but whose response never reached the phone. Exactly 30 seconds still counts as within.
  A grace reply writes nothing and extends nothing.
- **Unless the new token has already been used.** If the token issued by that rotation has itself been
  refreshed, the response clearly reached a client, so presenting the old token again is reuse, even
  within 30 seconds: revoke the family and answer `401 session_revoked`.
- **Reuse after the grace window** is treated as theft. Revoke that token's whole family (every token
  descended from the same sign-up or sign-in) and answer `401 session_revoked`.
- The app makes **one refresh at a time** (single-flight), so concurrent refreshes from one install are
  not expected. If two arrive anyway, both get the same new pair.
- A revoked family wins over everything: its tokens answer `session_revoked`, even inside the grace
  window. An expired token answers `invalid_refresh_token` and never revokes its family.
- **Known consequence:** if a refresh response is lost and the app retries only after 30 seconds, the
  retry counts as reuse and the user has to sign up or sign in again. The app should retry a lost
  refresh promptly (it is single-flight, so this is the same request again, not a new one).
- **Known consequence:** whoever presents a token within 30 seconds of its rotation gets the live pair,
  including a thief racing the app. This is the price of the grace window.

### 3.3 When the app refreshes

- Before a request, if `accessTokenExpiresAt` is less than 60 seconds away.
- After any `401 token_expired` from an authenticated endpoint. The app refreshes once and retries the
  request once.
- At app start, if the access token has expired.

If the refresh fails with `401` (any code), the session is over. The app clears it and shows sign-in,
with a link to sign-up.
Network errors and `5xx` do **not** end the session: the app keeps the stored tokens and tries again later.
The demo backend answers an unexpected server failure, a database outage included, with
`500 internal_error`; it does not produce `503 unavailable` yet. The app treats both the same way.

---

## 4. Endpoints

### 4.1 `POST /v1/auth/signup`

Creates an account and returns a session, so the user is signed in at once.

**Headers**

| Header | Required | Notes |
|---|---|---|
| `Idempotency-Key` | Yes | A UUID v4 that the app generates once per sign-up form submission and reuses on every retry. If the same key arrives again within 24 hours with the **same body**, answer with the **original** response (same status, same user, a session for that user). The same key with a **different** body is answered with `422 idempotency_key_reused`. Only a `201` is remembered: a request that was refused (`400`, `409`, `429`) is evaluated afresh when it is retried. Keys are compared case-insensitively. A missing header is `400 validation_failed` with `{ "field": "Idempotency-Key", "code": "required" }`; a value that is not a UUID v4 has the code `invalid_value`. The header is checked before the body, and its error is returned on its own. |

**Body**

```json
{
  "fullName": "Ada Okafor",
  "phone": "+2348031234567",
  "email": "ada@example.com",
  "password": "correct horse battery staple",
  "device": { "platform": "android", "appVersion": "0.3.0", "installId": "5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b" }
}
```

| Field | Type | Rule |
|---|---|---|
| `fullName` | string | 1–100 characters after trimming. The server trims it. No control characters (`invalid_value`). |
| `phone` | string | E.164 (`^\+[1-9]\d{6,14}$`). The app has already normalised it with libphonenumber-js. |
| `email` | string | A valid address of at most 254 characters. The server trims it and lowercases it before checking uniqueness and storing it. |
| `password` | string | 8–128 characters. No composition rules. Hash with Argon2id or bcrypt (cost 12 or more). Never log it. |
| `device` | object | Required. `platform` is `"ios"` or `"android"`. `appVersion` is a string of at most 32 characters, with no control characters (`invalid_value`); it may be empty. `installId` is a UUID that the app generates once per install. It is stored with the session family, for support and for revoking a device's sessions. |

**Responses**

`201 Created`

```json
{
  "user": {
    "id": "0b6f3a4e-8d2c-4f1a-9e7b-5c3d2a1f0e9d",
    "fullName": "Ada Okafor",
    "phone": "+2348031234567",
    "email": "ada@example.com",
    "phoneVerified": false,
    "createdAt": "2026-11-18T12:00:00Z"
  },
  "session": { "accessToken": "…", "accessTokenExpiresAt": "…", "refreshToken": "…", "refreshTokenExpiresAt": "…" }
}
```

| Status | `code` | When | App behaviour |
|---|---|---|---|
| 400 | `validation_failed` | Any field breaks a rule in the table above. Return **every** invalid field, not only the first one. | Shows a message next to each field. |
| 409 | `email_taken` | The email (lowercased) already has an account. | Shows "An account with this email already exists" on the email field. |
| 409 | `phone_taken` | The phone number already has an account. | Shows "This phone number is already registered" on the phone field. |
| 422 | `idempotency_key_reused` | See the header table above. | Treated as a bug: the app generates a new key and asks the user to submit again. |
| 429 / 5xx | see [§2](#2-the-error-body) | | |

If both the email and the phone number are taken, answer `email_taken`.

**Known trade-off: account enumeration.** These two answers tell anyone whether an email or phone number
has an account. That is accepted for the demo, and the per-IP and per-phone limits in [§5](#5-rate-limits)
slow down bulk checking. Before a public release, decide whether to keep it or to move to a verify-first
flow that answers the same way in both cases.

<a id="field-error-codes"></a>**Field error codes** used in `fields[].code`:

| `code` | Fields |
|---|---|
| `required` | any. Means the field is absent. A field that is present but empty gets the field's own code (`too_short`, `invalid_phone`, …). |
| `too_short` | `fullName`, `password` (an empty string included) |
| `too_long` | `fullName`, `email`, `password`, `device.appVersion` |
| `invalid_phone` | `phone` |
| `invalid_email` | `email` |
| `invalid_value` | `device.platform`, `device.installId`; `fullName` and `device.appVersion` with a control character; any **unknown field** (for example `device.os`), listed after the known fields in the order sent, at most 16 of them; the `Idempotency-Key` header (see above); `refreshToken` that is not a string |

A wrong JSON type for a sign-up field (a number where a string is expected, `null`, `device` that is not
an object) or a body that is not a JSON object is `400 malformed_request`, not `validation_failed`. The
exception is `refreshToken` on refresh and sign-out: a missing token is `required` and a non-string one
is `invalid_value`, both under `validation_failed`.

### 4.2 `POST /v1/auth/refresh`

**Body:** `{ "refreshToken": "rt_…" }`

| Status | Body / `code` | When |
|---|---|---|
| 200 | `{ "session": { … } }` | The token is valid. It is rotated, or the grace window applies ([§3.2](#32-rotation-and-reuse)). |
| 400 | `validation_failed` | `refreshToken` is missing (`required`) or not a string (`invalid_value`). |
| 401 | `invalid_refresh_token` | The token is unknown, expired or malformed, including an empty string. |
| 401 | `session_revoked` | The token was reused (after the grace window, or after its successor was used: [§3.2](#32-rotation-and-reuse)), the family was revoked, or the user signed out. A token of a revoked family answers this even when it has also expired, until it is purged; after that it is `invalid_refresh_token`. Both end the session in the app. |

### 4.3 `POST /v1/auth/signout`

Revokes the refresh token family behind this session. The app calls it when the user signs out and
clears its local data whatever the result.

**Headers:** `Authorization: Bearer <accessToken>`. The endpoint also accepts an **expired** access
token, as long as its signature is valid, so that sign-out works after a long time offline.

**Body:** `{ "refreshToken": "rt_…" }`

What is revoked:

- The server finds the family of `refreshToken` and revokes it **only if** that family belongs to the
  same user as the access token. The family named in the access token does not have to match: if the
  app has mixed up its tokens, the refresh token's family is still the one revoked.
- If `refreshToken` is unknown, expired, already revoked, or belongs to another user, nothing is
  revoked and the answer is still `204`. The app cannot tell these cases apart, and it does not need to.

| Status | When |
|---|---|
| 204 | Revoked, already revoked, or nothing to revoke (see above). The endpoint is idempotent. |
| 400 `validation_failed` | `refreshToken` is missing (`required`) or not a string (`invalid_value`). |
| 400 `malformed_request` | The body is empty, not JSON, or not a JSON object. |
| 401 `invalid_token` | The access token is missing, malformed or forged. An expired access token is **not** a 401 here. |

The access token is checked first: a request with a bad token and a bad body gets the `401`.

### 4.4 `GET /v1/me`

Returns the signed-in user. The app calls it at start-up to confirm the session and to show the
user's name.

**Headers:** `Authorization: Bearer <accessToken>`

| Status | Body / `code` |
|---|---|
| 200 | `{ "user": { …same shape as sign-up… } }` |
| 401 `token_expired` | The access token has expired. The app refreshes and retries. |
| 401 `invalid_token` | The access token is missing, malformed or forged. The app ends the session. |
| 401 `session_revoked` | The session's family has been revoked. The app ends the session. |

---

## 5. Rate limits

| Endpoint | Limit | Key |
|---|---|---|
| `POST /v1/auth/signup` | 5 per hour | client IP |
| `POST /v1/auth/signup` | 3 per day | `phone` |
| `POST /v1/auth/signin` | 20 per hour | client IP |
| `POST /v1/auth/signin` | 10 per hour | `email` ([§6](#6-sign-in)) |
| `POST /v1/auth/refresh` | 30 per hour | refresh token family. Every request with a token of a known family counts, whatever the answer. An unknown token belongs to no family and is held back by the relay's per-IP limit instead. |
| `POST /v1/auth/signout` | 120 per minute | the access token's family, not the user, so a stale or revoked access token can never use up the budget of the user's live session |
| `GET /v1/me` (and later authenticated endpoints) | 120 per minute | user. Only requests whose token is accepted count. |
| every endpoint | the relay's per-IP limit (default 120 per minute) | client IP |

Sign-up limits count every request with a valid body that is not a replay, a `409` included (this is
what slows down checking which emails and phones have accounts). A `400`, a `422` and a request refused by
a limit do not count, and neither do idempotent replays ([4.1](#41-post-v1authsignup)), including a request
that only turns out to be a replay while it is being handled. The per-IP limit is checked before the
per-phone one. Every `429` includes `retryAfterSeconds`; for the per-phone limit it is the time until an
attempt leaves the 24-hour window.

The per-IP, per-family and per-user limits are kept in each relay instance's memory: with two instances
behind the edge they are effectively doubled, and a restart resets them. The per-phone limit is kept in
the database and holds across instances and restarts.

---

<a id="6-sign-in"></a>
## 6. Sign-in

`POST /v1/auth/signin`

**Body**

```json
{
  "email": "ada@example.com",
  "password": "correct horse battery staple",
  "device": { "platform": "android", "appVersion": "0.3.0", "installId": "5b0c1f7e-2a3d-4e8f-9c6b-1a2d3e4f5a6b" }
}
```

No `Idempotency-Key`: a retried sign-in simply creates another session, and the unused one expires.

| Field | Rule |
|---|---|
| `email` | Required string. Trimmed and lowercased before lookup. Its format is **not** checked: an address that cannot have an account just fails to sign in. |
| `password` | Required string. Its length is **not** checked against the sign-up rules, for the same reason. A password longer than 1 024 characters fails at once without being hashed. |
| `device` | Required, exactly as in sign-up. |

Unknown fields, missing fields and wrong JSON types are answered as in sign-up (`validation_failed` or
`malformed_request`, [§4.1](#field-error-codes)).

| Status | Body / `code` | When | App behaviour |
|---|---|---|---|
| 200 | `{ "user": {…}, "session": {…} }` | The email and password match. `user` has the same shape as in sign-up. The session is a **new** token family: other sessions of the same user are not affected. | Stores the session and shows the home screen. |
| 400 | `validation_failed` / `malformed_request` | See above. | As in sign-up. |
| 401 | `invalid_credentials` | The email has no account, or the password is wrong. The body is **identical** in both cases, and both take the same time (the server checks a password hash either way). | Shows "Email or password is incorrect". |
| 429 | `rate_limited` | See below. | Shows "Too many attempts, try again in N minutes". |

Rate limits: **20 per hour per client IP** and **10 per hour per email address**. Every attempt with a
valid body counts, successful or not. The per-IP limit is checked first. The per-email limit is kept in
the database (by a keyed hash of the address, never the address itself), so it holds across relay
instances and restarts, and it applies even when the email has no account. An attempt refused by a limit
is not counted, so waiting is enough: the next attempt works once the oldest counted one is an hour old.
The `message` of `invalid_credentials` is always "The email or password is not correct."

---

## 7. Acceptance checklist for the backend

- [ ] Sign-up with a valid body returns 201 with `user` and `session`, and the access token works on `GET /v1/me`.
- [ ] Sign-up with several invalid fields returns 400 and lists **all** of them in `fields`.
- [ ] A duplicate email returns 409 `email_taken`, including when it differs only in case (`ADA@example.com`).
- [ ] A duplicate phone number returns 409 `phone_taken`.
- [ ] A body with an unknown field returns 400 `validation_failed`.
- [ ] Replaying a sign-up with the same `Idempotency-Key` and body returns the original 201 and creates no second user.
- [ ] Refresh rotates the token, and the old token works again only within 30 s, returning the same pair.
- [ ] Reusing an old refresh token after 30 s returns 401 `session_revoked`, and its descendants stop working.
- [ ] Sign-out returns 204, works with an expired access token, and makes the refresh token fail with 401.
- [ ] An expired access token on `GET /v1/me` returns 401 `token_expired`, not `invalid_token`.
- [ ] Sign-in with the right email (in any case) and password returns 200 with a new session, and the other sessions keep working.
- [ ] Sign-in with an unknown email and with a wrong password returns the same 401 `invalid_credentials` body.
- [ ] The 11th sign-in for one email within an hour returns 429, even from different IPs.
- [ ] A user whose session ended (signed out, or revoked by reuse detection) can sign in again.
- [ ] Sign-out with a refresh token of another user returns 204 and that user's session keeps working.
- [ ] No password, token or full request body appears in the logs. The logger redacts at least
      `req.headers.authorization`, `password`, `refreshToken`, `accessToken`, `Idempotency-Key`, and the
      `fullName`, `phone` and `email` fields. A user is named in logs by `user.id` only.
- [ ] A `GET /v1/me` with a relay device token answers 401 `invalid_token`, and a `POST /v1/sos` with an
      access token answers 401 `unauthorized`: the two kinds of token are never accepted for each other.

---

## 8. Not in the demo

| Topic | Rule for now |
|---|---|
| Sending an SOS | The demo app sends none. The relay's SOS endpoints are unchanged and unused by the app. |
| Account ↔ device link | None. An access token says nothing about a device, and a device token says nothing about a user. When SOS returns to the app, both tokens are needed on `POST /v1/sos`, and they cannot both use `Authorization`. That change (a second header, or one token carrying both) is decided then, in both contracts at once. |
| Phone verification | Not built. `phoneVerified` is always `false`. |
| Data retention | Accounts are **not** purged automatically, unlike SOS data (deleted after 30 days). Expired and revoked refresh tokens are deleted 7 days after they expire or are revoked; sign-up idempotency records 24 hours after they are created; sign-in attempts after 1 hour. Every account created during the demo is deleted before a public release; this is an operator action. After it, the server answers `401 session_revoked` to that account's access tokens and `401 invalid_refresh_token` to its refresh tokens, so the app ends the session and shows sign-in. Signing in then fails with `invalid_credentials`, and signing up again is possible. |
| Deleting an account | No endpoint during the demo. A user who asks is removed by an operator. Needed before a store release (both stores require in-app account deletion). |
| Password reset | Not built. A user who forgets their password cannot get back in during the demo; an operator can delete the account so they can sign up again. |
