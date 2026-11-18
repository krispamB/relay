-- Sign-in rate limit: 10 attempts per hour per email address (docs/auth-contract.md §6).
-- email_hash is an HMAC-SHA256 of the lowercased email under the signinEmail HKDF key
-- (src/auth/keys.ts, info 'signin-email-hash', prefix 'signin-email:'), never the address.
-- Rows older than 1 hour are deleted by the purge job.

CREATE TABLE signin_attempts (
  id          bigserial PRIMARY KEY,
  email_hash  text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX signin_attempts_idx ON signin_attempts (email_hash, created_at);
-- For the purge.
CREATE INDEX signin_attempts_created_idx ON signin_attempts (created_at);
