-- Seeds (TDE): a Seed is a task whose deliverable is ANOTHER Tasker artifact — a
-- concrete task or a flow — produced once the user resolves its open context.
-- bootstrap_project's population phase emits concrete tasks + flow seeds + context
-- seeds. Resolving a seed spawns the real artifact and links it back (provenance).
alter table tasks add column if not exists kind text not null default 'normal';        -- 'normal' | 'seed'
alter table tasks add column if not exists seed_target text;                            -- 'task' | 'flow' (seeds only)
alter table tasks add column if not exists seed_open_questions jsonb;                    -- string[] — the gaps blocking specification
alter table tasks add column if not exists spawned_from_seed_id uuid references tasks(id) on delete set null;  -- on the spawned artifact

create index if not exists tasks_kind_idx on tasks(project_id, kind) where kind = 'seed';
