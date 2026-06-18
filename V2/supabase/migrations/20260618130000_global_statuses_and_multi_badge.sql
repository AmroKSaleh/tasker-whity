-- Make project_id optional so statuses can be user-wide (project_id = null)
ALTER TABLE project_statuses ALTER COLUMN project_id DROP NOT NULL;

-- Junction table: a task can have multiple custom statuses
CREATE TABLE task_statuses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status_id uuid NOT NULL REFERENCES project_statuses(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(task_id, status_id)
);

ALTER TABLE task_statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own task statuses"
  ON task_statuses FOR ALL
  USING (
    EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.user_id = auth.uid())
  );
