-- TDE-875: make the CHEAP board overview honest.
--
-- THE INCIDENT: get_project omits task Notes by default (TDE-319/371) because bodies are
-- the context-overflow cause. So the only affordable overview returns title + priority +
-- status. On WQW an agent read exactly that and wrote a status report asserting a security
-- entry vector "has not been closed" — false. The mitigation had shipped 10 days earlier;
-- the remainder was deliberately deferred. The body knew. Title and status did not.
--
-- Title and status are frequently the LEAST current fields on a task: titles are written
-- once, at creation, when the least is known; bodies accrete as work happens. The affordable
-- path was the one that misled, which is exactly backwards.
--
-- WHAT THIS ADDS, and the rule behind it: the overview must never GUESS. Two fields:
--
--   current_state  — a deliberately written one-line statement of where the task actually
--                    stands. Authoritative because a caller wrote it, not extracted.
--   field stamps   — text_updated_at / detail_updated_at, so we can tell that a body moved
--                    long after its title was written and say "open this one" instead.
--
-- Rejected on the way here: rendering the first N chars, or the last paragraph, of detail.
-- Both would have caught all four WQW cases — but only because that project's bodies happen
-- to accrete chronologically with status headings at the bottom. That is a habit of whoever
-- wrote them, not a property of Tasker. On a task whose body is a static spec the last
-- paragraph is the last spec bullet: noise, rendered confidently. A heuristic that is right
-- most of the time teaches the reader to trust it, which makes the remainder more dangerous
-- than no signal at all — the same failure as the stale title, moved down one layer.
-- So: either the task states its state, or it admits it cannot. Never a guess.

alter table tasks add column if not exists current_state text;
alter table tasks add column if not exists current_state_at timestamptz;
alter table tasks add column if not exists text_updated_at timestamptz not null default now();
alter table tasks add column if not exists detail_updated_at timestamptz not null default now();

comment on column tasks.current_state is
  'TDE-875: one-line "where this actually stands right now", written deliberately via update_task(current_state:). Rendered in the cheap get_project overview so a stale title cannot be the only thing a reader sees. Authoritative, never auto-extracted from detail.';
comment on column tasks.text_updated_at is
  'TDE-875: when the TITLE last changed. Paired with detail_updated_at to detect "body moved long after the title was written" — the stale-title signal.';
comment on column tasks.detail_updated_at is
  'TDE-875: when the BODY last changed.';

-- Backfill. text_updated_at = created_at is the honest reading: we have no record of title
-- edits, and a title is written at creation by default. detail_updated_at = updated_at for
-- rows that HAVE a body — the last edit is the best available proxy for when it last moved.
-- This deliberately errs toward over-flagging on legacy rows: an unnecessary body read costs
-- tokens, an unflagged stale title cost a wrong deliverable. The renderer's length + age
-- thresholds keep that from flagging the whole board.
update tasks set
  text_updated_at   = created_at,
  detail_updated_at = case
    when detail is not null and length(trim(detail)) > 0 then greatest(updated_at, created_at)
    else created_at
  end
where text_updated_at = detail_updated_at;   -- i.e. only rows still holding the column default

-- Extend the existing touch trigger (20260714213000, reworked 20260730120000) rather than
-- adding a second one: the suppress flag, the explicit-timestamp carve-out for Local Mode
-- flush, and now the per-field stamps all have to agree on ONE effective timestamp, and two
-- independent triggers would race to define it.
create or replace function touch_tasks_updated_at() returns trigger
language plpgsql as $$
declare v_at timestamptz;
begin
  -- Non-edit writes (see autostart_task) suppress the touch for their transaction.
  -- get_task's pending -> in_progress flip changes neither text nor detail, so nothing
  -- below would fire anyway; returning early keeps that guarantee explicit.
  if coalesce(current_setting('tasker.suppress_touch', true), '') = 'on' then
    return new;
  end if;

  -- One effective timestamp for the whole row. When the writer supplied updated_at itself
  -- (Local Mode flush carrying the file's own time), the field stamps must agree with it —
  -- otherwise a flushed edit would look older than the stamp recording it.
  if new.updated_at is not distinct from old.updated_at then
    v_at := now();
    new.updated_at := v_at;
  else
    v_at := new.updated_at;
  end if;

  -- Only stamp a field the writer did not stamp explicitly, and only when it really moved.
  if new.text is distinct from old.text
     and new.text_updated_at is not distinct from old.text_updated_at then
    new.text_updated_at := v_at;
  end if;
  if new.detail is distinct from old.detail
     and new.detail_updated_at is not distinct from old.detail_updated_at then
    new.detail_updated_at := v_at;
  end if;
  if new.current_state is distinct from old.current_state
     and new.current_state_at is not distinct from old.current_state_at then
    new.current_state_at := case when new.current_state is null then null else v_at end;
  end if;

  return new;
end $$;
