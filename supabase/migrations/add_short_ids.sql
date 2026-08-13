-- Add prefix column to projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prefix text DEFAULT '';

-- Add short_id column to tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS short_id integer;

-- Auto-increment short_id per project on insert
CREATE OR REPLACE FUNCTION assign_task_short_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.short_id IS NULL THEN
    SELECT COALESCE(MAX(short_id), 0) + 1
    INTO NEW.short_id
    FROM tasks
    WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS task_short_id_trigger ON tasks;
CREATE TRIGGER task_short_id_trigger
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION assign_task_short_id();

-- Backfill existing tasks with sequential short_ids per project
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS rn
  FROM tasks
  WHERE short_id IS NULL
)
UPDATE tasks t SET short_id = n.rn
FROM numbered n WHERE t.id = n.id;

-- Backfill existing project prefixes from name
UPDATE projects
SET prefix = UPPER(LEFT(
  CASE
    WHEN array_length(regexp_split_to_array(TRIM(name), '\s+'), 1) >= 3
      THEN LEFT(split_part(TRIM(name), ' ', 1), 1) ||
           LEFT(split_part(TRIM(name), ' ', 2), 1) ||
           LEFT(split_part(TRIM(name), ' ', 3), 1)
    WHEN array_length(regexp_split_to_array(TRIM(name), '\s+'), 1) = 2
      THEN LEFT(split_part(TRIM(name), ' ', 1), 1) ||
           LEFT(split_part(TRIM(name), ' ', 2), 2)
    ELSE LEFT(TRIM(name), 3)
  END || 'XXX', 3))
WHERE prefix = '' OR prefix IS NULL;
