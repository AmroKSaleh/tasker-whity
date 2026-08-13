-- Fix concurrent short_id collisions on the tasks table.
--
-- Root cause: assign_task_short_id() did a plain SELECT MAX(short_id) with no
-- locking. Two concurrent inserts both read the same MAX, both compute the same
-- next value, and both succeed — leaving two tasks with the same short_id.
--
-- Fix: acquire a per-project advisory lock *inside* the trigger before the MAX
-- query. pg_advisory_xact_lock() is exclusive and transaction-scoped, so
-- concurrent inserts for the same project queue up; different projects don't
-- block each other (each hashes to a distinct lock id — collision probability
-- is ~1 in 2^32, acceptable here).

CREATE OR REPLACE FUNCTION assign_task_short_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.short_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id::text));
    SELECT COALESCE(MAX(short_id), 0) + 1
    INTO NEW.short_id
    FROM tasks
    WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- NOTE: a unique index on (project_id, short_id) is intentionally not added
-- here because existing duplicate short_ids (from past races) would block
-- creation. The advisory lock above prevents NEW collisions going forward.
