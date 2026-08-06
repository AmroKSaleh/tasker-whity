-- Repair: the two TDE-875 migrations wiped tasks.updated_at across the whole table.
--
-- WHAT HAPPENED. 20260806120000 and 20260806133000 each ran a bare `update tasks set ...`.
-- touch_tasks_updated_at fires BEFORE UPDATE and stamps now() whenever the writer did not set
-- updated_at itself — which a maintenance UPDATE never does. So both migrations restamped
-- every row they touched, and the first touched all of them. Every task in the database
-- reported "last edited 2026-08-06" regardless of when it was really last worked.
--
-- This is the exact failure 20260730120000 was written to prevent — its comment reads "A
-- survey of N tasks restamped all N as edited-just-now." It added tasker.suppress_touch for
-- this purpose. Neither TDE-875 migration used it. See the last block of this file.
--
-- WHY IT IS RECOVERABLE. 20260806120000 computed detail_updated_at from the OLD row:
--   detail_updated_at = greatest(updated_at, created_at)
-- The SET expression reads pre-UPDATE values, so it captured the true updated_at a moment
-- before the trigger destroyed it. 20260806133000 changed only text_updated_at, and the
-- trigger stamps detail_updated_at solely when detail itself changes — so the captured value
-- survived intact. detail_updated_at is, for now, a snapshot of the old updated_at.
--
-- That window closes on each task's next body edit, which is why this runs now.
--
-- SCOPE, and what stays broken. Only rows with a real body carry a recoverable value; for an
-- empty-detail row the same expression stored created_at, which is not the lost timestamp.
-- Those keep today's stamp rather than being given a second fabricated value — the same
-- reasoning that removed the invented backfill in 20260806133000. Their true last-edit time
-- is gone and is not being guessed at.
--
-- The upper bound leaves alone anything genuinely edited today (the four WQW state lines,
-- TDE-875, the TDE-862/863 completions), whose current updated_at is real.

select set_config('tasker.suppress_touch', 'on', true);

update tasks set updated_at = detail_updated_at
where detail is not null
  and length(trim(detail)) > 0
  and detail_updated_at < timestamptz '2026-08-06T20:00:00Z';

-- Setting updated_at explicitly would already defeat the trigger (new is distinct from old),
-- but suppress_touch is set above regardless: relying on the value happening to differ is the
-- reasoning that caused this, and the flag states the intent instead of depending on it.
--
-- THE RULE, for every future migration in this repo: any UPDATE against tasks that is
-- MAINTENANCE rather than a real edit must open with
--     select set_config('tasker.suppress_touch', 'on', true);
-- or it silently destroys the last-edited read surface for every row it touches. A backfill
-- is not an edit, and updated_at is a field users and agents read.
