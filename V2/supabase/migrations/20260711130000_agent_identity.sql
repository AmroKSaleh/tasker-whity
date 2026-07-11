-- Agent identity & delegation (TDE-375). Makes "state persists across sessions, agents, and
-- people" true in the data: every write can be attributed to WHICH agent, and a task can be
-- delegated to an agent while the human stays the owner. Additive only.

-- Which agent/client an API key represents (e.g. "Claude Code", "Cursor"). Token-derived so it
-- can't be spoofed by the calling agent. Populated per-key; null = unlabeled key.
alter table user_api_keys add column if not exists agent_label text;

-- Who a task is delegated to. Distinct from ownership: user_id STAYS the owner and owns the gate;
-- delegated_to is who is doing the work. Free text for now (no member directory yet).
alter table tasks add column if not exists delegated_to text;
