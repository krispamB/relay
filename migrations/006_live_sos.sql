-- Live SOS (docs/live-sos-plan.md §6): accounts sign in by phone, the SOS belongs to the signed-in
-- user, recordings follow the SOS, and the live view streams the call's status and its units.

-- users: email is removed (plan D5). Sign-in is by phone, which is already unique.
ALTER TABLE users DROP COLUMN email;

-- signin_attempts: the per-email limit becomes a per-phone limit (plan §3.1). phone_hash is an
-- HMAC-SHA256 of the phone number as sent (trimmed) under the signinPhone HKDF key
-- (src/auth/keys.ts, info 'signin-phone-hash', prefix 'signin-phone:'), never the number.
-- The rows are 1-hour rate-limit state keyed by email hashes, which can never match a phone hash:
-- they are deleted rather than carried over.
DELETE FROM signin_attempts;
ALTER TABLE signin_attempts RENAME COLUMN email_hash TO phone_hash;
