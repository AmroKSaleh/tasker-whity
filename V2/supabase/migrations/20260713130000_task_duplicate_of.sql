-- TDE-379: duplicate defense. merge_task_as_duplicate folds a duplicate task into a canonical one.
-- duplicate_of records the canonical target so a merged dup closes with a DISTINCT outcome (not a
-- plain "done") and stays traceable across sessions/agents. Additive.
alter table tasks add column if not exists duplicate_of uuid references tasks(id) on delete set null;
create index if not exists tasks_duplicate_of_idx on tasks(duplicate_of) where duplicate_of is not null;
