-- TDE-295: personal default Instruction Sets that auto-seed new projects.
-- A user-level store of reusable IS entries (code style, deploy rules, tone, autonomy).
-- The baseline trigger (seed_baseline_instructions) is extended to copy these into every
-- new project after the built-in baseline — so they apply on every creation path
-- (create_project, bootstrap, manual UI, import*). Phase 1 = personal/single-user;
-- org/shared defaults are Phase 2 B2B.
--   * import deletes the trigger-seeded IS and restores the bundle's own IS — correct,
--     an imported project keeps its source IS verbatim.

create table if not exists default_instructions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  content    text not null,
  universal  boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists default_instructions_user_idx on default_instructions(user_id);

alter table default_instructions enable row level security;

drop policy if exists "own default_instructions" on default_instructions;
create policy "own default_instructions" on default_instructions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Extend the baseline seeder: keep the built-in baseline, then append the user's
-- personal defaults (in their chosen order). SECURITY DEFINER already lets it read
-- default_instructions regardless of the caller's RLS context.
create or replace function seed_baseline_instructions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into project_instructions (project_id, user_id, title, content, universal)
  values
    (
      new.id,
      new.user_id,
      'Task hygiene',
      $md$- Refer to tasks by their short ID (e.g. ABC-12), never UUIDs. Don't renumber tasks — the app handles ordering.
- When listing several tasks, group them by section.
- Set a task to in_progress when you start it; mark it done only when the work is genuinely and verifiably complete — otherwise leave it in_progress.$md$,
      true
    ),
    (
      new.id,
      new.user_id,
      'Working preferences',
      $md$- For read-only requests (list / show / search), act directly — don't ask clarifying questions first.
- When a request is ambiguous, take the most reasonable interpretation and proceed, stating the assumption you made.
- Pause to confirm only for destructive or outward-facing actions (deleting, bulk changes, pushing to a remote, publishing).
- Report outcomes honestly — if something failed, was skipped, or is unverified, say so plainly.$md$,
      false
    );

  -- Personal default Instruction Sets (TDE-295) — seeded after the baseline.
  insert into project_instructions (project_id, user_id, title, content, universal)
  select new.id, new.user_id, d.title, d.content, d.universal
  from default_instructions d
  where d.user_id = new.user_id
  order by d.sort_order, d.created_at;

  return new;
end;
$$;
