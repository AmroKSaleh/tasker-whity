-- Make tasks.updated_at trustworthy as a "last edited" time, so it can be read.
--
-- updated_at has existed since 20260714213000 as Local Mode's LWW anchor, and the
-- touch trigger stamps now() on every UPDATE unless the writer set it explicitly.
-- Correct for edits — but get_task's pending -> in_progress autostart is also an
-- UPDATE, so merely READING a task overwrote its last-edit time. A survey of N
-- tasks restamped all N as edited-just-now.
--
-- Passing the old value back does not solve it: the trigger tests
--   new.updated_at is not distinct from old.updated_at
-- which is TRUE when the writer re-sends the identical value, so it stamps anyway.
-- Hence an explicit, transaction-local suppression flag for writes that are not edits.

create or replace function touch_tasks_updated_at() returns trigger
language plpgsql as $$
begin
  -- Non-edit writes (see autostart_task) suppress the touch for their transaction.
  -- Every other write keeps the original behavior.
  if coalesce(current_setting('tasker.suppress_touch', true), '') = 'on' then
    return new;
  end if;
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- get_task's autostart: flip pending -> in_progress without counting as an edit.
-- The flip is still auditable — recordLifecycleChange logs it (TDE-819); what is
-- suppressed is only the claim that the task's CONTENT changed.
-- set_config(..., true) scopes the flag to this transaction. Guarded on status so a
-- concurrent start/complete cannot be clobbered, and scoped by user_id even though
-- the MCP calls this with the service-role key.
create or replace function autostart_task(p_task_id uuid, p_user_id uuid)
returns timestamptz
language plpgsql as $$
declare v_updated_at timestamptz;
begin
  perform set_config('tasker.suppress_touch', 'on', true);
  update tasks set status = 'in_progress'
    where id = p_task_id and user_id = p_user_id and status = 'pending'
    returning updated_at into v_updated_at;
  return v_updated_at;
end $$;

grant execute on function autostart_task(uuid, uuid) to service_role;

-- Reads of "what changed lately" scan by recency within a project.
create index if not exists tasks_project_updated_at_idx on tasks (project_id, updated_at desc);
