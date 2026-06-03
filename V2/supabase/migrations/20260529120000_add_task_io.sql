-- Task input/output: workflow engine with validation and feedback loops
-- input: { source_task_id, expected_type, validation_rules }
-- output: { target_task_id, validation_status, feedback }
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS input jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS output jsonb DEFAULT NULL;
