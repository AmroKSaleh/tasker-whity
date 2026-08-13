-- TDE-782: Give tasks and ISs tags

-- Add tags to tasks
alter table tasks add column if not exists tags text[] not null default '{}'::text[];

-- Add tags to Instruction Sets
alter table project_instructions add column if not exists tags text[] not null default '{}'::text[];
alter table flow_instructions add column if not exists tags text[] not null default '{}'::text[];
alter table default_instructions add column if not exists tags text[] not null default '{}'::text[];

-- Create GIN indexes for fast array queries (overlap, containment, etc.)
create index if not exists tasks_tags_idx on tasks using gin (tags);
create index if not exists project_instructions_tags_idx on project_instructions using gin (tags);
create index if not exists flow_instructions_tags_idx on flow_instructions using gin (tags);
create index if not exists default_instructions_tags_idx on default_instructions using gin (tags);

-- Optional: trigger schema cache refresh if we use PostgREST (Supabase standard)
-- notify pgrst, 'reload schema';
