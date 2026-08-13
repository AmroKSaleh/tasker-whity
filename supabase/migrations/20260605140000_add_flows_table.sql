-- TDE-210: first-class flow identity
-- Flows have been emergent (derived from the I/O graph). This gives them a
-- stable ID, a human name, and a shared context bag all tasks in the flow share.

create table if not exists flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  context text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flows_user_id_idx on flows(user_id);
create index if not exists flows_project_id_idx on flows(project_id);

alter table tasks add column if not exists flow_id uuid references flows(id) on delete set null;
create index if not exists tasks_flow_id_idx on tasks(flow_id);
