-- View / edit / confirm the agent's proposal in the web app (prepare → confirm → execute).
-- When the human confirms a prepared proposal, agent_proposal_confirmed flips true; the agent then
-- executes the (possibly human-edited) agent_proposal on its next run and clears both. Additive.
alter table tasks add column if not exists agent_proposal_confirmed boolean not null default false;
