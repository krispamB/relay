-- One open SOS per device, counted separately for real and demo submissions, so an open demo
-- SOS can never stand in for (or block) a real one.
DROP INDEX submissions_one_open_per_device_idx;
CREATE UNIQUE INDEX submissions_one_open_per_device_idx
  ON submissions (device_id, is_demo) WHERE status IN ('queued', 'received', 'dispatched');
-- For the 30-day purge of registration rows.
CREATE INDEX device_registrations_created_idx ON device_registrations (created_at);
