-- Org layer foundation (TDE-359, Phase A — ADDITIVE ONLY).
-- New tables + a nullable environments.org_id. This migration deliberately does NOT touch any
-- existing table's RLS: personal data stays exactly as it is. The access-check function + the
-- RLS rewrite + MCP in-code enforcement are the NEXT, separately-tested step. The new tables
-- get RLS enabled with NO policies yet (deny-all to normal users; only service_role reaches
-- them) — nothing in the app reads them until the access model lands, so this is the safe posture.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table organizations enable row level security;

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',    -- 'admin' | 'member' (owner tracked via organizations.owner_user_id)
  status text not null default 'active',  -- 'active' | 'invited'
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
alter table organization_members enable row level security;

-- Environments become dual-owned: org_id NULL = personal (today's model), set = org-shared.
-- ON DELETE CASCADE: deleting an org removes its shared environments; their projects fall back
-- to environment_id = null (projects.environment_id is ON DELETE SET NULL from TDE-354).
alter table environments
  add column if not exists org_id uuid references organizations(id) on delete cascade;

create table if not exists environment_grants (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references environments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer',    -- 'viewer' | 'editor' | 'admin'
  created_at timestamptz not null default now(),
  unique (environment_id, user_id)
);
alter table environment_grants enable row level security;

-- Indexes for the access checks added in the next step.
create index if not exists organization_members_user_idx on organization_members(user_id);
create index if not exists organization_members_org_idx  on organization_members(org_id);
create index if not exists environment_grants_user_idx    on environment_grants(user_id);
create index if not exists environment_grants_env_idx      on environment_grants(environment_id);
create index if not exists environments_org_id_idx         on environments(org_id);
