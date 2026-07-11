-- "Awaiting confirmation" (prepare → confirm → execute). During the ready-work loop the agent
-- prepares a task fully and records its proposed work here; the web app's Agent Queue
-- "Awaiting confirmation" tab shows tasks that have a proposal, so the human can see what's ready
-- to green-light. Cleared on execute (or decline). Additive.
alter table tasks add column if not exists agent_proposal text;
alter table tasks add column if not exists agent_proposal_at timestamptz;
create index if not exists tasks_agent_proposal_idx on tasks(project_id, agent_proposal_at desc) where agent_proposal is not null;
