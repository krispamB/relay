-- The live socket (docs/live-sos-plan.md D14, D15, §5.2).

-- When the relay last stored a socket location for this SOS (relay clock). The 1-per-5-s limit on
-- socket locations counts from it, in the UPDATE itself, so it holds across instances. live_at stays
-- the fix's own capture time, which the snapshot's 2-minute freshness rule reads.
ALTER TABLE submissions ADD COLUMN live_stored_at timestamptz;

-- Session revocation is announced on channel 'session_revoked' with the family id, so every relay
-- instance can close that session's sockets with 4003. A trigger, so that every path that revokes
-- (sign-out, refresh-token reuse detection, an operator's SQL) announces it, inside the revoking
-- transaction: Postgres delivers it on commit and drops it on rollback. A deleted family (its user was
-- deleted, or the purge) is announced too: its access tokens answer session_revoked from then on.
-- The channel name is SESSION_REVOKED_CHANNEL in src/auth/sessions.ts.
CREATE FUNCTION notify_session_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('session_revoked', OLD.id);
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    PERFORM pg_notify('session_revoked', NEW.id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER token_families_revoked_notify
  AFTER UPDATE OF revoked_at ON token_families
  FOR EACH ROW EXECUTE FUNCTION notify_session_revoked();

CREATE TRIGGER token_families_deleted_notify
  AFTER DELETE ON token_families
  FOR EACH ROW EXECUTE FUNCTION notify_session_revoked();
