-- An attested iOS key belongs to one device only (Apple's guidance; PRD §7.2).
CREATE UNIQUE INDEX devices_ios_key_id_idx ON devices (ios_key_id) WHERE ios_key_id IS NOT NULL;
-- Lets the cascade from devices find its registration rows.
CREATE INDEX device_registrations_device_idx ON device_registrations (device_id);
