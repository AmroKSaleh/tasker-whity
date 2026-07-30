-- Environments (TDE-354, from TDE-308): a single-user context partition ABOVE projects.
-- Hierarchy becomes Tasker -> Environments -> Projects -> Sections -> Tasks.
-- SINGLE-USER ONLY: no team membership, no sharing. RLS scopes every row to its owner,
-- same pattern as projects/project_drafts. The MCP runs as service role and bypasses RLS;
-- the web app runs under the user JWT and relies on these policies.

create table if not exists environments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table environments enable row level security;
create policy "environments own all" on environments for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists environments_user_id_idx on environments(user_id);

-- Projects belong to one Environment. Nullable so the backfill can run in stages and so a
-- project is never lost if its Environment is removed. ON DELETE SET NULL is a safety net —
-- the app/MCP layer reassigns a deleted Environment's projects to the user's Default first
-- (TDE-358); a null environment_id is treated as "Default/unassigned" by the app.
alter table projects
  add column if not exists environment_id uuid references environments(id) on delete set null;
create index if not exists projects_environment_id_idx on projects(environment_id);

-- Server-owned active-Environment pointer. user_settings already holds default_project_id
-- (see V2/supabase/functions/mcp/index.ts:105), so it is the established home for per-user
-- pointers. The web app owns the active-Environment UI state; the MCP takes environment_id
-- explicitly and reports this as a default (TDE-355).
alter table user_settings
  add column if not exists active_environment_id uuid references environments(id) on delete set null;

-- Backfill: one "Default" Environment per user who already owns projects, then point all of
-- that user's projects at it. Idempotent: skips users who already have any Environment.
with new_envs as (
  insert into environments (user_id, name, sort_order)
  select distinct p.user_id, 'Default', 0
  from projects p
  where p.user_id is not null
    and not exists (select 1 from environments e where e.user_id = p.user_id)
  returning id, user_id
)
update projects p
set environment_id = ne.id
from new_envs ne
where p.user_id = ne.user_id and p.environment_id is null;

-- Seed the active pointer to each user's Default so the app opens on a real Environment.
update user_settings us
set active_environment_id = e.id
from environments e
where e.user_id = us.user_id
  and e.name = 'Default'
  and us.active_environment_id is null;
