# MCP handler audit (2026-07-31) — 139 tools, ~29k always-loaded tokens, one real authorization hole

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

First full pass over `supabase/functions/mcp/index.ts` (9,141 lines). Run as one audit serving three tasks that were tracked separately but are the same job: TDE-817 (what do all these tools do), TDE-378 (token diet), TDE-780 (security). Method: deterministic extraction of the TOOLS array + the dispatch switch, then hand-reading the residue. Scripts are throwaway; the numbers below are the durable part.

## The shape of the surface
- 139 tools declared, 139 handlers. No orphans in either direction — every declared tool has a handler and vice versa.
- 312 database query sites across the handlers.
- The edge function runs as SERVICE ROLE (index.ts:11), so RLS is bypassed everywhere. Ownership is enforced ONLY by hand-written filters in TypeScript.

## Token census (TDE-378)
- Tool definitions total ~29,240 tokens, loaded into every session before the agent does anything.
- Split: ~10,850 tokens of prose descriptions, ~17,000 tokens of inputSchema. THE SCHEMAS ARE THE BIGGER HALF — this matters because the obvious fix (trim descriptions, which is Linear's stated countermeasure) addresses only ~37% of the cost. The weight is in long per-parameter `description` fields inside inputSchema.
- Concentration: the top 37 tools carry 50% of the total.
- By domain: Flows/contracts/validation is 34 tools and ~7,970 tokens = 27% of the whole surface. Tasks & intake is 23 tools / ~6,780t. Everything else is under 1,800t per domain.
- Reference point: Linear ships ~42 tools / ~12.8k tokens and gets publicly criticised for it. Tasker is ~3.3x the tool count and ~2.3x the tokens.
- STRATEGIC NOTE: the single largest consolidation target (Flows, 27%) is the subsystem whose design is currently unsettled pending the rebuild-or-refine decision. Consolidating it before that lands means doing it twice.

## Authorization audit (TDE-780) — the headline result
ONE confirmed hole out of 139 handlers. Everything else is correctly scoped.

CONFIRMED: `pull_google_task` (index.ts:6001) takes `section_id` from args and queries `sections` by id with no ownership check of any kind, then inserts a task into that section's project. Cross-tenant WRITE — attacker-controlled content lands on another user's board. Tracked as its own task. Harmless with one user; live at launch.

Everything else that the crude detector flagged (176 "unscoped" query sites, 85 handlers) turned out to be false positives of two legitimate patterns:
1. FETCH-THEN-MUTATE — select with `.eq('user_id', userId)`, bail if not found, then update/delete by primary key. The mutation looks unscoped in isolation but is guarded by the preceding check. Used by rename_environment, delete_environment, pull_intake_job, submit_intake_result, the KB/IS entry_id handlers, and many more.
2. TRANSITIVE SCOPING — resolveProject/resolveTask/resolveGroup establishes ownership, then everything downstream is scoped by `.eq('project_id', project.id)`. Correct, and it is how `sections`, `groups` and `phases` are protected (those tables have NO user_id column, so ownership is necessarily transitive).

Tables with zero direct user_id scoping that are nonetheless fine: `phases` (always via resolveProject), `flow_template_steps` (via an ownership-checked parent template), `user_api_keys` / `oauth_tokens` (these ARE the authentication lookup — they resolve *who the caller is* from a token, so they cannot be scoped by a user not yet identified).

## The conclusion that answers TDE-780's open question
TDE-780 asks whether the holes are (a) policy bugs fixable in place, or (b) structural — Supabase's RLS model being too easy to get wrong at this surface area. The evidence says (a), decisively. One missing check in 139 handlers, in a codebase that already contains the correct helper (`resolveGroup`, index.ts:3182, does a proper transitive ownership join). That is an oversight, not a platform failure.

Therefore: A BACKEND MIGRATION IS UNJUSTIFIED. PocketBase/Whity would relocate the same 312 hand-checked query sites to a different database and change nothing, because the service-role bypass follows the CODE, not the database — the MCP is trusted, and it would be trusted on any backend. TDE-780 should be renamed and rescoped from "Backend Services" to MCP authorization hardening.

## Residual structural risk (the real argument for doing something)
Not that it leaks today — it doesn't. It is that correctness rests on convention across 312 sites with zero database backstop, and the count grows with every tool added. The durable fix is not a migration but a backstop: either enforce RLS by having the MCP act as the calling user rather than service role, or add a single choke-point helper every handler must route through. Both are code changes, not platform changes.

## Incidental finding — TDE-808 missed two spots
TDE-808 (rewrite the FLOW vs AD-HOC directive to the new definition) is marked DONE, but two live strings still teach the RETIRED definition:
- index.ts:3123 — the `build_new_flow` TOOL DESCRIPTION opens "Start building a NEW flow — a chain of contract-linked tasks toward a goal". This is arguably worse than the docs error TDE-812 tracks: the directive is read once per session, but the tool description sits in the always-loaded tool list.
- index.ts:3636 — bootstrap seed guidance, "FLOW SEED — multi-step contract-linked process".
Cheap fix, same file, and it should ride along with whatever touches the flow tooling next.

