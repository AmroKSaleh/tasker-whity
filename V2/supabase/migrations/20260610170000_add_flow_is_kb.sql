-- TDE-233: flow-level Instruction Sets & Knowledge Bases
-- Flows get their own IS (governs flow tasks, replacing non-universal project IS)
-- and KB (auto-injected on every flow task). project_instructions gains a `universal`
-- flag for rules that always apply even inside a flow.
-- Mirrors project_instructions / project_knowledge, keyed by flow_id (cascade on flow delete).

create table if not exists flow_instructions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  flow_id uuid not null references flows(id) on delete cascade,
  title text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flow_instructions_flow_id_idx on flow_instructions(flow_id);
create index if not exists flow_instructions_user_id_idx on flow_instructions(user_id);

create table if not exists flow_knowledge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  flow_id uuid not null references flows(id) on delete cascade,
  title text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flow_knowledge_flow_id_idx on flow_knowledge(flow_id);
create index if not exists flow_knowledge_user_id_idx on flow_knowledge(user_id);

-- Mark project IS rules that always apply, even inside a flow with its own IS.
alter table project_instructions add column if not exists universal boolean not null default false;

-- RLS: per-user access (the MCP uses the service key and bypasses these; this protects
-- any direct app/anon access and keeps parity with the project-level tables).
alter table flow_instructions enable row level security;
alter table flow_knowledge   enable row level security;

drop policy if exists "own flow_instructions" on flow_instructions;
create policy "own flow_instructions" on flow_instructions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own flow_knowledge" on flow_knowledge;
create policy "own flow_knowledge" on flow_knowledge
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
