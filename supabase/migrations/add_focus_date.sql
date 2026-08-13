-- Adds focus_date for the Today page hybrid focus model.
-- focus_date = the day the user has queued this task for action.
-- Carry-over rule (enforced in app logic): tasks with focus_date < today
-- and status != 'done' remain visible on the Today page, tagged as "Carried from yesterday".

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS focus_date date;

-- Partial index — most tasks won't have focus_date set.
CREATE INDEX IF NOT EXISTS tasks_focus_date_idx
  ON tasks(focus_date)
  WHERE focus_date IS NOT NULL;