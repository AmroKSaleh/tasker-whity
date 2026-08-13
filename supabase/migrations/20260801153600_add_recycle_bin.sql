-- Add soft delete columns
ALTER TABLE tasks ADD COLUMN is_deleted boolean DEFAULT false;
ALTER TABLE tasks ADD COLUMN deleted_at timestamp with time zone;

ALTER TABLE projects ADD COLUMN is_deleted boolean DEFAULT false;
ALTER TABLE projects ADD COLUMN deleted_at timestamp with time zone;

ALTER TABLE flows ADD COLUMN is_deleted boolean DEFAULT false;
ALTER TABLE flows ADD COLUMN deleted_at timestamp with time zone;

-- Index for faster filtering
CREATE INDEX idx_tasks_is_deleted ON tasks(is_deleted);
CREATE INDEX idx_projects_is_deleted ON projects(is_deleted);
CREATE INDEX idx_flows_is_deleted ON flows(is_deleted);

-- Set up pg_cron for 7-day cleanup (runs at midnight every day)
-- Note: pg_cron extension must be enabled on the database
SELECT cron.schedule('recycle_bin_cleanup', '0 0 * * *', $$
  DELETE FROM tasks WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM projects WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM flows WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
$$);
