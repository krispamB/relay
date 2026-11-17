-- SOS Relay schema v1. See sos-relay-PRD.md §12.

CREATE TABLE devices (
  id                    text PRIMARY KEY,
  platform              text NOT NULL CHECK (platform IN ('android', 'ios')),
  token_hash            text NOT NULL UNIQUE,
  token_expires_at      timestamptz NOT NULL,
  attested              boolean NOT NULL,
  ios_key_id            text,
  ios_public_key        text,
  ios_counter           bigint NOT NULL DEFAULT 0,
  phone_verified_at     timestamptz,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
);
CREATE INDEX devices_token_expires_at_idx ON devices (token_expires_at);

-- One row per successful registration or renewal; used for the per-IP registration limit.
CREATE TABLE device_registrations (
  id          bigserial PRIMARY KEY,
  device_id   text NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  ip_hash     text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX device_registrations_ip_idx ON device_registrations (ip_hash, created_at);

CREATE TABLE nonces (
  nonce       text PRIMARY KEY,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX nonces_expires_at_idx ON nonces (expires_at);

CREATE TABLE submissions (
  id                    text PRIMARY KEY,
  device_id             text NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  idempotency_key       text NOT NULL,
  intake_code           text NOT NULL,
  is_demo               boolean NOT NULL DEFAULT false,
  reference             text NOT NULL UNIQUE,
  status                text NOT NULL CHECK (status IN ('queued', 'received', 'dispatched', 'closed', 'failed')),
  nature_id             text NOT NULL,
  nature_label          text NOT NULL,
  phone                 text NOT NULL,
  phone_hash            text NOT NULL,
  name                  text,
  lat                   double precision,
  lon                   double precision,
  accuracy_m            double precision,
  location_captured_at  timestamptz,
  location_source       text CHECK (location_source IN ('gps', 'network', 'last_known')),
  address               text,
  details               text,
  ip                    text NOT NULL,
  attempts              integer NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz,
  core_call_id          text,
  core_state            integer,
  failure_reason        text,
  next_poll_at          timestamptz,
  accepted_at           timestamptz NOT NULL,
  delivered_at          timestamptz,
  closed_at             timestamptz,
  updated_at            timestamptz NOT NULL,
  UNIQUE (device_id, idempotency_key)
);
-- One open SOS per device.
CREATE UNIQUE INDEX submissions_one_open_per_device_idx
  ON submissions (device_id) WHERE status IN ('queued', 'received', 'dispatched');
-- The delivery queue.
CREATE INDEX submissions_queue_idx ON submissions (next_attempt_at) WHERE status = 'queued';
-- The status poller.
CREATE INDEX submissions_poll_idx ON submissions (next_poll_at) WHERE next_poll_at IS NOT NULL;
-- Rate limits and purge.
CREATE INDEX submissions_device_accepted_idx ON submissions (device_id, accepted_at);
CREATE INDEX submissions_phone_accepted_idx ON submissions (phone_hash, accepted_at);
CREATE INDEX submissions_ip_accepted_idx ON submissions (ip, accepted_at);
CREATE INDEX submissions_accepted_idx ON submissions (accepted_at);

CREATE TABLE submission_events (
  id             bigserial PRIMARY KEY,
  submission_id  text NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  cause          text NOT NULL,
  at             timestamptz NOT NULL
);
CREATE INDEX submission_events_submission_idx ON submission_events (submission_id);

-- No foreign key to submissions: a strike outlives the submission that caused it.
CREATE TABLE strikes (
  id             bigserial PRIMARY KEY,
  subject_type   text NOT NULL CHECK (subject_type IN ('device', 'phone')),
  subject        text NOT NULL,
  submission_id  text NOT NULL,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  UNIQUE (subject_type, submission_id)
);
CREATE INDEX strikes_subject_idx ON strikes (subject_type, subject, expires_at);

-- subject is a device id, or the keyed hash of a phone number. Never a phone number in the clear.
CREATE TABLE blocks (
  id            text PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('device', 'phone')),
  subject       text NOT NULL,
  reason        text NOT NULL,
  source        text NOT NULL CHECK (source IN ('automatic', 'manual')),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz
);
CREATE INDEX blocks_subject_idx ON blocks (subject_type, subject);

CREATE TABLE relay_state (
  id                 integer PRIMARY KEY CHECK (id = 1),
  paused             boolean NOT NULL DEFAULT false,
  paused_reason      text,
  paused_at          timestamptz,
  check_status       text NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown', 'ok', 'unhealthy')),
  check_detail       text,
  check_at           timestamptz,
  check_ok_at        timestamptz,
  required_location  boolean NOT NULL DEFAULT false,
  required_address   boolean NOT NULL DEFAULT false,
  required_name      boolean NOT NULL DEFAULT false
);
INSERT INTO relay_state (id) VALUES (1);

CREATE TABLE alert_log (
  code          text PRIMARY KEY,
  last_sent_at  timestamptz NOT NULL
);
