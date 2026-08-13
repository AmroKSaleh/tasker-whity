-- TDE-281: Guide mode — per-task executor attribute + human guidance text + guide cursor on flows.
-- executor: who runs this step (agent = AI runs it, user = human guided, external = third party)
-- human_guidance: the human-facing step instructions shown in guide mode (distinct from detail which is AI-facing)
-- guide_cursor: the flow_step ordinal the guide is currently paused at (null = not in guide mode)

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS executor TEXT NOT NULL DEFAULT 'agent'
    CHECK (executor IN ('agent', 'user', 'external')),
  ADD COLUMN IF NOT EXISTS human_guidance TEXT;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS guide_cursor INTEGER;
