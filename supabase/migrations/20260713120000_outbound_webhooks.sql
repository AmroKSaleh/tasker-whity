-- TDE-377 (Path B): outbound webhooks. Tasker fires a signed HTTP POST to a user-configured
-- URL when a task/review event happens — turning Tasker from pull-only into a system that can
-- TRIGGER agent runs. Payload anatomy + HMAC discipline copied from Linear's proven shape.
-- Delivery is decoupled: mutations ENQUEUE into webhook_deliveries; a pg_cron drain (separate
-- migration) POSTs with the retry ladder. All additive.

create extension if not exists pgcrypto;

-- One (or more) endpoints per user; project_id null = fires for every project.
create table if not exists webhooks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  project_id    uuid references projects(id) on delete cascade,
  url           text not null,
  secret        text not null,                       -- per-webhook HMAC signing secret
  events        text[] not null default '{task.updated,task.completed,review.submitted}',
  active        boolean not null default true,
  failure_count int not null default 0,              -- consecutive dead deliveries; resets on success
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists webhooks_user_idx on webhooks(user_id);

-- Append-only delivery queue. The drain reads pending rows whose next_attempt_at has arrived.
create table if not exists webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  webhook_id      uuid not null references webhooks(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'pending',   -- pending | delivered | dead
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  response_status int,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
-- Drain hot path: due pending rows, oldest first.
create index if not exists webhook_deliveries_due_idx
  on webhook_deliveries(next_attempt_at)
  where status = 'pending';
create index if not exists webhook_deliveries_webhook_idx on webhook_deliveries(webhook_id);
create index if not exists webhook_deliveries_user_idx on webhook_deliveries(user_id, created_at desc);

-- RLS. The web app (user JWT) manages webhooks and reads its own delivery log; the MCP function
-- (service role) bypasses RLS to enqueue. Service role also does all sending in the dispatch fn.
alter table webhooks enable row level security;
alter table webhook_deliveries enable row level security;

drop policy if exists webhooks_owner_all on webhooks;
create policy webhooks_owner_all on webhooks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists webhook_deliveries_owner_read on webhook_deliveries;
create policy webhook_deliveries_owner_read on webhook_deliveries
  for select using (user_id = auth.uid());

-- Test-fire from Settings inserts a delivery for a webhook the user owns.
drop policy if exists webhook_deliveries_owner_insert on webhook_deliveries;
create policy webhook_deliveries_owner_insert on webhook_deliveries
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from webhooks w where w.id = webhook_id and w.user_id = auth.uid())
  );
