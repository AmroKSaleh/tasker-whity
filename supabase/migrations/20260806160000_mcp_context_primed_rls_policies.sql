-- TDE-870: get_task re-sent the full project context (Foundation + Instruction Set + KB index)
-- on EVERY call, ~3k tokens each, measured at ~29% of all Tasker token spend in a session.
--
-- ROOT CAUSE. The once-per-session suppression works by checking a priming row in
-- mcp_context_primed. That table was created by TDE-371 with RLS enabled and NO policies, and
-- its own comment states the assumption: "Written/read ONLY by the MCP edge function (service
-- role, bypasses RLS). RLS enabled with no policies = deny-all to normal clients."
--
-- That assumption held when it was written. It stopped holding when tool dispatch moved to
-- getScopedClient() — the org/RBAC work made every MCP tool run under a short-lived
-- role=authenticated JWT with the ANON key, precisely so per-user permissions get enforced.
-- Correct change; it just silently invalidated one table's premise. Deny-all now applies to the
-- MCP itself.
--
-- So on every get_task: the SELECT returns zero rows (filtered, not errored), the code reads
-- that as "not primed yet" and sends the full block, then the upsert is denied and no row is
-- ever written. __init_tasker_session's reset DELETE was failing for the same reason, which
-- would have masked the fix if only read/write were granted here.
--
-- WHY IT HID FOR A MONTH: every failure in this path is silent. A row-level denial is not an
-- error — the SELECT simply returns nothing, which is indistinguishable from "no note yet".
-- The upsert's error was discarded by fireAndForget. Nothing appeared in any log. The
-- companion code change makes these loud; this migration makes them unnecessary.
--
-- THE FIX. Own-row policies, matching how every other user-scoped table behaves under the
-- scoped client. auth.uid() equals the JWT's sub, which getScopedClient sets to the resolved
-- user id. No service-role special-casing, so this cannot drift out of sync again the next
-- time the client posture changes.

drop policy if exists "own context priming" on mcp_context_primed;
create policy "own context priming" on mcp_context_primed
  for select using (user_id = auth.uid());

drop policy if exists "own context priming insert" on mcp_context_primed;
create policy "own context priming insert" on mcp_context_primed
  for insert with check (user_id = auth.uid());

-- upsert needs UPDATE as well as INSERT: the second priming of the same (user, project) is an
-- ON CONFLICT DO UPDATE, which is checked against the update policy, not the insert one.
drop policy if exists "own context priming update" on mcp_context_primed;
create policy "own context priming update" on mcp_context_primed
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- __init_tasker_session clears the user's priming rows to start a fresh session. Without this
-- the suppression would latch on after the first fix and never reset.
drop policy if exists "own context priming delete" on mcp_context_primed;
create policy "own context priming delete" on mcp_context_primed
  for delete using (user_id = auth.uid());
