-- SECURITY HOTFIX (found 2026-07-05, independent of the org layer): the `flows` and
-- `project_instructions` tables had RLS DISABLED and no policies — meaning any authenticated
-- user could read/write EVERY user's flows and instruction-sets, not just their own.
-- Enable RLS + an owner-scoped policy, matching every other user-data table.
-- Safe: verified 0 rows with null user_id, and all write paths (web hooks, FlowsPage,
-- projectTransfer import; MCP uses service role and bypasses RLS) already set user_id.

alter table flows enable row level security;
drop policy if exists "own flows" on flows;
create policy "own flows" on flows for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table project_instructions enable row level security;
drop policy if exists "own project_instructions" on project_instructions;
create policy "own project_instructions" on project_instructions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
