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

-- submissions: an SOS belongs to the signed-in user (plan D2, D6). Existing submissions belong to
-- devices, and no app has sent a real SOS, so they are DELETED rather than mapped to users
-- (plan §6; say so in the release note). Their events go with them (ON DELETE CASCADE).
DELETE FROM submissions;
DROP INDEX submissions_one_open_per_device_idx;
DROP INDEX submissions_device_accepted_idx;
ALTER TABLE submissions DROP CONSTRAINT submissions_device_id_idempotency_key_key;
ALTER TABLE submissions
  DROP COLUMN device_id,
  DROP COLUMN nature_id,
  DROP COLUMN name,
  DROP COLUMN details;
-- nature_label stays: it holds the relay's fixed nature text (SOS_NATURE_TEXT) at accept time.
ALTER TABLE submissions
  ADD COLUMN user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Bumped (with NOTIFY sos_live) in the transaction of every change the live snapshot shows.
  ADD COLUMN live_version bigint NOT NULL DEFAULT 0,
  -- The caller is watching until then: the poller reads this call fast (plan D13).
  ADD COLUMN live_watch_until timestamptz,
  -- The caller's latest position from the socket. Never sent to Core (plan D14).
  ADD COLUMN live_lat double precision,
  ADD COLUMN live_lon double precision,
  ADD COLUMN live_at timestamptz;
ALTER TABLE submissions
  ADD CONSTRAINT submissions_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);
-- One open SOS per user, counted separately for real and demo submissions (as 003 did per device).
CREATE UNIQUE INDEX submissions_one_open_per_user_idx
  ON submissions (user_id, is_demo) WHERE status IN ('queued', 'received', 'dispatched');
-- The per-user rate limit, and the cascade from users.
CREATE INDEX submissions_user_accepted_idx ON submissions (user_id, accepted_at);
-- The poller's "who is watching" lookups.
CREATE INDEX submissions_live_watch_idx ON submissions (live_watch_until) WHERE live_watch_until IS NOT NULL;

-- strikes, blocks: keyed by user id and phone hash (plan D3); 'device' becomes 'user'. Device
-- strikes and blocks name devices that no longer exist, so they are deleted. Phone strikes and
-- blocks are kept: the phone hash is unchanged, and a new account with the same phone keeps them.
DELETE FROM strikes WHERE subject_type = 'device';
DELETE FROM blocks WHERE subject_type = 'device';
ALTER TABLE strikes DROP CONSTRAINT strikes_subject_type_check;
ALTER TABLE strikes ADD CONSTRAINT strikes_subject_type_check CHECK (subject_type IN ('user', 'phone'));
ALTER TABLE blocks DROP CONSTRAINT blocks_subject_type_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_subject_type_check CHECK (subject_type IN ('user', 'phone'));

-- relay_state: when the unit poll step may next call GetAllUnitStatuses (plan §5.1).
ALTER TABLE relay_state ADD COLUMN units_next_poll_at timestamptz;

-- Voice recordings that follow an SOS (plan §4). The bytes are cleared once Core has the file or the
-- recording is dropped; the row (and Core's file id) stays until the submission is purged.
CREATE TABLE recordings (
  id               text PRIMARY KEY,               -- 'rec_' + ULID
  submission_id    text NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  seq              integer NOT NULL,               -- 1-based
  idempotency_key  text NOT NULL,
  body_hash        text NOT NULL,                  -- SHA-256 hex of the bytes
  bytes            bytea,                          -- NULL once attached or dropped
  size             integer NOT NULL,
  duration_ms      integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'attached', 'dropped')),
  core_file_id     text,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  drop_reason      text,
  created_at       timestamptz NOT NULL,
  attached_at      timestamptz,
  UNIQUE (submission_id, seq),
  UNIQUE (submission_id, idempotency_key)
);
-- The attach worker's queue.
CREATE INDEX recordings_due_idx ON recordings (next_attempt_at) WHERE status = 'pending';

-- Units whose status destination is the SOS's call (plan §5.1, D11, D12). unit_key is an HMAC of
-- Core's unit id; nothing else from Core's unit list is stored.
CREATE TABLE submission_units (
  submission_id  text NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  unit_key       text NOT NULL,
  unit_type      text,
  status_text    text,
  lat            double precision,
  lon            double precision,
  status_at      timestamptz,
  PRIMARY KEY (submission_id, unit_key)
);

-- The device model is gone (plan D19): no device tokens, registrations or attestation nonces.
DROP TABLE device_registrations;
DROP TABLE nonces;
DROP TABLE devices;
