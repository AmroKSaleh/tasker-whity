-- TDE-184 (milestones 5-6): KB staleness + archiving.
-- archived_at: null = active; non-null = archived (recoverable, never auto-deleted).
-- reviewed_at: bumped by a "Keep" action so the staleness clock resets without
-- faking a content edit. Staleness = coalesce(reviewed_at, updated_at) age.
alter table project_knowledge
  add column if not exists archived_at timestamptz default null,
  add column if not exists reviewed_at timestamptz default null;

create index if not exists project_knowledge_active_idx
  on project_knowledge(project_id, archived_at);
