create table if not exists project_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  health text not null check (health in ('on_track', 'at_risk', 'off_track')),
  status text not null check (status in ('draft', 'published')) default 'draft',
  body text not null,
  delta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Index for fetching latest project updates efficiently
create index if not exists project_updates_project_id_idx on project_updates (project_id, created_at desc);

-- RLS
alter table project_updates enable row level security;

create policy "Users can read their own project updates"
  on project_updates for select
  using (auth.uid() = user_id);

create policy "Users can insert their own project updates"
  on project_updates for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own project updates"
  on project_updates for update
  using (auth.uid() = user_id);

create policy "Users can delete their own project updates"
  on project_updates for delete
  using (auth.uid() = user_id);
