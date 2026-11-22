# PRD: Public SOS Mobile App

| | |
|---|---|
| **Status** | Draft v1 |
| **Date** | 2026-11-16 |
| **Component** | `sos-app`: React Native / Expo app for Android and iOS |
| **Depends on** | SOS Relay public API `/v1` (see `sos-relay-PRD.md`) |
| **Does not depend on** | Resgrid Core directly. The app never talks to Core and holds no Resgrid credential. |

---

## 1. Summary

A member of the public downloads the app, opens it, presses a big red button, answers a very short form, and an SOS reaches the department's dispatchers as a pending call.

**There is no login, no account, and no setup step.** The first SOS must be possible within a minute of installing the app.

The app talks only to the SOS Relay. The relay verifies that the request comes from a genuine install, applies abuse limits, and creates the pending call in Resgrid. The app then shows the caller a simple status: received, help dispatched, closed.

---

## 2. Goals and non-goals

### Goals
- G1. **No login.** No account, password, email, or sign-up. The app never asks the caller to identify themselves beyond a callback phone number on the SOS form.
- G2. **Fast.** A first-time user can send an SOS in 60 seconds or less from first launch. A returning user can send one in 15 seconds or less and at most 3 taps (button → nature → Send).
- G3. **Location without typing.** The app sends GPS coordinates automatically. A typed address is the fallback, not the default.
- G4. **Never leave the caller guessing.** Every state says plainly whether the SOS was sent, and a "Call {emergencyPhone}" button is visible on every screen.
- G5. **No secrets in the app.** The binary holds no API key. Everything in it may be public.
- G6. **Works on bad networks.** An SOS that can't be sent is kept and retried, and the caller is told it has not been sent yet.

### Non-goals (v1)
- Accounts, profiles, or login of any kind.
- Editing or cancelling an SOS after it is sent. The relay has no endpoint for either.
- Chat with the dispatcher, photo, audio or video upload.
- Push notifications. Status is polled while the app is open.
- Background or continuous location tracking. Location is read once per SOS, while the app is in use.
- Sending an SOS by SMS when there is no data connection (see §14).
- Picking the department by GPS. The department comes from the intake code (§5).
- Tablet-specific layouts, web build, wearables, home-screen widgets.
- Replacing 112/911 or any national emergency number.

---

## 3. Users

| User | Description |
|---|---|
| **Caller** | Member of the public, possibly panicking, injured, in the dark, or with one hand free. May have poor literacy, an old phone, or a weak connection. |
| **Dispatcher** | Never uses this app. Sees the result as a `[PUBLIC SOS]` pending call in Resgrid. |
| **App store reviewer** | Will press the button during review. Must not reach real dispatchers (§12.3). |

---

## 4. What "no login" means in practice

The app still needs three things from the relay's design. None of them may feel like a login.

| Need | How the app handles it | What the caller sees |
|---|---|---|
| **Device registration** (relay §7.2) | Done silently in the background on first launch, using Play Integrity / App Attest. Repeated silently when the 30-day device token expires. If it hasn't finished when the caller presses Send, it runs inline as part of sending. | Nothing. |
| **Department** (relay §6) | A default intake code is built into the app (§5). | Nothing, unless they choose to change it in Settings. |
| **Callback phone number** (required by relay §7.4) | One field on the SOS form. Saved on the device after the first SOS and pre-filled next time. | One field, once. |

Phone verification by SMS (relay §7.3) is **off** for v1. If a department turns on `requireVerifiedPhone`, the app shows a one-time verification step in Settings and on first launch, never in the middle of an SOS. If the caller reaches Send without a verified number in such a department, the app shows the emergency phone number instead of blocking silently.

---

## 5. Department selection

- Each build carries a **default intake code** (`EXPO_PUBLIC_DEFAULT_INTAKE_CODE`). The code is public by design, so shipping it is safe. This is what makes "download and send" work with no setup.
- The app also ships a **bundled copy of that intake's public config** (display name, emergency phone, nature list), so the form renders on first launch even with no network. The live config from `GET /v1/intake/:intakeCode` replaces it when fetched, and is cached on the device and refreshed on each app foreground (at most once per 5 minutes).
- **Optional override:** a deep link `sosapp://intake/{code}` (and a matching https universal link), or scanning a QR code from Settings, switches the app to another department. The app fetches the new config and asks the caller to confirm the department name before switching.
- If the relay returns 410 (intake disabled) or 404, the home screen replaces the SOS button with "This service is not available. Call {emergencyPhone}."

---

## 6. Screens and flows

### 6.1 First launch
One screen, shown once:
- What the app does, in one sentence, and which department receives the SOS.
- "This app does not replace calling {emergencyPhone}. If you can call, call."
- Link to the privacy notice.
- One button: **Continue**. It triggers the OS location permission prompt ("while using the app").

Declining location does not block the app. The caller lands on Home either way. Device registration starts in the background as soon as the app opens.

### 6.2 Home
- Department name at the top.
- **Big red SOS button**, at least 50 % of screen width, in the thumb zone.
- Secondary button: **Call {emergencyPhone}** (opens the phone dialler).
- If an SOS is open (`queued`, `received`, `dispatched`) or waiting in the outbox, the SOS button is replaced by a status card that opens the Status screen. This mirrors the relay's one-open-SOS rule.
- Settings icon.

Tapping the SOS button opens the form and starts the location fix at the same moment. Opening the form sends nothing; **Send** is the only action that submits, so a pocket tap cannot create a call.

### 6.3 SOS form (bottom sheet, one screen, no scrolling on a 5.5" phone)
| Field | Rules |
|---|---|
| **What is happening?** | Large chips from the intake's `natures`. Required. No default selected. |
| **Your phone number** | Required. Pre-filled from the last SOS. Numeric keypad. Default country from the device region; validated and converted to E.164 with `libphonenumber-js`. |
| **Location** | Read-only line that updates live: "Finding your location…" → "Location found (±12 m)". If permission is denied or no fix arrives, an **Address / landmark** text field appears and becomes required. The address field is always available as an optional extra (≤ 500 chars). |
| **Your name** | Optional. Pre-filled from last time. |
| **Details** | Optional, ≤ 1000 chars, with a character counter. |
| **Send SOS** | Enabled when nature, phone, and either a location fix or an address are present. |

Location rules:
- Request a high-accuracy fix when the form opens (`expo-location`, foreground only). Show the last known position at once if it is under 2 minutes old, then keep refining until Send.
- Send the best fix available with `accuracyM`, `capturedAt` and `source`. `capturedAt` is the fix's own timestamp, never the time of sending.
- The relay refuses a fix older than 10 minutes (relay §7.4): it drops it if an address is given, and answers 400 if not. Retries from the outbox must refresh it (§8).
- If Send is pressed with no fix yet, wait up to 5 seconds. If there is still none, require the address field.
- If the best accuracy is worse than 100 m, prompt (don't force) the caller to add an address or landmark.

### 6.4 Sending
- Full-screen "Sending…" state. The Send button is disabled so it can't be pressed twice.
- The app generates one `Idempotency-Key` (UUIDv4) per SOS and reuses it for every retry of that SOS.
- The request has a 10-second client timeout (the relay answers within 8 s).

### 6.5 Status screen
Shows the reference code (e.g. `SOS-7KQ2`) in large type, with "Quote this code if you call."

| Relay status | Headline | Supporting text |
|---|---|---|
| *(outbox, not yet accepted)* | **NOT SENT YET** | "We're still trying. If you can, call {emergencyPhone} now." |
| `queued` | **Sent, waiting to reach dispatch** | "Your SOS is saved and being delivered. If it's urgent, call {emergencyPhone}." |
| `received` | **Received** | "A dispatcher will review your SOS. Keep your phone nearby; they may call you." |
| `dispatched` | **Help has been dispatched** | "Stay where you are if it is safe." |
| `closed` | **Closed** | "This SOS has been closed. If you still need help, send a new SOS or call {emergencyPhone}." |
| `failed` | **NOT DELIVERED** | "Your SOS did not reach dispatch. Call {emergencyPhone} now." |

- "Received" must never be worded as "help is coming". A pending call has not been dispatched.
- Polls `GET /v1/sos/:receiptId/status` every 15 s while the app is in the foreground and the status is `queued`, `received` or `dispatched`. Polling stops at `closed` or `failed`, and resumes when the app returns to the foreground.
- The **Call {emergencyPhone}** button is always visible. On `failed` and "NOT SENT YET" it is the primary button.
- A closed or failed SOS can be dismissed, which returns Home to the big button.
- A status change while the app is open triggers a haptic and a screen-reader announcement.

### 6.6 Settings
- Saved phone number and name (edit or clear).
- Department: current name, "Scan QR code", "Enter code".
- Privacy notice, disclaimer, app version, device reference (so a caller can quote it to support).
- **Delete my data from this phone**: clears saved phone, name, receipts and outbox.

---

## 7. Relay API usage

Base URL from `EXPO_PUBLIC_RELAY_BASE_URL`. JSON over TLS. The app sends no cookies and no credential other than the device token and the status token.

| Call | When |
|---|---|
| `GET /v1/intake/:intakeCode` | App foreground (≤ once per 5 min), and after changing department |
| `GET /v1/devices/nonce` → `POST /v1/devices/register` | First launch in the background; again when the device token is within 3 days of expiry; inline before sending if no valid token exists |
| `POST /v1/sos` | On Send, with `Authorization: Bearer <deviceToken>`, `Idempotency-Key`, and a fresh attestation |
| `GET /v1/sos/:receiptId/status` | Polling, with `X-Status-Token` |
| `POST /v1/devices/verify-phone/*` | Only when the intake has `requireVerifiedPhone: true` |

The app never calls Resgrid. The relay does, with one department API key per intake. Which Core calls exist, what they return, and how that becomes `received` / `dispatched` / `closed` is §15.

### 7.1 Handling `POST /v1/sos` responses

| Response | App behaviour |
|---|---|
| **201** `status: "received"` | Store receipt and status token, go to Status screen ("Received"). |
| **201** `status: "failed"` | Status screen, "NOT DELIVERED", call button primary. |
| **202** `status: "queued"` | Store receipt, go to Status screen ("Sent, waiting to reach dispatch"), start polling. |
| **400** | Should not happen with a correct client (an outbox retry that follows §8 is never refused for a stale location). Show "Could not send. Call {emergencyPhone}." Log the error code for crash reporting. Do not retry. |
| **401** | Device token invalid or expired. Re-register once, then retry with the same `Idempotency-Key`. If that fails, show the call button. |
| **403** | Blocked or attestation failed. Show "This phone can't send an SOS from the app. Call {emergencyPhone}." Do not retry, and do not say why. |
| **409** | An SOS from this device is already open. Store the returned `receiptId` and show its status. |
| **410 / 404** | Intake disabled or unknown. Show the "service not available" state. |
| **429 / 503** | Show "Too many requests. Call {emergencyPhone}." Respect `retryAfterSeconds`; do not auto-retry. |
| **Timeout, no network, 5xx** | Put the SOS in the outbox (§8). |

Every error state shows the emergency phone number.

### 7.2 Attestation
- **Android:** Play Integrity token, requested with the relay's nonce.
- **iOS:** App Attest. Generate and attest a key at registration; produce an assertion for each `POST /v1/sos`.
- Native support comes from an Expo module or config plugin (e.g. `expo-app-integrity`; confirm the chosen library covers both platforms on the target Expo SDK before M2). This means the app needs **development builds**; it cannot run in Expo Go.
- Dev and staging builds point at a relay in `permissive` mode so simulators work. Production builds only talk to an `enforce` relay.

---

## 8. Offline and retry (outbox)

- If the SOS can't be delivered to the relay, it is saved to encrypted device storage before the caller sees any result: its `Idempotency-Key`, the form fields, the location fix, and the time of the first attempt. At most one SOS can be in the outbox.
- The caller sees "NOT SENT YET" with the call button as the primary action.
- Retries: immediately when connectivity returns, otherwise at 5 s, 15 s, 30 s, then every 30 s, for up to 30 minutes from the first attempt. A fresh attestation is obtained for each attempt.
- **Location on retry.** The relay refuses a fix older than 10 minutes, so each attempt rebuilds the body. If the saved fix is more than 8 minutes old (the margin covers clock drift and time in flight), the app takes a new fix first (foreground, waiting up to 5 seconds, as in §6.3) and sends that instead. The body is then serialised again and the attestation computed over the new bytes, with the same `Idempotency-Key`. The relay allows this: a retry of an SOS it already accepted is matched by the key alone, and the body is not compared.
- **No fresh fix.** The app does not send the old fix.
  - If the caller gave an address, the attempt is sent without `location`.
  - If not, the "NOT SENT YET" screen shows the **Address / landmark** field and retries wait until the caller fills it in or a fresh fix arrives. The call button stays the primary action.
  - If the intake requires a location (`required.location`), an address is not enough: the app keeps trying for a fix until the 30 minutes are up.
- Retries run while the app is in the foreground. A background task is registered as a best effort, but neither OS guarantees it will run, so the UI must not promise delivery after the app is closed. The screen says: "Keep the app open."
- If the app is reopened with an SOS still in the outbox and under 30 minutes old, retries resume. Older than 30 minutes: mark it "NOT DELIVERED" and stop. A late SOS that arrives hours later with stale location is worse than a clear failure.
- Because the same `Idempotency-Key` is reused, a retry after an ambiguous timeout cannot create a second submission at the relay.

---

## 9. Local data

| Data | Storage | Lifetime |
|---|---|---|
| Device id, device token, iOS attest key id | `expo-secure-store` | Until uninstall or token replacement |
| Active receipt id, status token, reference | `expo-secure-store` | Until the SOS is dismissed; auto-removed 24 h after `closed`/`failed` |
| Outbox (pending SOS: `Idempotency-Key`, form fields, location fix, first-attempt time) | `expo-secure-store` | Until delivered or expired (30 min) |
| Saved phone number and name | `expo-secure-store` | Until the caller clears them |
| Intake code and cached intake config | App storage (not sensitive) | Refreshed on foreground |
| First-launch notice seen | App storage | Permanent |

The app keeps **no history** of past SOS submissions beyond the active one. Nothing is synced to a cloud backup: exclude app storage from Android auto-backup, and use device-only keychain accessibility on iOS.

---

## 10. Technical requirements

### 10.1 Stack
- Latest stable Expo SDK at project start, React Native new architecture, TypeScript strict.
- Expo Router; EAS Build and EAS Submit.
- `expo-location`, `expo-secure-store`, `expo-linking`, `expo-camera` (QR scan), `expo-haptics`, `expo-localization`, `@react-native-community/netinfo`.
- `libphonenumber-js` for phone validation (same library as the relay, so both sides agree).
- Data fetching with plain `fetch` in a small typed client; request and response types shared with or generated from the relay's JSON schemas.
- No Redux or heavy state library. One small store (e.g. Zustand) for SOS state, persisted through secure storage.
- Crash reporting (e.g. Sentry) with PII scrubbing: no phone, name, coordinates, free text or tokens.
- **No analytics or advertising SDKs.**

### 10.2 Platforms
- Android 8.0 (API 26) and later, with Google Play Services (needed for Play Integrity).
- iOS 15.1 and later (App Attest needs iOS 14+).
- Portrait only. Phones only.

### 10.3 Configuration (per build variant: dev, staging, production)
| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_RELAY_BASE_URL` | Relay base URL |
| `EXPO_PUBLIC_DEFAULT_INTAKE_CODE` | Built-in department |
| `EXPO_PUBLIC_PRIVACY_URL` | Privacy notice |
| `RELAY_PIN_SHA256`, `RELAY_PIN_BACKUP_SHA256` | Public-key pins (build-time, native config) |
| `GOOGLE_CLOUD_PROJECT_NUMBER` | Play Integrity |
| Bundle id / package name per variant | So dev, staging and production can be installed side by side |

All `EXPO_PUBLIC_*` values end up in the bundle and are treated as public. No secret may be added to app config.

### 10.4 Security
- TLS only; cleartext traffic disabled on both platforms.
- Public-key pinning of the relay (primary + backup pin), as required by relay §10.2. A pin failure is treated as "no network": the SOS goes to the outbox and the call button is shown.
- The app sends only the fields in relay §7.4. It never sends priority, call type, or any Resgrid field.
- Free text is sent as typed; the relay does the sanitising. The app only enforces length limits.
- OTA updates (EAS Update) are allowed for JS-only fixes, signed, and limited to the matching runtime version.

### 10.5 Performance
- Cold start to interactive SOS button: ≤ 2 s on a mid-range Android phone (2 GB RAM).
- The SOS button responds in under 100 ms. Nothing on the home screen waits on the network.
- App download size ≤ 30 MB.
- No network call on the path from button tap to form display.

### 10.6 Accessibility and language
- Touch targets ≥ 48 dp. Text contrast ≥ 4.5:1. Status is never conveyed by colour alone.
- Full VoiceOver and TalkBack labels; dynamic type up to 200 % without clipping.
- Light and dark themes, following the system.
- All strings in a translation file from day one. v1 ships English; nature labels come from the relay config.
- Wording is short and plain, at roughly a primary-school reading level.

---

## 11. Privacy and store compliance

- **Permissions:** location "while in use" only; camera only when the caller chooses to scan a QR code. No background location, contacts, microphone, or notification permission.
- **Permission text** states the purpose: "Your location is sent with your SOS so responders can find you."
- **Privacy notice** (hosted, linked from first launch and Settings) covers what is sent, who receives it, and the relay's 30-day retention (relay §10.5).
- **Store data declarations** (Play Data safety, App Store privacy labels): precise location, phone number, name, and device identifier, collected for app functionality, not used for tracking, not shared with third parties.
- **Disclaimer** that the app does not replace emergency numbers appears on first launch, in the store description, and in Settings.
- No account means no account-deletion flow is needed. The "Delete my data from this phone" action plus the relay's retention policy is the answer to data-deletion questions.

---

## 12. Testing and acceptance

### 12.1 Testing
- **Unit:** form validation, phone normalisation, response-to-state mapping (§7.1), outbox retry schedule, status copy mapping.
- **Component:** form enable/disable rules, location states, every Status screen state.
- **Integration:** against a staging relay in `permissive` mode with a mock Core, covering each row of §7.1.
- **End-to-end (Maestro or Detox):** first launch → SOS → status, on one Android and one iOS device.
- **Device matrix:** a low-end Android (2 GB RAM, Android 8–10), a current Android, an older iPhone, a current iPhone.
- **Field conditions:** airplane mode, 2G throttling, location denied, location off at OS level, GPS indoors with poor accuracy, app killed while the outbox holds an SOS.
- **Attestation:** real devices from the Play internal track and TestFlight against an `enforce` relay; a rooted or sideloaded build must be refused.

### 12.2 Acceptance criteria
- [ ] AC1. From a fresh install with network and location allowed, a tester sends an SOS without creating an account or entering any code, and it appears in Resgrid Pending Calls with the right coordinates.
- [ ] AC2. First-time send takes ≤ 60 s from first launch; returning send takes ≤ 15 s and ≤ 3 taps.
- [ ] AC3. With location denied, the form requires an address and the SOS still sends.
- [ ] AC4. In airplane mode, Send shows "NOT SENT YET" with the call button. Turning the network back on delivers the SOS within 30 s, exactly once.
- [ ] AC5. Killing and reopening the app with an open SOS shows its status, not the big button.
- [ ] AC6. Pressing SOS while one is open is impossible from the UI, and a forced second request (409) lands on the existing SOS's status.
- [ ] AC7. When the dispatcher dispatches the call, the app shows "Help has been dispatched" within 30 s while in the foreground.
- [ ] AC8. Every error and failure state shows a working "Call {emergencyPhone}" button.
- [ ] AC9. An expired device token is renewed without the caller seeing anything, including when it expires at the moment of sending.
- [ ] AC10. Inspecting the built APK/IPA finds no Resgrid key, relay admin token, or other secret.
- [ ] AC11. Crash reports and logs contain no phone number, name, coordinates, free text or tokens.
- [ ] AC12. The whole SOS flow can be completed with TalkBack and with VoiceOver.
- [ ] AC13. A disabled intake (410) replaces the SOS button with the "not available" message.

### 12.3 App store review
Reviewers will press the button. The review build or review notes must route them to a **demo intake code** that points at a test department, supplied as a deep link in the review notes. Production dispatchers must never receive a reviewer's SOS. This needs a demo intake configured on the relay before first submission.

---

## 13. Milestones

| # | Milestone | Contents |
|---|---|---|
| M1 | Skeleton | Expo project, variants, navigation, theme, strings, home screen with button and call fallback |
| M2 | Device registration | Attestation on both platforms, nonce + register, token storage and silent renewal, dev builds |
| M3 | SOS form and send | Intake config (bundled + live), form, location capture, `POST /v1/sos`, all §7.1 outcomes |
| M4 | Status | Status screen, polling, open-SOS state on Home, dismissal |
| M5 | Offline | Outbox, retry schedule, connectivity handling, expiry |
| M6 | Hardening | Pinning, accessibility pass, device matrix, crash reporting with scrubbing, first-launch notice, Settings, QR / deep link |
| M7 | Release | Privacy notice, store listings and data declarations, demo intake for review, internal track / TestFlight pilot with one department |

---

## 14. Risks and open questions

| # | Item | Notes |
|---|---|---|
| R1 | No data connection at the moment of need | The app can only queue and point to the phone call. An SMS fallback to a relay number is the obvious next step, and is out of scope for v1. |
| R2 | Callers read "Received" as "help is coming" | Copy in §6.5 is deliberate. Test the wording with real users during the pilot. |
| R3 | Accidental or regretted SOS can't be cancelled | The relay has no cancel endpoint. Status screen says to call if sent by mistake. Revisit with the relay after the pilot. |
| R4 | Attestation excludes some phones | Devices without Play Services, rooted phones and some custom ROMs will get 403. They see the call button. Measure how many during the pilot. |
| R5 | Background retries are unreliable | Stated honestly in the UI ("Keep the app open"). |
| R6 | Store rejection for an emergency-services app | Needs the disclaimer, a real department named as the service provider, and the demo intake (§12.3). Allow time for a rejection round. |
| Q1 | **Relay contract: what is the per-request attestation bound to?** | Relay §7.4 asks for a fresh assertion on each SOS but doesn't say what it signs. Proposal: the SHA-256 of `Idempotency-Key` + request body, as the Play Integrity `requestHash` and the App Attest `clientDataHash`. Needs agreeing with the relay before M2. |
| Q2 | **Relay contract: allowed values of `location.source`** | The relay example shows only `"gps"`. The app needs at least `gps`, `network` and `last_known`. |
| Q3 | **Relay contract: demo intake** | §12.3 needs a test department and intake code on the production relay, or a reviewer build pointed at staging. |
| Q4 | One app per department, or one app for all? | v1 assumes one default department per build, with the QR / deep link override. A multi-department picker is a later decision. Core will not pick the nearest department for the relay (§15.1). |
| Q5 | App name, bundle id, and branding | Working name only. Store listings need the final name and the department's consent to be named. |
| Q6 | Languages beyond English for the pilot | Strings are ready for translation; the list of languages is not decided. |

---

## 15. Resgrid Core, for the relay

Findings from Core as of 2026-11-19. The app does not call these. The relay does, and only with a department API key. A key is one department. It cannot name another department, and it cannot sit next to a bearer token or `X-Resgrid-SystemApiKey`.

### 15.1 Departments and keys

A department API key is a row on that department (`DepartmentApiKeys`). The secret is sent as `X-Resgrid-ApiKey`, shown once, and shaped `rgk_{prefix}_{secret}`. It acts as that department's managing user, and only on the v4 actions that declare a scope. `DepartmentId` on a call body is ignored. Limits in source config are 25 active keys per department and a maximum lifetime of 730 days.

The system key (`X-Resgrid-SystemApiKey`, `SecurityConfig.SystemApiKey`) is the one credential that can pass `DepartmentId` and write a call in any department on that server. It is a host secret for the SMTP relay, with create, update, and delete on almost every resource, and it does not check that the department belongs to a given owner. The SOS relay must not hold it.

One department, closest station, is the shape that matches the product. Stations are groups and a group has latitude and longitude. The relay holds that department's key with `calls.create` (and `calls.update` to attach files, §15.5), picks the nearest station itself, and sends `DispatchList` as `G:{groupId}`. There is no nearest-department API.

Several departments means one key per department, stored on the relay, plus a location the relay keeps for each. The relay chooses and calls `SaveCall` with that key. Owning several departments does not produce one secret that covers all of them.

There is no logged-in screen that creates a department. Registration (`/Account/Register`) creates a new user and a department that user owns, and only when `SystemBehaviorConfig.BillingApiBaseUrl` and `ApiConfig.BackendInternalApikey` are set. The form also requires reCAPTCHA (`WebConfig.RecaptchaPublicKey` and `RecaptchaPrivateKey`). Profile → Your Departments lists departments the signed-in user already belongs to, joins an existing one by id and code, and switches the active one. It does not create a department and it does not administer two departments at once.

The service will attach a new department to an existing ordinary user. `CreateDepartmentAsync` sets `ManagingUserId` to the user id passed in. `AddUserToDepartmentAsync(departmentId, userId, isAdmin: true)` writes the admin membership. That helper also marks the new membership active and default without clearing those flags on the department the user is already in, so the screen must then call `SetActiveDepartmentForUserAsync`. Registration also starts the free plan with `CreateFreePlanPaymentAsync` when plan selection during signup is off. `CreateDepartmentAsync` does not.

The four accounts in the initial migration are sample rows (`@yourcompany.local`), not a Resgrid back office.

| Username | What it is |
|---|---|
| `TestAccount1` | Owner of department 1, "Resgrid System Department". Can sign in. |
| `TestAccount2` | Ordinary member of department 1. Can sign in. |
| `admin` | Owner of department 2, "Your Department". Can sign in. |
| `Administrator` | Identity role `Admins` only. No department membership. The website refuses the login because a session requires a live department. The role's only product use is the feature-toggle API. Adding a department membership does not fix the website session, because the claims factory stops at the `Admins` role and never loads a department. |

Department admin (`DepartmentMember.IsAdmin`, or the owner via `ManagingUserId`) is per department and can be granted to any member. A few actions require the owner specifically: deleting the department, the 2FA enforcement scope, MFA method switches, and Advanced Data Protection billing. The Identity role `Admins` is not that, and it is not a super admin over every department.

### 15.2 Endpoints a department key can call

Base path `api/v4/{Controller}/{Action}`. The allow-list is pinned in `Tests/Resgrid.Tests/Services/DepartmentApiKeysServiceTests.cs`. An action with no scope attribute rejects a key no matter which scopes it holds.

Every body is the v4 envelope (`PageSize`, `Page`, `Timestamp`, `Version`, `Node`, `Environment`, `RequestId`, `Status`) plus `Data` or `Id`. `Status` is `success`, `not_found`, `created`, or `updated`. An empty list is HTTP 200 with `Status: "not_found"` and `PageSize: 0`, not an HTTP 404. A missing call from `GetCall` is the same. A real rejection is HTTP 401 or 400.

| Scope | Method and path | Returns |
|---|---|---|
| `calls.read` | `GET Calls/GetActiveCalls` | Active calls (state `0`), each a `CallResultData`. |
| `calls.read` | `GET Calls/GetCall?callId=` | One `CallResultData`. |
| `calls.read` | `GET Calls/GetCalls?startDate=&endDate=` | Calls in a UTC range, same shape. Dates must be on or after 1753-01-01. |
| `calls.read` | `GET Calls/GetPendingCalls` | Pending calls (state `8`). |
| `calls.read` | `GET Calls/GetAllPendingScheduledCalls` | Scheduled calls that have not gone out. |
| `calls.read` | `GET Calls/GetNewCallFieldPolicy` | The department's required and hidden new-call fields. |
| `calls.create` | `POST Calls/SaveCall` | HTTP 201. Body is `{ Id, Status: "created" }`. `Id` is the new call id. The call number, who was paged, and file ids are not in the body. |
| `calls.update` | `PUT Calls/EditCall` | HTTP 200, `{ Id, Status: "updated" }`. Active or pending calls only. |
| `calls.update` | `PUT Calls/UpdateScheduledDispatchTime` | HTTP 200, `{ Id, Status: "updated" }`. Refused once the call has been dispatched. |
| `calls.update` | `PUT Calls/DispatchCallNow` | HTTP 200, `{ Id, Status: "updated" }`. Sends a pending call, or a scheduled call that has not gone out. Fails when there is nobody to send it to. |
| `calls.update` | `POST CallFiles/SaveCallFile` | HTTP 201, `{ Id }` (the attachment id). Active or pending calls only. `Data` is base64. `UserId` is ignored; the file is recorded under the department's managing user. See §15.5. |
| `calls.close` | `PUT Calls/CloseCall` | HTTP 200, `{ Id, Status: "updated" }`. `Type` must be `1`–`7`. An active incident command blocks it. |
| `reference.read` | `GET CallTypes/GetAllCallTypes` | The department's call types. A type string on `SaveCall` that is not in this list is dropped. |
| `reference.read` | `GET CallPriorities/GetAllCallPriorites` | The path spells Priorites. Priorities are `0` Low, `1` Medium, `2` High, `3` Emergency. |
| `reference.read` | `GET Groups/GetAllGroups` | Groups, including stations. A group has latitude and longitude. |
| `reference.read` | `GET Dispatch/GetRolesForCallGrid` | Roles for a dispatch list. |
| `reference.read` | `GET Dispatch/GetCallTemplates` | Call templates. |
| `units.read` | `GET Units/GetAllUnits` | The department's units. |
| `units.read` | `GET UnitStatus/GetAllUnitStatuses` | Each unit's latest status, destination, and coordinates. See §15.4. |

`calls.read` also needs the resource policy `Call_View`. The key's scope grants that claim. `calls.create` grants `Call_Create` and does not grant view. A key that should both create and later read the call needs both scopes. `calls.update` grants `Call_Update` and, for `SaveCallFile`'s `Call_View` policy, `Call_View`; its scope still keeps it off the `calls.read` endpoints.

### 15.3 Creating the SOS call

`SaveCall` with `IsPending: true` is the SOS. Nobody is notified, `DispatchOn` is ignored, and the call stays out of the field apps until a dispatcher sends it with `DispatchCallNow` or from Pending Calls. That is the app's "Received" state. "Help has been dispatched" starts when the call becomes state `0`.

Required body fields are `Priority`, `Name`, and `Nature`. For a public SOS the relay should also send `ContactName`, `ContactInfo` (callback phone), `Note`, `Address`, and `Geolocation` as `lat,lon`. A client that omits `ProtocolIds`, `LinkedCallId`, or `IndoorMapZoneId` (null, not empty) is not blocked by a department rule it has no picker for. `CallFormData` is accepted and discarded.

`DispatchList` is `P:{userId}`, `U:{unitId}`, `G:{groupId}`, `R:{roleId}`, joined by `|`. On a pending call, leave it empty for no proposed recipients. `0` means everyone. On an immediate call (not pending), a blank list from a department key pages the whole department. The system key refuses that. The SOS relay should send `IsPending: true`, or an explicit group, and should not send `0`.

The reporting user stored on the call is the department's managing user. `calls.create` still runs `CanUserCreateCallAsync` as that user. If Create Call is taken away from department admins, the key cannot create calls. `calls.close` still runs `CanUserCloseCallAsync` as the owner, including group scope, so a key can be allowed to edit a call and then forbidden to close it.

`Idempotency-Key` on `SaveCall` is honored for the email-intake receipt path. A repeat of a completed key returns the original call id. An in-flight duplicate is HTTP 409.

Protected departments come back with the literal `REDACTED` and a `ProtectedReason`. A key has no MFA grant, so sensitive fields stay redacted on read. Writes go through the encrypt-only lane and do not need a grant.

### 15.4 Tracking state, and unit locations

Poll `GetCall` with `calls.read`. Map `CallResultData.State` as follows.

| `State` | Name | App status (§6.5) |
|---|---|---|
| `8` | Pending. Saved, not sent. | `received` |
| `0` | Active. Dispatched or otherwise live. `DispatchedOn` is set once it has been sent. | `dispatched` |
| `1` | Closed | `closed` |
| `2` | Cancelled | `closed` |
| `3` | Unfounded | `closed` |
| `4` | Founded | `closed` |
| `5` | Minor | `closed` |
| `6` | Transferred | `closed` |
| `7` | False alarm | `closed` |

`GetActiveCalls` is only state `0`. `GetPendingCalls` is only state `8`. After a close, the call leaves the active list and `GetCall` shows `1`–`7`. The call's own `Latitude`, `Longitude`, `Address`, and `Geolocation` are the incident, not the units.

The call payload does not include the dispatch list, so the relay cannot read back who was paged. It also does not include notes or files, only `NotesCount`, `AudioCount`, `ImgagesCount`, and `FileCount`.

A unit is currently destined to the call when `GetAllUnitStatuses` returns `DestinationType` `2` (call) and `DestinationId` equal to the call id. `1` is a station, `3` is a POI. `Latitude` and `Longitude` are the latest GPS fix when one exists, otherwise the coordinates stored on the status. That destination is what the crew set from the unit app. Being on the original dispatch list does not set it, and the next status the crew picks clears it.

This is a snapshot. Poll again for the next fix. There is no track. `GetLatestUnitLocation`, `SetUnitLocation`, and the unit-tracker ingress have no department-key scope, so the relay cannot call them. The live hub (`/eventingHub`) accepts a user bearer token only and pushes `callsUpdated` or `unitStatusUpdated` as an id. `X-Resgrid-ApiKey` cannot connect to it.

Coordinates are still checked as the managing user. A department admin normally sees them. If that owner is not allowed to see a unit, the coordinates are omitted for the key too.

`GetCallLocationHistory` is earlier calls at the same address, not a GPS trail, and a key cannot call it.

v1 of the app does not show unit positions (§2). The relay can still poll them for a later status screen. Personnel locations are a different API and are not open to the key.

### 15.5 Endpoints a key cannot call

Attaching a file is open: `POST CallFiles/SaveCallFile` takes `calls.update` (§15.2), so the SOS voice recording can go up with the relay's key. The change in Core reused that scope, not a new one, so it stays out of `DepartmentApiKeyScopes.All`, the API Keys checkbox dictionary, and the ten `Security.*.resx` files that conflict on every upstream sync. `calls.update` now also grants `Call_View`, which `SaveCallFile` keeps as its policy so signed-in members who can attach today still can. A department key skips the Add Call Data check (it acts for its own department, which the key pins), writes protected fields as an unattended writer instead of asking for an MFA grant, and is recorded as the department's managing user whatever `UserId` it posts. The cost: a `calls.update` key can attach a file to any active or pending call in its department, as it can already edit or dispatch one.

The rest of this section is still closed.

| Wanted | Blocked because |
|---|---|
| List files (`GET CallFiles/GetFilesForCall`) | No scope. Opening it would be a `calls.read` decision. |
| Notes (`GET CallNotes/GetCallNotes`, `POST CallNotes/SaveCallNote`) | No key scope. `Call_View`, then Add Call Data as the acting user; opening it would follow the `SaveCallFile` change above. |
| Delete a call, escalate an alarm, call history, site info, extra data | No scope. |
| Stream locations | No key-accessible stream. Poll §15.4. |
