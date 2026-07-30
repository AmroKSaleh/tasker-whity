-- Agent session ledger (TDE-374). The durable, human-inspectable record of what an
-- agent actually did on a task — provenance that persists across sessions/agents/people,
-- the core of Tasker's wedge. Two tables:
--   agent_sessions   — one per contiguous agent engagement on a task (the render substrate
--                      TDE-375 attribution, TDE-382 review narrative, TDE-383 attention pull sit on).
--   agent_activities — the append-only, IMMUTABLE typed entries within a session.
-- Lifecycle state (active / awaiting_input / error / stale / complete) is DERIVED at read
-- time from the last entry — never a hand-managed column here (see get_task_activity in the MCP).
-- ADDITIVE only. The MCP runs as service role and bypasses RLS; the web app runs under the
-- user JWT and relies on these policies. can_access_task() already exists (20260705120000).

create table if not exists agent_sessions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor text,                                   -- which agent/client (e.g. "Claude Code"); fully populated in TDE-375
  opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz                         -- null = open; set when the engagement ends
);
create index if not exists agent_sessions_task_idx on agent_sessions(task_id, opened_at desc);
create index if not exists agent_sessions_open_idx on agent_sessions(task_id, user_id) where closed_at is null;

create table if not exists agent_activities (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references agent_sessions(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,   -- denormalized for cross-task pulls (TDE-383)
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('progress','action','question','result','error')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_activities_session_idx on agent_activities(session_id, created_at);
create index if not exists agent_activities_task_idx on agent_activities(task_id, created_at desc);

-- Immutability: activities are frozen snapshots — the whole point vs an editable comment.
-- The MCP is service role (bypasses RLS), so append-only cannot rely on policies alone; a
-- trigger hard-rejects UPDATE. DELETE is intentionally NOT trigger-blocked so the
-- `on delete cascade` from tasks still works; the web app is blocked from deleting by the
-- absence of a delete policy, and no MCP tool deletes activities.
create or replace function reject_agent_activity_update()
returns trigger language plpgsql as $$
begin
  raise exception 'agent_activities is append-only (TDE-374): UPDATE is not allowed';
end;
$$;
drop trigger if exists agent_activities_no_update on agent_activities;
create trigger agent_activities_no_update before update on agent_activities
  for each row execute function reject_agent_activity_update();

-- RLS: owner OR org-granted access to the parent task (mirrors task_discussions).
alter table agent_sessions enable row level security;
drop policy if exists "agent_sessions access" on agent_sessions;
create policy "agent_sessions access" on agent_sessions for select
  using (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "agent_sessions insert" on agent_sessions;
create policy "agent_sessions insert" on agent_sessions for insert
  with check (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "agent_sessions update" on agent_sessions;
create policy "agent_sessions update" on agent_sessions for update
  using (user_id = auth.uid() or can_access_task(task_id))
  with check (user_id = auth.uid() or can_access_task(task_id));
-- (no delete policy — sessions are removed only via task cascade)

alter table agent_activities enable row level security;
drop policy if exists "agent_activities access" on agent_activities;
create policy "agent_activities access" on agent_activities for select
  using (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "agent_activities insert" on agent_activities;
create policy "agent_activities insert" on agent_activities for insert
  with check (user_id = auth.uid() or can_access_task(task_id));
-- (no update/delete policies — immutable; the trigger also hard-blocks UPDATE)

-- Realtime so the web inspector (milestone 3) renders the thread live as entries land.
alter publication supabase_realtime add table agent_sessions;
alter publication supabase_realtime add table agent_activities;
