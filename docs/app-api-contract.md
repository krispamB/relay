# SOS Relay: API contract for the mobile app

This is the one document the app team needs to talk to the SOS Relay. It covers every endpoint the
app calls, what to send, every answer the relay can give, and what the app should do with each one.

It describes the relay as it is built. Every limit and number here is the one in the code; the
examples were captured from the running relay, not written by hand. Values that are random (ids,
tokens, nonces) will differ in your runs. If this document and the relay disagree, the relay is
right and this document has a bug: tell the relay team.

Two companion files:

- [`docs/attestation-contract.md`](attestation-contract.md): exactly how to produce the Play
  Integrity and App Attest values on each platform. This document does not repeat it.
- [`docs/openapi.json`](openapi.json): the machine-readable schema of the same endpoints (see
  [OpenAPI document](#openapi-document)), for generating a typed client.

## Contents

1. [The rules that matter most](#1-the-rules-that-matter-most)
2. [Basics: base URL, TLS, pinning, JSON](#2-basics)
3. [The error body](#3-the-error-body)
4. [Endpoints](#4-endpoints)
   - [`GET /v1/intake/:intakeCode`](#41-get-v1intakeintakecode)
   - [`GET /v1/devices/nonce`](#42-get-v1devicesnonce)
   - [`POST /v1/devices/register`](#43-post-v1devicesregister)
   - [`POST /v1/sos`](#44-post-v1sos)
   - [`GET /v1/sos/:receiptId/status`](#45-get-v1sosreceiptidstatus)
   - [OpenAPI document](#46-openapi-document)
5. [The attestation binding hash](#5-the-attestation-binding-hash)
6. [Device token: lifetime and renewal](#6-device-token-lifetime-and-renewal)
7. [The idempotency key, retries and the outbox](#7-the-idempotency-key-retries-and-the-outbox)
8. [Status polling and what each status means](#8-status-polling-and-what-each-status-means)
9. [Rate limits](#9-rate-limits)
10. [The demo intake](#10-the-demo-intake)
11. [What is deliberately not available](#11-what-is-deliberately-not-available)

---

## 1. The rules that matter most

- **A 503 from `POST /v1/sos` means "not sent, and never will be".** Show "Call {emergencyPhone}"
  at once and do not retry by yourself. The relay never delivers that SOS later.
- **A 202 means "saved, the relay is still delivering it".** The SOS is not at dispatch yet. Poll
  its status.
- **One `Idempotency-Key` per SOS, reused on every retry of that SOS.** That is what stops a retry
  from creating a second emergency call.
- **A fresh attestation for every attempt**, computed over the exact bytes you send.
- **A location older than 10 minutes is refused.** Retries from the outbox must refresh it
  ([section 7.3](#73-location-on-retry)).
- **Every error state shows the emergency phone number** from the intake.

---

## 2. Basics

| Topic | Rule |
|---|---|
| Base URL | Per build variant (`EXPO_PUBLIC_RELAY_BASE_URL`). All paths below are relative to it, for example `https://relay.example.org/v1/intake/LAGOS-FIRE`. |
| TLS | HTTPS only. No cleartext traffic. |
| Pinning | Pin the public keys (SPKI SHA-256) of the **Let's Encrypt roots ISRG Root X1 and ISRG Root X2**, one as primary and one as backup. Do **not** pin the relay's own certificate or key: the hosting platform renews it and its key changes, which would break every install. Take the pin values from Let's Encrypt's published root certificates. A pin failure is treated like "no network". |
| Format | JSON in both directions. Send `Content-Type: application/json` with every request body. Responses are `application/json; charset=utf-8`. |
| Cookies | None. The only credentials are the device token and the per-SOS status token. |
| Unknown fields | A request body with a field the relay does not know is refused with 400. Send only the fields listed here. |
| Body size | At most 16 384 bytes for every request body, except `POST /v1/devices/register`, which allows 98 304 bytes (96 KiB) for the iOS attestation object. A larger body gets 413. |
| Times | RFC 3339 / ISO 8601 in UTC, for example `2026-11-17T12:00:00Z`. |
| Answer time | `POST /v1/sos` answers within 8 seconds. Use a 10-second client timeout. |

---

## 3. The error body

Every response that is not 2xx has this shape:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 3600 } }
```

| Field | Meaning |
|---|---|
| `error.code` | Stable machine code. Branch on this and on the HTTP status, never on `message`. |
| `error.message` | Short English text for logs. Not meant for the caller's screen. |
| `error.retryAfterSeconds` | Present on every 429 and 503. An integer of at least 1. The same value is in the `Retry-After` header. |

The 409 from `POST /v1/sos` adds the open SOS's receipt fields next to `error` (see
[409](#409-an-sos-from-this-device-is-already-open)).

A 403 never says why, by design. Error bodies never contain personal data.

Error codes the app can see:

| HTTP | `code` | Where |
|---|---|---|
| 400 | `invalid_request` | Any endpoint: a body or header that does not match the schema, an unknown field, malformed JSON, a missing or wrong `Content-Type` (a content type the relay has no parser for gives **415** with the same code). |
| 400 | `invalid_nonce` | Register: the nonce is unknown, expired or already used. |
| 400 | `phone_invalid`, `address_too_long`, `name_too_long`, `details_too_long`, `address_required`, `location_invalid`, `nature_invalid`, `location_required` | SOS body checks ([4.4](#body)). |
| 401 | `unauthorized` | SOS: device token missing, unknown or expired. |
| 403 | `forbidden` | Register or SOS: attestation failed, or the device or phone number is blocked. No reason given. |
| 404 | `not_found` | Unknown intake; unknown route; on the status endpoint, any wrong receipt id or token. |
| 409 | `sos_already_open` | SOS: this device already has an open SOS. |
| 410 | `intake_disabled` | The intake exists but is switched off. |
| 413 | `invalid_request` | Body too large. |
| 415 | `invalid_request` | Unsupported `Content-Type`: a client bug. Send `application/json`. |
| 429 | `rate_limited` | A rate limit ([section 9](#9-rate-limits)). |
| 500 | `internal_error` | A relay bug. Treat like a network failure. |
| 503 | `unavailable` | SOS: the relay cannot deliver to dispatch right now. |
| 503 | `intake_busy` | SOS: the whole intake is receiving too many SOS at once. |

---

## 4. Endpoints

### 4.1 `GET /v1/intake/:intakeCode`

The department's public configuration: its name, its emergency number, the list of emergency types
("natures"), and whether it can take an SOS right now. No authentication.

**When:** when the app comes to the foreground (at most once per 5 minutes), and after switching
department. Cache the last good answer; ship a bundled copy for first launch.

**Path parameter:** `intakeCode`, the department's code, exactly as configured (case-sensitive).
Intake codes are 6 to 32 characters of `A-Z a-z 0-9 -`.

**Headers:** none required.

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 200 | The intake (below) | Use it: render the form, show `emergencyPhone`. If `available` is `false`, the SOS button should still be shown, but a send will get 503; show the call button prominently. |
| 404 | Error, `not_found` | Unknown code. Replace the SOS button with "This service is not available. Call {emergencyPhone}" (use the cached or bundled number). |
| 410 | Error, `intake_disabled` | Intake switched off. Same as 404. |
| 429 | Error, `rate_limited` | Keep the cached config; try again later. |

**200 body**

| Field | Type | Meaning |
|---|---|---|
| `intakeCode` | string | The code. |
| `displayName` | string | Department name to show. |
| `emergencyPhone` | string | The number for the "Call" button. Show it on every screen. |
| `natures` | array of `{ id: string, label: string }` | The emergency types. Send the `id` as `nature`; show the `label`. At least one. |
| `requireVerifiedPhone` | boolean | Always `false` in this version ([section 11](#11-what-is-deliberately-not-available)). |
| `available` | boolean | `false` while the relay cannot deliver an SOS for this intake (delivery paused, configuration problem, or Core not yet checked). An SOS sent now gets 503. Always `true` for the demo intake. |
| `demo` | boolean | `true` for the demo intake ([section 10](#10-the-demo-intake)). |
| `required.location` | boolean | `true` when every SOS must carry a usable location: an address alone is then not enough (400 `location_required`). |
| `required.address` | boolean | Always `false`: the relay fills in a placeholder when needed. |
| `required.name` | boolean | Always `false`: the relay fills in a placeholder when needed. |

**Example**

```http
GET /v1/intake/LAGOS-FIRE
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "intakeCode": "LAGOS-FIRE",
  "displayName": "Lagos Fire Service",
  "emergencyPhone": "112",
  "natures": [
    { "id": "medical", "label": "Medical emergency" },
    { "id": "fire", "label": "Fire" }
  ],
  "requireVerifiedPhone": false,
  "available": true,
  "demo": false,
  "required": { "location": false, "address": false, "name": false }
}
```

```http
HTTP/1.1 410 Gone

{ "error": { "code": "intake_disabled", "message": "This service is not available." } }
```

---

### 4.2 `GET /v1/devices/nonce`

A single-use challenge for device registration. No authentication.

**When:** immediately before `POST /v1/devices/register`. Get a new one for every registration
attempt, including after a failed one.

**Headers:** none required.

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 200 | `{ nonce, expiresAt }` | Use the nonce, as-is, within 5 minutes, once. |
| 429 | Error, `rate_limited` | Wait `retryAfterSeconds`, then try again. If an SOS is waiting on this, show the call button. |

| Field | Type | Meaning |
|---|---|---|
| `nonce` | string, 43 characters of URL-safe base64 without padding (`A-Z a-z 0-9 - _`) | Pass it unchanged to Play Integrity / App Attest and to register. |
| `expiresAt` | date-time | 5 minutes after issue. |

**Example**

```http
GET /v1/devices/nonce
```

```http
HTTP/1.1 200 OK

{ "nonce": "3m0GAMslRGXdXAxmZA37O5NhUYeKnPFD_siNyG41coI", "expiresAt": "2026-11-17T12:05:00.000Z" }
```

---

### 4.3 `POST /v1/devices/register`

Proves the app is a genuine install and returns the device token used to send an SOS. Also used to
renew the token ([section 6](#6-device-token-lifetime-and-renewal)).

**When:** silently in the background on first launch; again when the token is within 3 days of
expiry; and inline before sending if there is no valid token.

**Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `Authorization` | for renewal only | `Bearer <current deviceToken>`, even if it has expired. Keeps the same `deviceId`. Leave it out on first registration. |

**Body: Android**

| Field | Type | Rules |
|---|---|---|
| `platform` | `"android"` | Required. |
| `nonce` | string | Required. The nonce from 4.2, as-is (43 characters, `A-Z a-z 0-9 - _`). |
| `attestation.integrityToken` | string, 1 to 16 384 characters | The token from a **classic** Play Integrity request made with the nonce, as-is. Required by a production relay. |

**Body: iOS**

| Field | Type | Rules |
|---|---|---|
| `platform` | `"ios"` | Required. |
| `nonce` | string | Required, as above. |
| `attestation.keyId` | string, 1 to 128 characters | The App Attest key id from `generateKey()`, standard base64. |
| `attestation.attestationObject` | string, 1 to 87 384 characters (64 KiB decoded) | `attestKey(keyId, clientDataHash: SHA-256(UTF-8(nonce)))`, standard base64. |

`attestation` is required by a production relay (`enforce` mode). It may be left out only against a
development or staging relay in `permissive` mode, which is what simulators use. The exact
platform calls are in [`docs/attestation-contract.md`](attestation-contract.md).

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 201 | `{ deviceId, deviceToken, expiresAt }` | Store all three in secure storage, replacing any old token at once: after a renewal the old token stops working immediately. |
| 400 | Error, `invalid_nonce` | The nonce was unknown, expired or already used. Get a new nonce and a new attestation, and try once more. |
| 400 | Error, `invalid_request` | Malformed body (wrong `platform`, bad nonce format, unknown field). A client bug. Log the code. |
| 403 | Error, `forbidden` | Attestation failed, the device is blocked, or a renewal was refused. Do not loop. If an SOS is waiting on this, show "This phone can't send an SOS from the app. Call {emergencyPhone}." Try registration again later (for example on the next app start). |
| 413 | Error, `invalid_request` | Body too large: a client bug. |
| 429 | Error, `rate_limited` | Too many registrations from this network (10 per hour by default). Wait `retryAfterSeconds`. Show the call button if an SOS is waiting. |

| Field | Type | Meaning |
|---|---|---|
| `deviceId` | string, `dev_` + 26 characters | The device's identity. Show it in Settings as the "device reference" for support. Not a credential. |
| `deviceToken` | string | Opaque secret. Send as `Authorization: Bearer` on `POST /v1/sos`. Never log it. |
| `expiresAt` | date-time | 30 days after issue. |

**Example: first registration (permissive relay, so no attestation)**

```http
POST /v1/devices/register
Content-Type: application/json

{"platform":"android","nonce":"3m0GAMslRGXdXAxmZA37O5NhUYeKnPFD_siNyG41coI"}
```

```http
HTTP/1.1 201 Created

{
  "deviceId": "dev_01M7MP1NG06DXCDEY9GM7WNNW8",
  "deviceToken": "ER7FSTG5QUloU82mlmoqV-xScoSEVk8_9fl9zt4Qch4",
  "expiresAt": "2026-12-17T12:00:00.000Z"
}
```

**Example: renewal** (with a new nonce, and `Authorization: Bearer ER7FSTG5…` from above). The
`deviceId` is unchanged; the token is new:

```http
HTTP/1.1 201 Created

{
  "deviceId": "dev_01M7MP1NG06DXCDEY9GM7WNNW8",
  "deviceToken": "hwPISMTJho5zG47egPltSbsUoKUYy3Wze9u1ovC4WhY",
  "expiresAt": "2026-12-17T12:00:00.000Z"
}
```

Against a production relay, add the attestation object:
`{"platform":"android","nonce":"…","attestation":{"integrityToken":"…"}}` or
`{"platform":"ios","nonce":"…","attestation":{"keyId":"…","attestationObject":"…"}}`.

---

### 4.4 `POST /v1/sos`

Sends an SOS. The relay saves it and tries to create a pending call for the department's
dispatchers before answering.

**When:** when the caller presses Send, and for each retry from the outbox ([section 7](#7-the-idempotency-key-retries-and-the-outbox)).

**Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `Authorization` | yes | `Bearer <deviceToken>` |
| `Idempotency-Key` | yes | A UUID (for example a v4 UUID, `8-4-4-4-12` hex digits). **One per SOS, the same string on every retry of it.** |
| `X-Attestation` | yes on a production relay | Fresh for every attempt, at most 16 384 characters. Android: a **standard** Play Integrity token whose `requestHash` is `hex(h)`, as-is. iOS: an App Attest assertion over `h`, standard base64. `h` is defined in [section 5](#5-the-attestation-binding-hash). |

#### Body

| Field | Type | Rules |
|---|---|---|
| `intakeCode` | string, 1 to 64 characters | Required. The department's code. |
| `nature` | string, 1 to 40 characters | Required. One of the intake's `natures[].id`. Otherwise 400 `nature_invalid`. |
| `phone` | string | Required. The callback number in **E.164**: `+`, country code, number, 2 to 15 digits in all, no spaces (pattern `^\+[1-9][0-9]{1,14}$`). It must also be a valid number per `libphonenumber-js`; otherwise 400 `phone_invalid`. Convert what the caller typed to E.164 in the app. |
| `location` | object | Optional. See below. |
| `location.lat` | number | Required in `location`. Degrees, -90 to 90. |
| `location.lon` | number | Required in `location`. Degrees, -180 to 180. |
| `location.accuracyM` | number | Optional. Horizontal accuracy in metres. A negative value is ignored. |
| `location.capturedAt` | date-time string | Required in `location`. **The fix's own timestamp**, never the time of sending. At most 10 minutes old when it reaches the relay, and not more than 30 seconds in the future. |
| `location.source` | `"gps"`, `"network"` or `"last_known"` | Required in `location`. |
| `address` | string | Optional. Address or landmark, up to 500 characters. Required when there is no usable location. |
| `name` | string | Optional. Caller's name, up to 100 characters. |
| `details` | string | Optional. Free text, up to 1000 characters. |

How the relay treats the text and the location:

- **Text** (`address`, `name`, `details`) is cleaned: control characters removed, runs of
  whitespace collapsed to one space, trimmed. Lengths are counted after cleaning, in characters
  (Unicode code points: an emoji counts as one). A field that is empty after cleaning counts as not
  sent. Over the limit is a 400 (`address_too_long`, `name_too_long`, `details_too_long`). Send text as
  typed; enforce the limits in the form.
- **Location** is unusable when `lat`/`lon` are out of range, exactly `0,0`, `capturedAt` cannot be
  parsed, it is more than 10 minutes old, or more than 30 seconds in the future. An unusable location
  is **silently dropped when an `address` is present**, and is a **400 when there is no address**
  (`location_invalid`).
- No location and no address: 400 `address_required`.
- If the intake says `required.location: true`, an SOS without a usable location is a 400
  `location_required`, even with an address.
- Any other field: 400 `invalid_request`.

#### Order of checks

The relay checks in this order and stops at the first failure. It explains which answer wins when
several apply:

1. Device token valid, else **401**.
2. Device not blocked, else **403**.
3. Headers and body valid (schema, phone, text lengths, location-or-address), else **400**.
4. Attestation valid, else **403**.
5. Intake known, else **404**; enabled, else **410**.
6. Same device and same `Idempotency-Key` seen before: answer with **that SOS's current state**
   (a replay; nothing is sent again, and the body is not compared).
7. This device already has an open SOS: **409**.
8. Nature, location freshness, `required.location`: else **400**.
9. Phone number not blocked, else **403**.
10. Rate limits: **429**, or **503** `intake_busy`.
11. Relay able to deliver, else **503** `unavailable`.
12. Saved, then one delivery attempt: **201**, **202** or **503** (below).

Because a replay (step 6) is answered before steps 8 to 11, a retry of an SOS the relay already
accepted always gets its receipt back, even while the relay is paused or the location has gone stale.

#### Responses

| HTTP | Body `status` | Meaning | What the app does |
|---|---|---|---|
| **201** | `received` | Dispatch has the SOS as a pending call. | Store `receiptId`, `statusToken`, `reference`. Status screen "Received". Poll. |
| **201** | `failed` | Not delivered, and will not be. Either dispatch's system rejected it, or this is a replay of an SOS that was answered 503. | Store the receipt. Status screen "NOT DELIVERED", call button primary. Do not retry. |
| **201** | `dispatched` or `closed` | Only on a replay: the SOS was accepted earlier and has moved on. | Store the receipt and show that status. |
| **202** | `queued` | Saved. The relay could not reach dispatch's system yet and keeps trying for up to 30 minutes. | Store the receipt. "Sent, waiting to reach dispatch". Poll. Also returned by a replay of an SOS still queued. |
| **400** | error | The request is wrong (see the codes above). Should not happen with a correct client. | "Could not send. Call {emergencyPhone}." Log `error.code`. Do not retry. |
| **401** | error `unauthorized` | Device token missing, unknown or expired. | Renew the device ([4.3](#43-post-v1devicesregister)) once, then retry **with the same `Idempotency-Key`**. If that fails, show the call button. |
| **403** | error `forbidden` | Attestation failed, or the device or phone number is blocked. | "This phone can't send an SOS from the app. Call {emergencyPhone}." Do not retry. Do not say why. |
| **404** | error `not_found` | Unknown intake. | "Service not available" state. |
| **409** | error `sos_already_open` + receipt | This device already has an open SOS. | Store the returned receipt and show **its** status. See below. |
| **410** | error `intake_disabled` | Intake switched off. | "Service not available" state. |
| **413** | error `invalid_request` | Body too large. | As 400. |
| **429** | error `rate_limited` | A per-device, per-phone or per-network limit. | "Could not send now. Call {emergencyPhone}." Respect `retryAfterSeconds`. Do not auto-retry. |
| **503** | error `unavailable` or `intake_busy` | **Not sent.** The relay cannot deliver right now: delivery is paused, the department's system refused the relay's credentials during this very request, or the intake is overloaded. | "Not sent. Call {emergencyPhone}" at once, call button primary. **Do not auto-retry**, and do not put it in the outbox. The relay will never deliver this SOS later. |
| **500**, timeout, no network, pin failure | – | The answer is unknown: the SOS may or may not have been saved. | Put the SOS in the outbox ([section 7](#7-the-idempotency-key-retries-and-the-outbox)) and retry with the same key. |

About the 503: sometimes the relay has already saved the SOS when it finds it cannot deliver it. It
then marks it `failed` before answering, so nothing can contradict the 503: a replay with the same
key returns 201 `failed`, and the device is free to send a new SOS (it gets no 409). The 503 body
carries no receipt.

**Success, replay and 409 body (the receipt)**

| Field | Type | Meaning |
|---|---|---|
| `receiptId` | string, `sos_` + 26 characters | The SOS's id. Used in the status URL. |
| `statusToken` | string | The secret for the status endpoint (`X-Status-Token`). Store it securely; never log it. |
| `reference` | string, `SOS-` + 4 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` | The code the caller quotes on the phone. Show it large. |
| `status` | `queued`, `received`, `dispatched`, `closed` or `failed` | Current status ([section 8](#8-status-polling-and-what-each-status-means)). |
| `submittedAt` | date-time, to the second | When the relay accepted it. |

A retry that lost its first answer (timeout) gets the same `receiptId` and `statusToken` back: the
retry is how the app recovers them.

##### 409: an SOS from this device is already open

A device may have one open SOS at a time (status `queued`, `received` or `dispatched`), counted
separately for real and demo intakes. The 409 carries the open SOS's receipt next to the error, so
the app can show it. The app's own UI should make this unreachable: while an SOS is open, the home
screen shows its status card instead of the SOS button. Once it is `closed` or `failed`, the device
can send again.

**Example: a successful SOS**

```http
POST /v1/sos
Content-Type: application/json
Authorization: Bearer <deviceToken>
Idempotency-Key: 90c85a55-64d7-4d66-818c-da8939ab253b
X-Attestation: <fresh token or assertion over h>

{"intakeCode":"LAGOS-FIRE","nature":"fire","phone":"+2348012345678","location":{"lat":6.524417,"lon":3.379206,"accuracyM":12,"capturedAt":"2026-11-17T11:59:52.000Z","source":"gps"},"address":"12 Marina Road","name":"Ada","details":"Smoke from the generator shed"}
```

For exactly these key and body bytes, `h` in hex is
`850381fe6ec0dc8e76aa8aa8aee16d83ada4fdc9d043de99675f5138181bcf8f`.

```http
HTTP/1.1 201 Created

{
  "receiptId": "sos_01M7MP1NG0T7GGZBMN90N7V7EF",
  "statusToken": "IJwTN9hhSpCoeFM7DxmBRXlySHhqmGpyS00oszOwOhA",
  "reference": "SOS-A9TD",
  "status": "received",
  "submittedAt": "2026-11-17T12:00:00Z"
}
```

**202 queued** (the department's system did not answer in time):

```http
HTTP/1.1 202 Accepted

{
  "receiptId": "sos_01M7MP1NG06ZANXK4HFVK9TRG6",
  "statusToken": "ichjjHp_KtuBeOcP9xVu1QKHeQt6tu9govhfXV9u9x4",
  "reference": "SOS-UWSE",
  "status": "queued",
  "submittedAt": "2026-11-17T12:00:00Z"
}
```

**201 failed** (rejected by the department's system):

```http
HTTP/1.1 201 Created

{
  "receiptId": "sos_01M7MP1NG0PE7CG2WB78W3DPYR",
  "statusToken": "FZMCWpZbk7efbil8d9aLzHS9BZDDbDjUjStrO1h1uNI",
  "reference": "SOS-TBZB",
  "status": "failed",
  "submittedAt": "2026-11-17T12:00:00Z"
}
```

**409** (a second, different SOS from the same device while the first is open):

```http
HTTP/1.1 409 Conflict

{
  "error": { "code": "sos_already_open", "message": "An SOS from this device is already open." },
  "receiptId": "sos_01M7MP1NG0T7GGZBMN90N7V7EF",
  "statusToken": "IJwTN9hhSpCoeFM7DxmBRXlySHhqmGpyS00oszOwOhA",
  "reference": "SOS-A9TD",
  "status": "received",
  "submittedAt": "2026-11-17T12:00:00Z"
}
```

**503** (here: the department's system refused the relay's credentials during this request):

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 60

{ "error": { "code": "unavailable", "message": "This service cannot take an SOS right now.", "retryAfterSeconds": 60 } }
```

A replay of that request with the same key then returns `201` with `"status": "failed"`. The
whole-intake overload gives `{"error":{"code":"intake_busy",…,"retryAfterSeconds":600}}` with the
default limits.

**429** (the per-device limit):

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 86400

{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 86400 } }
```

**400** examples:

```json
{ "error": { "code": "location_invalid", "message": "The location is not usable and no address was given." } }
{ "error": { "code": "address_required", "message": "An address is required when there is no location." } }
{ "error": { "code": "phone_invalid", "message": "The phone number is not valid." } }
{ "error": { "code": "invalid_request", "message": "The request is not valid." } }
```

**401**:

```json
{ "error": { "code": "unauthorized", "message": "Device token is missing, invalid or expired." } }
```

---

### 4.5 `GET /v1/sos/:receiptId/status`

The current status of one SOS. No device token: the status token proves the caller may read it.

**When:** every 15 seconds while the app is in the foreground and the status is `queued`,
`received` or `dispatched` ([section 8](#8-status-polling-and-what-each-status-means)).

**Path parameter:** `receiptId` from the receipt.

**Headers**

| Header | Required | Value |
|---|---|---|
| `X-Status-Token` | yes | The `statusToken` from the receipt. |

**Responses**

| HTTP | Body | What the app does |
|---|---|---|
| 200 | `{ status, reference, updatedAt }` | Update the Status screen. Stop polling at `closed` or `failed`. |
| 404 | Error, `not_found` | Wrong or missing token, malformed or unknown receipt id. All look the same on purpose. Also returned once the SOS has been deleted (30 days after it was sent). Stop polling; dismiss the stored SOS. |
| 429 | Error, `rate_limited` | Polled faster than once per 5 seconds for this receipt. Wait `retryAfterSeconds`. |

| Field | Type | Meaning |
|---|---|---|
| `status` | `queued`, `received`, `dispatched`, `closed`, `failed` | See [section 8](#8-status-polling-and-what-each-status-means). |
| `reference` | string | Same as in the receipt. |
| `updatedAt` | date-time, with milliseconds | When the status last changed. |

**Example**

```http
GET /v1/sos/sos_01M7MP1NG0T7GGZBMN90N7V7EF/status
X-Status-Token: IJwTN9hhSpCoeFM7DxmBRXlySHhqmGpyS00oszOwOhA
```

```http
HTTP/1.1 200 OK

{ "status": "received", "reference": "SOS-A9TD", "updatedAt": "2026-11-17T12:00:00.000Z" }
```

Polled again at once:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 5

{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 5 } }
```

---

### 4.6 OpenAPI document

`GET /v1/openapi.json` returns the OpenAPI 3.0 document for the endpoints above. The same document is
committed as [`docs/openapi.json`](openapi.json) and a test keeps the two identical. Use it to
generate request and response types. It lists the main statuses of each endpoint; this document is
the complete list (413, 500 and the per-network 429 can come from any endpoint).

---

## 5. The attestation binding hash

Every `POST /v1/sos` carries a fresh attestation bound to this exact request:

```
h = SHA-256( UTF-8(Idempotency-Key) || 0x0A || raw request body bytes )
```

- `Idempotency-Key` is the header value exactly as sent (same case).
- `0x0A` is one newline byte.
- The body is **the exact bytes sent on the wire**. Serialise the JSON once, hash those bytes, send
  those same bytes. Do not re-serialise in between.
- Android: `requestHash` = `h` as 64 lowercase hex characters. iOS: `clientDataHash` = the 32 raw
  bytes of `h` (do not hash again).

Test vector:

```
Idempotency-Key: 5b0c3f2e-8a51-4f3c-9d7e-0a1b2c3d4e5f
Body:            {"intakeCode":"demo","nature":"fire","phone":"+15550100"}
h (hex):         9f8748b95a13312d8a6aba78e9528fd33e543e4a148608067b8462a01aadfeb8
```

Every attempt, including every retry, needs a new attestation over that attempt's bytes: an iOS
assertion counter must increase, and a Play Integrity token must be under 5 minutes old and is good
for one use. The platform details are in [`docs/attestation-contract.md`](attestation-contract.md).

---

## 6. Device token: lifetime and renewal

- A device token is valid for **30 days** (`expiresAt`).
- **Renew** in the background when it is within 3 days of expiry: get a nonce, then
  `POST /v1/devices/register` with a fresh attestation **and** `Authorization: Bearer <current
  token>`. The relay keeps the same `deviceId`, so limits and history carry over. The old token stops
  working the moment the new one is issued, so store the new one before using it.
- An **expired** token can still be used to renew. A device whose token has been expired for more
  than 30 days is deleted by the relay; renewing with its token then simply creates a new device.
- Without a token, registration creates a new device.
- On iOS, a renewal attests a **new** App Attest key; keep using the key from the latest
  registration for assertions.
- If `POST /v1/sos` answers 401, renew once and retry with the same `Idempotency-Key`.

---

## 7. The idempotency key, retries and the outbox

### 7.1 One key per SOS

Generate one UUID when the caller presses Send, and use that exact string for every attempt of that
SOS. The relay treats a second request with the same device and key as a **replay**: it sends
nothing to dispatch again and answers with that SOS's current state (201 or 202). This makes every
retry safe, including after a timeout where the first attempt did reach the relay. A new SOS gets a
new key.

### 7.2 When to retry

| Outcome | Retry? |
|---|---|
| Timeout, no network, pin failure, 500 | Yes: outbox, same key. |
| 401 | Once, after renewing the device token, same key. |
| 400, 403, 404, 409, 410, 413, 429, 503 | No. |
| 201, 202 | No. Poll the status instead. |

Outbox schedule (from the app PRD): immediately when connectivity returns, otherwise after 5 s,
15 s, 30 s, then every 30 s, for up to **30 minutes** from the first attempt, while the app is in the
foreground. After 30 minutes, stop and show "NOT DELIVERED". The relay itself also gives up on a
`queued` SOS 30 minutes after accepting it.

### 7.3 Location on retry

The relay refuses a location fix older than **10 minutes** for an SOS it has not yet accepted. An
outbox retry can be that late, so every attempt rebuilds its body:

1. If the saved fix's `capturedAt` is more than **8 minutes** old, take a new fix (foreground, wait up
   to 5 seconds) and put it in `location`.
2. If no fresh fix is available:
   - with an address, send the attempt **without** `location`;
   - without an address, show the Address / landmark field on the "NOT SENT YET" screen and wait for
     the caller to fill it in, or for a fix, before the next attempt;
   - if the intake has `required.location: true`, an address is not enough: keep trying for a fix
     until the 30 minutes are up.
3. Serialise the body, compute `h` over the new bytes, get a fresh attestation, and send with the
   **same** `Idempotency-Key`.

This is allowed: the relay matches a retry by its key alone and never compares bodies. If the first
attempt had in fact reached the relay, the retry is a replay and its new body is ignored. So the
outbox stores the key, the form fields, the fix and the time of the first attempt, not the serialised
request.

---

## 8. Status polling and what each status means

Poll `GET /v1/sos/:receiptId/status` every **15 seconds** while the app is in the foreground and the
status is `queued`, `received` or `dispatched`. Never faster than once per 5 seconds (429). Stop at
`closed` or `failed`; resume when the app returns to the foreground.

| Status | Meaning | Final? |
|---|---|---|
| `queued` | Saved by the relay, not yet at dispatch. The relay keeps trying for up to 30 minutes, then it becomes `failed`. | No |
| `received` | Dispatch has it as a pending call. A dispatcher has not acted on it yet. Never word this as "help is coming". | No |
| `dispatched` | A dispatcher has acted on the call. | No |
| `closed` | The call was closed. Also set 24 hours after sending if it was still open, since the relay stops tracking the call then. | Practically: in the rare case a dispatcher re-opens the call within those 24 hours, it goes back to `received` or `dispatched`. |
| `failed` | Not delivered to dispatch, and never will be. | Yes |

Only `queued`, `received` and `dispatched` count as "open" for the one-open-SOS rule. Status changes
reach the relay within about 15 seconds of the dispatcher acting (60 seconds once `dispatched`).

---

## 9. Rate limits

Defaults (a deployment may change them). `retryAfterSeconds` always says how long to wait.

| Limit | Default | Answer |
|---|---|---|
| SOS per device | 3 per 24 hours | 429 |
| SOS per phone number | 3 per 24 hours | 429 |
| SOS per network address | 10 per hour | 429 |
| Device registrations per network address | 10 per hour | 429 |
| Whole intake | 30 SOS per 10 minutes | 503 `intake_busy` |
| Status polls per receipt | 1 per 5 seconds | 429 |
| Any request per network address | 120 per minute | 429 |

- The SOS limits count SOS the relay accepted, including ones that later failed. Refused requests and
  replays do not count.
- The 409 check runs before the limits, and a replay is answered before both.
- The demo intake has its own counters.

---

## 10. The demo intake

A department may configure a **demo intake** (`demo: true` in the intake config) on the production
relay, for app-store reviewers and smoke tests:

- Everything runs as normal (registration, attestation, validation, limits, idempotency, receipt),
  but the SOS **never reaches real dispatchers**.
- `POST /v1/sos` answers `201 received` at once. The status then moves to `dispatched` after 30
  seconds and `closed` after 90 seconds (defaults).
- `available` is always `true` and `required.location` always `false` for it.
- A demo SOS and a real SOS do not block each other (separate one-open-SOS rule and limits).

Put the demo intake code in the store review notes as a deep link.

---

## 11. What is deliberately not available

| Not available | Instead |
|---|---|
| Phone number verification (SMS) | Not built. `requireVerifiedPhone` is always `false`, and the `verify-phone` routes return 404. Dispatchers are told the number is unverified. |
| Cancelling an SOS | No endpoint. If sent by mistake, the caller should phone the emergency number. |
| Editing an SOS | No endpoint. A retry with the same key never changes a saved SOS. |
| Push notifications | None. Poll while the app is open. |
| Any Resgrid field (priority, call type, …) | Never send them: unknown fields are a 400. |
| History of past SOS | The relay deletes every SOS 30 days after it was sent; its status then returns 404. |
