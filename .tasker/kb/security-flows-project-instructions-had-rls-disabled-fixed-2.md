# Security: flows + project_instructions had RLS disabled — fixed (2026-07-05)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

GOTCHA found 2026-07-05 while mapping RLS for the org layer: the `flows` and `project_instructions` tables had ROW LEVEL SECURITY DISABLED (relrowsecurity=false, 0 policies) — meaning any authenticated user could read/write EVERY user's flows and instruction-sets via a crafted query. Pre-existing multi-tenant leak (the frontend only *asked* for own rows, but the DB wasn't enforcing it).

Fixed by migration 20260705100000_rls_hotfix_flows_instructions.sql: `enable row level security` + `own <table>` policy `using/with check (auth.uid() = user_id)` on both. Verified live: RLS on, 1 policy each; user confirmed Flows page + Instruction Sets still load.

Pre-flight that made it safe: (1) 0 rows with null user_id in either table (so no rows get hidden); (2) every write path already sets user_id — useInstructionSet.createEntry, FlowsPage duplicate/name-flow inserts, projectTransfer import (flows line 168, project_instructions line 224); MCP uses service role and bypasses RLS. 

LESSON: when adding a table with user data, ALWAYS enable RLS + owner policy in the same migration. Audit remaining tables for the same gap if touching security again. This fix is independent of the org/RBAC work (TDE-359) but was a prerequisite — you can't layer org access onto a table with no baseline owner enforcement.
