# MCP token economy: get_task context tiering + get_project notes toggle (TDE-371)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped + deployed live 2026-07-06. Cuts the token cost of the two heaviest MCP reads. Rationale: [[Positioning: Tasker's wedge is durable, human-shared, quality-gated state]] — durable state only beats re-deriving context if injecting it is cheap.

**get_task — auto-tiered "prime once per project per session":**
- The heavy per-project context (Project Foundation + full Instruction Set + KB titles index, ~1,700 tokens) is now sent FULL only on the first get_task in a project each session, then replaced by a ~90-token pointer naming the on-demand re-read tools (get_project_foundation / get_project_is / list_kb_entries; + get_flow_is/get_flow_kb for flow tasks). Measured: ~2,100-token full response → ~90-token compact response = ~93% cut on every repeat call (the vast majority of calls).
- "Session" is inferred — the MCP protocol has NO session id (identity is per-API-key userId only). Mechanism: a `mcp_context_primed(user_id, project_id, primed_at)` table (migration 20260706170000). First touch with no fresh row → send full + fireAndForget upsert. `__init_tasker_session` deletes the user's rows (new session re-primes). A 3h window expires priming for agents that never call init.
- Escape hatch: `get_task(refresh_context: true)` forces full — for re-grounding after the agent's context window was compacted/cleared.

**get_project — notes omitted by default (folds in TDE-319, the overflow bug):**
- Per-task Notes (the `detail` field) were the bulk of a large project's payload and the overflow cause. Now omitted by default (task map — IDs/titles/badges/sections — always kept); `include_notes: true` restores the full dump. A marker line tells the agent notes were dropped + how to get them.

**Correctness posture (both are fail-SAFE):** every fallback errs toward MORE context, never missing context. The fireAndForget priming write can race (rapid back-to-back get_tasks may both send full before the row lands) and two concurrent clients for the same user+project share priming state — in both cases the worst outcome is an extra full send, never a task that's missing its grounding. Acceptable for solo-dev usage; documented rather than over-engineered.

**Behavioral note:** the project IS carries real behavioral rules (task format, deploy rules, positioning). Tiering assumes the agent still has them in-context from the first-touch full send. That holds within a context window; after a compaction the agent should refresh_context or call get_project_is. The compact pointer states this.

Not yet committed to git (deployed to the live edge function only) — awaiting the usual commit/push confirm.
