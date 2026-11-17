# Attestation contract (app → relay)

This is what the app must send so the relay can prove that a request comes from a genuine install.
It matches `src/attestation/` exactly. When the two disagree, the code is right and this file is a bug.

In `enforce` mode, anything that does not verify gets a `403` with no detail. The reason is only in
the relay's logs.

## Encodings used below

| Name | Meaning |
|---|---|
| **base64** | Standard base64 (RFC 4648 §4: `A–Z a–z 0–9 + /`), with `=` padding. Swift's `Data.base64EncodedString()` produces it. Padding may be omitted. URL-safe base64 (`-` `_`) is **rejected**. |
| **hex** | Lowercase hexadecimal, 64 characters for 32 bytes. Uppercase is **rejected**. |
| **as-is** | The exact string the platform API returned or the relay issued. No re-encoding, trimming or wrapping. |

## The binding hash `h` (both platforms, every SOS)

```
h = SHA-256( UTF-8(Idempotency-Key) || 0x0A || raw request body bytes )
```

- `Idempotency-Key` is the header value exactly as sent (the UUID string, same case).
- `0x0A` is a single newline byte.
- The body is **the exact bytes you put on the wire**. Serialise the JSON once, hash those bytes and send
  those same bytes. Do not re-serialise. Key order, whitespace and escaping must not change between hashing and sending.
- `h` is 32 raw bytes.

Test vector:

```
Idempotency-Key: 5b0c3f2e-8a51-4f3c-9d7e-0a1b2c3d4e5f
Body:            {"intakeCode":"demo","nature":"fire","phone":"+15550100"}
h (hex):         9f8748b95a13312d8a6aba78e9528fd33e543e4a148608067b8462a01aadfeb8
```

A retry reuses the same `Idempotency-Key` and body, so it has the same `h`. It still needs a **fresh**
attestation (see each platform below).

## The four cases

| | Registration (`POST /v1/devices/register`) | SOS (`POST /v1/sos`) |
|---|---|---|
| **iOS** | App Attest *attestation*, `clientDataHash = SHA-256(UTF-8(nonce))` | App Attest *assertion*, `clientDataHash = h` |
| **Android** | Play Integrity *classic* request, `nonce = nonce` as-is | Play Integrity *standard* request, `requestHash = hex(h)` |

`nonce` is the `nonce` string from `GET /v1/devices/nonce`. It is single use and valid for 5 minutes.

### iOS: registration

1. `keyId = try await DCAppAttestService.shared.generateKey()`. Keep `keyId` and reuse it for every assertion.
2. `clientDataHash = SHA256(Data(nonce.utf8))`: the 32-byte SHA-256 of the nonce string's UTF-8 bytes.
3. `attestation = try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash)`.
4. Send:

```json
{
  "platform": "ios",
  "nonce": "<nonce, as-is>",
  "attestation": {
    "keyId": "<keyId: base64, as returned by generateKey()>",
    "attestationObject": "<attestation: base64>"
  }
}
```

The relay checks that:

- the certificate chain leads to Apple's App Attestation Root CA, and every certificate is within its validity period;
- the certificate's nonce equals `SHA-256(authData || clientDataHash)`;
- `keyId` is the SHA-256 of the certified public key and equals the credential ID;
- the RP ID is `SHA-256("{IOS_TEAM_ID}.{IOS_BUNDLE_ID}")`;
- the counter is 0;
- the `aaguid` matches `IOS_APP_ATTEST_ENV`. `production` means `appattest` followed by seven zero bytes, and `development` means `appattestdevelop`.

The `aaguid` follows the app's `com.apple.developer.devicecheck.appattest-environment` entitlement. App Store
and TestFlight builds use `production`, so a development build is refused by a production relay. The reverse
is also true.

### iOS: each SOS

1. Compute `h` as above.
2. `assertion = try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: h)`.
   Pass `h` itself. **Do not hash it again.**
3. Send header `X-Attestation: <assertion: base64>`.

The relay checks the signature over `SHA-256(authenticatorData || h)` with the key stored at registration,
the RP ID, and that the counter is **strictly greater** than the last accepted one. Each attempt, including
a retry, must call `generateAssertion` again. Re-sending an earlier assertion is refused.

If the key is lost (reinstall or restore), register again with a new key.

### Android: registration (classic request)

1. Request a token with the nonce exactly as received:
   `IntegrityTokenRequest.builder().setNonce(nonce).build()`.
   The relay's nonce is already URL-safe base64 with no padding or wrapping, as Play requires.
2. Send:

```json
{
  "platform": "android",
  "nonce": "<nonce, as-is>",
  "attestation": { "integrityToken": "<IntegrityTokenResponse.token(), as-is>" }
}
```

### Android: each SOS (standard request)

1. Warm up `StandardIntegrityManager.prepareIntegrityToken(...)` in advance, for example at app start.
   That step is too slow to do while an SOS is in progress.
2. Compute `h`, then `requestHash = hex(h)`: 64 lowercase hex characters.
3. `provider.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())`.
4. Send header `X-Attestation: <StandardIntegrityToken.token(), as-is>`.
   The Android token is sent unchanged. It is **not** base64-wrapped again.

Request a new token for every attempt, including retries. Google clears the verdicts of a token that has
already been decoded. The token must be under 5 minutes old when it reaches the relay, and its timestamp
may be at most 60 seconds ahead of the relay's clock.

### What Android verdicts must say (both phases)

- `requestDetails.requestPackageName` and `appIntegrity.packageName` equal `ANDROID_PACKAGE_NAME`.
- `requestDetails.nonce` equals the nonce (registration), or `requestDetails.requestHash` equals `hex(h)` (SOS).
- `appIntegrity.appRecognitionVerdict` is `PLAY_RECOGNIZED`, which means installed from Google Play.
  Sideloaded and debug builds fail.
- Every entry in `appIntegrity.certificateSha256Digest` is one of `ANDROID_CERT_SHA256`.
  Use the **app signing key** certificate from Play Console › App integrity, not the upload key.
- `deviceIntegrity.deviceRecognitionVerdict` contains `MEETS_DEVICE_INTEGRITY`.
- It is not a Play Console test response (`testingDetails.isTestingResponse`).

## Size limits

`attestationObject` decodes to at most 64 KiB, an assertion to at most 4 KiB, and an Android token is at most 16 384 characters.
