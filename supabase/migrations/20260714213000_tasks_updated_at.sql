-- Local Mode (TDE-410): tasks.updated_at — the per-task LWW anchor (D4).
-- The touch trigger only stamps now() when the writer did NOT explicitly set
-- updated_at, so flush can carry the file's own timestamp while ordinary web
-- app edits auto-touch.

alter table tasks add column if not exists updated_at timestamptz not null default now();

create or replace function touch_tasks_updated_at() returns trigger
language plpgsql as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch_updated_at on tasks;
create trigger tasks_touch_updated_at before update on tasks
  for each row execute function touch_tasks_updated_at();
