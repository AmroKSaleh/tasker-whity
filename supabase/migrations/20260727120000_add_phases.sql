-- TDE-804: PHASES — condition-bounded project stages.
--
-- A phase is a stage of a project bounded by an EXIT CONDITION, not a date
-- ("Phase 1 ends when we launch"). due_date is optional decoration. That is what
-- separates a phase from a sprint/cycle (calendar-bounded, uniformly repeating —
-- see TDE-785, deliberately NOT built).
--
-- Hierarchy note: a phase is an ORTHOGONAL axis to sections, not a new level.
-- Sections are categorical (kind of work: Bugs, QoL); phases are temporal (when:
-- now / after launch). A phase view is the normal sectioned board, filtered.
--
-- ADDITIVE and OPT-IN: a project with zero phases behaves exactly as today, since
-- every task's phase_id stays null and the aggregate bar has a single unphased
-- segment. Reversible by dropping the two columns and the table.

create table if not exists phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  -- The honesty guardrail, not decoration: stating "this phase ends when X" forces a
  -- statement of what is actually REQUIRED, so unrequired work falls out to a later
  -- phase. Without it the temptation is to spread tasks evenly and change only the readout.
  exit_condition text,
  due_date date,
  -- Forward-compat for Local Mode: .tasker/ files reference structure by STABLE slug
  -- (TDE-713), so phases carry one from birth. Nothing syncs phases yet — this exists
  -- so enabling it later does not need a second migration + backfill.
  slug text,
  created_at timestamptz not null default now()
);
create index if not exists phases_project_id_idx on phases(project_id);

-- Project-scoped tables authorize via can_access_project (org/RBAC aware), matching the
-- current sections/groups/tasks policies from 20260705120000_org_rls_policies.sql.
-- can_access_project does not self-reference phases, so INSERT…RETURNING is safe here
-- (cf. the "SELECT policy self-reference breaks RETURNING" gotcha in the KB).
alter table phases enable row level security;
create policy "phases access" on phases for all
  using (can_access_project(project_id)) with check (can_access_project(project_id));

-- Safety net for rows inserted without an explicit slug (web-app inserts). Uniqueness
-- within a project is enforced application-side, same as sections/groups.
create or replace function set_phase_slug() returns trigger
language plpgsql as $$
begin
  if new.slug is null then
    new.slug := tasker_slugify(new.name);
  end if;
  return new;
end $$;

drop trigger if exists phases_slug_trigger on phases;
create trigger phases_slug_trigger before insert on phases
  for each row execute function set_phase_slug();

-- NULLABLE BY DESIGN — an unphased task is a first-class, permanent state, not a
-- triage queue. A wrongly-stamped task lies; an unstamped one honestly admits it is
-- unsorted, and plenty of work (idea inventories, evergreen items) legitimately
-- belongs to no phase. There is deliberately NO auto-stamping and NO backfill.
--
-- ON DELETE SET NULL: deleting a phase UNPHASES its tasks rather than destroying them.
alter table tasks
  add column if not exists phase_id uuid references phases(id) on delete set null;
create index if not exists tasks_phase_id_idx on tasks(phase_id);

-- The active-phase pointer lives on the project, NOT as an is_active boolean on phases:
-- one column is a single source of truth and cannot represent "two phases active at
-- once", where a boolean needs a partial unique index to enforce the same invariant.
-- Mirrors the established user_settings.active_environment_id precedent (TDE-354).
alter table projects
  add column if not exists active_phase_id uuid references phases(id) on delete set null;
