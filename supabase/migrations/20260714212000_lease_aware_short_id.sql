-- Local Mode (TDE-410): make server-side short-ID assignment lease-aware.
-- Devices lease ID blocks (local_id_leases) for offline-safe local task creation;
-- the MAX(short_id)+1 trigger must jump PAST leased blocks or a server-side create
-- would collide with a not-yet-flushed local task. Preserves the per-project
-- advisory lock (20260624140000) and move renumbering (20260625140000).

CREATE OR REPLACE FUNCTION assign_task_short_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.short_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id::text));
    SELECT GREATEST(
      COALESCE((SELECT MAX(short_id) FROM tasks WHERE project_id = NEW.project_id), 0),
      COALESCE((SELECT MAX(lease_end) FROM local_id_leases WHERE project_id = NEW.project_id), 0)
    ) + 1
    INTO NEW.short_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
