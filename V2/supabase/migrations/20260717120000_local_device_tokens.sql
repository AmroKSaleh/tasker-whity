-- Local Mode: scoped device tokens (immediate-sync watcher, TDE-F2 v2).
-- A watch.mjs process runs for hours, so it needs a credential that outlives the
-- 15-min bundle token — but one that can ONLY pull/flush ONE project on ONE device.
-- We store only a SHA-256 hash of the secret; the plaintext is shown once at mint.
-- Design: docs/local-first-design.md D3/D7 (the deferred watcher, now built).
-- Idempotent — safe to re-run.

create table if not exists local_device_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  device_id text not null,
  token_hash text not null unique,      -- sha256 hex of the secret; secret never stored
  label text,                           -- human hint (e.g. "desktop-repo watcher")
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz                -- non-null = dead
);
create index if not exists local_device_tokens_hash on local_device_tokens(token_hash);
create index if not exists local_device_tokens_proj on local_device_tokens(project_id, user_id);

alter table local_device_tokens enable row level security;

drop policy if exists local_device_tokens_owner on local_device_tokens;
create policy local_device_tokens_owner on local_device_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
