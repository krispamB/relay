-- Auth for the demo app. See docs/auth-contract.md and docs/auth-implementation-plan.md.
-- Accounts are separate from devices: nothing here references the devices table.

-- email is stored trimmed and lowercased by the application, so a plain unique constraint is enough.
CREATE TABLE users (
  id             text PRIMARY KEY,
  full_name      text NOT NULL,
  phone          text NOT NULL UNIQUE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

-- One family per sign-up or sign-in: every refresh token descended from it. Revoking the family
-- ends the session, whichever token of the family is presented.
CREATE TABLE token_families (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  install_id   text NOT NULL,
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version  text NOT NULL,
  created_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
-- Lets the cascade from users find its families.
CREATE INDEX token_families_user_idx ON token_families (user_id);
-- For the purge of revoked families.
CREATE INDEX token_families_revoked_idx ON token_families (revoked_at) WHERE revoked_at IS NOT NULL;

-- Only a SHA-256 hash of the token is stored. parent_id names the token this one was rotated from
-- (no foreign key: the purge may delete a parent before its child). access_iat and access_exp are
-- the claims of the access token issued with this row, so a grace-window replay can re-sign the
-- identical token.
CREATE TABLE refresh_tokens (
  id          text PRIMARY KEY,
  family_id   text NOT NULL REFERENCES token_families (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id   text,
  token_hash  text NOT NULL UNIQUE,
  issued_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,
  access_iat  timestamptz NOT NULL,
  access_exp  timestamptz NOT NULL
);
-- Lets the cascades from token_families and users find their tokens.
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
-- For the purge of expired tokens.
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- Sign-up replay: the same key and the same body within 24 hours is answered as a replay.
-- body_hmac is a keyed hash of the request body.
CREATE TABLE signup_idempotency (
  key         text PRIMARY KEY,
  body_hmac   text NOT NULL,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL
);
CREATE INDEX signup_idempotency_created_idx ON signup_idempotency (created_at);
CREATE INDEX signup_idempotency_user_idx ON signup_idempotency (user_id);

-- The 3-per-day sign-up limit per phone number. phone_hash is a keyed hash, never the number itself.
CREATE TABLE signup_phone_attempts (
  id          bigserial PRIMARY KEY,
  phone_hash  text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX signup_phone_attempts_idx ON signup_phone_attempts (phone_hash, created_at);
-- For the purge.
CREATE INDEX signup_phone_attempts_created_idx ON signup_phone_attempts (created_at);
