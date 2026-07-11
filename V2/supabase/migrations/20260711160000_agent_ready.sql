-- "Hand to agent" (Path A of Tasker-triggers-agent-work). A human marks a task ready for
-- autonomous work in the web app; a looping/scheduled agent pulls ready tasks via get_ready_work
-- and works them. The pull half of the loop (webhooks/TDE-377 make it instant later). Additive.
alter table tasks add column if not exists agent_ready boolean not null default false;
alter table tasks add column if not exists agent_ready_at timestamptz;
create index if not exists tasks_agent_ready_idx on tasks(user_id, agent_ready) where agent_ready = true;
