-- Conductor: task provenance so a connector's "placed" tab can show the tasks it
-- produced. Set at import time (IntakePanel/Conductor.importTasks).
alter table tasks add column if not exists intake_source text;          -- e.g. 'gmail'
alter table tasks add column if not exists intake_job_id uuid references intake_jobs(id) on delete set null;
create index if not exists tasks_intake_source_idx on tasks(user_id, intake_source);

-- Lifecycle clarification for intake_jobs.status:
--   pending | processing  → in-flight (agent working)
--   ready                 → parked    (agent submitted proposals, not yet placed)
--   imported              → placed     (user imported into a project)
--   error                 → failed
-- Older rows used 'done' for the parked (post-submit, pre-import) state — backfill
-- them to 'ready' so nothing is mistaken for placed. submit_intake_result now writes
-- 'ready'; importTasks writes 'imported'.
update intake_jobs set status = 'ready' where status = 'done';
