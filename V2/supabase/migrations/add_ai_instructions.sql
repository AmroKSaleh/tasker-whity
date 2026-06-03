-- AI instructions: behavioral preferences for AI agents (Claude Code, Cursor, Windsurf, etc.)
-- Stores: task_list_format, show_completed_tasks, rank_tasks_by, communication_style, multiple_tasks_handling, show_project_context
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS ai_instructions jsonb DEFAULT NULL;
