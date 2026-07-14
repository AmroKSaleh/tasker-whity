-- Local Mode v1 (TDE-409): sync spine for local-first projects.
-- Design: V2/docs/local-first-design.md (D3 cursor, D4 tombstones, D8 ID leases).
-- Idempotent — safe to re-run.

alter table projects add column if not exists local_mode boolean not null default false;
alter table projects add column if not exists local_revision bigint not null default 0;
alter table tasks add column if not exists local_rev bigint not null default 0;

-- Delete propagation (D4): flush records deletions here; pull returns rows > cursor.
create table if not exists local_tombstones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  task_id uuid not null,
  short_id text,
  local_rev bigint not null,
  deleted_at timestamptz not null default now()
);
create index if not exists local_tombstones_proj_rev on local_tombstones(project_id, local_rev);

-- Offline-safe short-ID blocks (D8): pull leases a block per device.
create table if not exists local_id_leases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  device_id text not null,
  lease_start integer not null,
  lease_end integer not null,
  created_at timestamptz not null default now()
);
create index if not exists local_id_leases_proj_dev on local_id_leases(project_id, device_id);

alter table local_tombstones enable row level security;
alter table local_id_leases enable row level security;

drop policy if exists local_tombstones_owner on local_tombstones;
create policy local_tombstones_owner on local_tombstones
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists local_id_leases_owner on local_id_leases;
create policy local_id_leases_owner on local_id_leases
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Cursor stamping (D3): every task write on a local_mode project bumps the
-- project's monotonic revision and stamps the row, so pull can answer
-- "changes since cursor". SECURITY DEFINER so the projects bump never trips
-- RLS when the write comes from an authenticated web session.
create or replace function bump_local_rev() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rev bigint;
begin
  update projects set local_revision = local_revision + 1
    where id = new.project_id and local_mode = true
    returning local_revision into v_rev;
  if v_rev is not null then
    new.local_rev := v_rev;
  end if;
  return new;
end $$;

drop trigger if exists tasks_local_rev on tasks;
create trigger tasks_local_rev before insert or update on tasks
  for each row execute function bump_local_rev();
