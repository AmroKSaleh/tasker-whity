-- MCP token economy (TDE-371): track when a user's heavy per-project context (Foundation +
-- Instruction Set + KB index) was last "primed" into an agent's context window, so get_task can
-- send it once per project per session and compact pointers thereafter instead of re-shipping
-- ~2k tokens of identical boilerplate on every call.
--
-- Written/read ONLY by the MCP edge function (service role, bypasses RLS). RLS enabled with no
-- policies = deny-all to normal clients, matching the org-table posture.
create table if not exists mcp_context_primed (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  primed_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
alter table mcp_context_primed enable row level security;
