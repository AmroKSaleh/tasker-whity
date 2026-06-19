-- Intake broker: the web app captures a source (e.g. a Gmail email via "+Task")
-- as a pending job; the user's agent (CC/Cursor) pulls it via MCP, structures it,
-- and posts the result back; the web app renders it live (realtime) for review +
-- import. Keeps the AI in the agent, not the web app.
create table if not exists intake_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'gmail',
  payload jsonb not null,                 -- the captured content (e.g. the email)
  instructions text,                      -- optional human guidance
  status text not null default 'pending', -- pending | processing | done | error
  result jsonb,                           -- { analysis, tasks: [...] } from the agent
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists intake_jobs_user_status_idx on intake_jobs(user_id, status, created_at);

-- RLS: a user sees/creates/updates only their own jobs (the web app uses the authed
-- user; the MCP uses the service role and bypasses RLS).
alter table intake_jobs enable row level security;
create policy "intake own select" on intake_jobs for select using (auth.uid() = user_id);
create policy "intake own insert" on intake_jobs for insert with check (auth.uid() = user_id);
create policy "intake own update" on intake_jobs for update using (auth.uid() = user_id);

-- Realtime so the web app's red box updates the moment the agent posts the result.
alter publication supabase_realtime add table intake_jobs;
