-- Make cross-project task moves assign a fresh short_id ATOMICALLY (TDE-186 follow-up).
--
-- Background: assign_task_short_id() only fired BEFORE INSERT, so a cross-project move
-- (an UPDATE of project_id) kept the old number. move_task worked around this by computing
-- MAX(short_id)+1 in app code — but with NO advisory lock, so concurrent/bulk moves into the
-- same project could race and collide (the exact bug we hit on 2026-06-25). Forcing moves to
-- run sequentially was a band-aid; this moves the assignment into the DB where the existing
-- per-project advisory lock guarantees correctness even under concurrency.
--
-- Fix: the trigger now ALSO reassigns short_id when a row's project_id changes on UPDATE,
-- holding pg_advisory_xact_lock on the TARGET project (same lock the insert path uses, so
-- inserts and moves into the same project serialize against each other). move_task no longer
-- computes short_id itself — it just sets the new project_id and lets the trigger renumber.

CREATE OR REPLACE FUNCTION assign_task_short_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Assign on insert (short_id null) OR when a move changes the project (renumber in target).
  IF NEW.short_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id::text));
    SELECT COALESCE(MAX(short_id), 0) + 1
    INTO NEW.short_id
    FROM tasks
    WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate the trigger to fire on UPDATE as well as INSERT.
DROP TRIGGER IF EXISTS task_short_id_trigger ON tasks;
CREATE TRIGGER task_short_id_trigger
BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION assign_task_short_id();
