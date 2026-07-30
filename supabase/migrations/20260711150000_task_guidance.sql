-- Pending guidance (TDE-383). A human leaves a steering note on a task from the inspector; the
-- agent picks it up on its NEXT get_task — next session, without re-prompting. Attention that
-- persists across sessions: the human directs while the agent is away. Additive.
create table if not exists task_guidance (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz                        -- set when an agent surfaces it via get_task
);
create index if not exists task_guidance_task_idx on task_guidance(task_id, created_at desc);
create index if not exists task_guidance_unconsumed_idx on task_guidance(user_id, task_id) where consumed_at is null;

alter table task_guidance enable row level security;
drop policy if exists "task_guidance access" on task_guidance;
create policy "task_guidance access" on task_guidance for select
  using (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "task_guidance insert" on task_guidance;
create policy "task_guidance insert" on task_guidance for insert
  with check (user_id = auth.uid() or can_access_task(task_id));
drop policy if exists "task_guidance update" on task_guidance;
create policy "task_guidance update" on task_guidance for update
  using (user_id = auth.uid() or can_access_task(task_id))
  with check (user_id = auth.uid() or can_access_task(task_id));

alter publication supabase_realtime add table task_guidance;
