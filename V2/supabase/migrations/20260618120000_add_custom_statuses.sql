CREATE TABLE project_statuses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6B7280',
  base_status text NOT NULL CHECK (base_status IN ('pending', 'in_progress', 'done')),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE project_statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own project statuses"
  ON project_statuses FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS custom_status_id uuid REFERENCES project_statuses(id) ON DELETE SET NULL;
