-- Watched polling (docs/live-sos-plan.md §5.1, D13). When the poller last claimed this SOS for a Core
-- read. A watched SOS's next_poll_at is only ever pulled earlier, and never below last_poll_at + 15 s,
-- so one call is never read more often than every 15 s, whichever instance reads it. NULL until the
-- first read; the floor then counts from delivered_at.
ALTER TABLE submissions ADD COLUMN last_poll_at timestamptz;
