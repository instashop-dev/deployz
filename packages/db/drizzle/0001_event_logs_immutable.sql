-- §40 EventLog immutability (custom migration — drizzle-kit cannot express triggers).
--
-- event_logs is APPEND-ONLY. A REVOKE-based guard is not possible against
-- PGlite's single role, so this trigger IS the enforcement; the proof lives
-- in src/event-logs.test.ts (INSERT succeeds, UPDATE/DELETE/TRUNCATE raise).

CREATE OR REPLACE FUNCTION event_logs_immutable_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_logs is append-only: % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER event_logs_immutable
BEFORE UPDATE OR DELETE ON event_logs
FOR EACH ROW EXECUTE FUNCTION event_logs_immutable_fn();
--> statement-breakpoint

-- FOR EACH ROW triggers do not fire on TRUNCATE; guard that path too or the
-- log is one TRUNCATE away from silent tampering.
CREATE TRIGGER event_logs_immutable_truncate
BEFORE TRUNCATE ON event_logs
FOR EACH STATEMENT EXECUTE FUNCTION event_logs_immutable_fn();
