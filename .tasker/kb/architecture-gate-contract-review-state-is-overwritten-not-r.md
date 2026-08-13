# Architecture: gate/contract/review state is OVERWRITTEN, not recorded — and get_flow_audit is not an audit log

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Verified against V2/supabase/functions/mcp/index.ts on 2026-07-28 while scoping TDE-556. Any agent touching contracts, gates, reviews or validation should know this before assuming history exists.

## The trap in the naming
`get_flow_audit` (index.ts:6148) is NOT an audit log. It renders the *current* value of `tasks.output.validation_ledgers` — a snapshot renderer over mutable JSONB. Reading its name is what made earlier assessments assume audit coverage existed. It does not.

## What is actually lost
- `confirm_contract` (index.ts:8022) writes only {confirmed, confirmed_at, confirmed_by} onto the live row. A later `set_task_output` (index.ts:6976) replaces the contract wholesale and resets `confirmed:false` — **erasing that a human ever blessed it**. The single highest-trust act in the system leaves no durable trace.
- `submit_task_review` (index.ts:7157) overwrites `review_verdict` each submission. Attempt 1's critique is gone by attempt 2; only the `attempt` counter survives.
- `submit_validation_result` (index.ts:7631) keys `validation_ledgers` per EDGE, not per ATTEMPT. `retry_count` (index.ts:7605) can report 3 gate failures with the content of all 3 gone — which is why get_flow_audit prints a retry count it cannot explain.
- `enable_task_review` (index.ts:7069): the "frozen" bar is overwritten by `force:true`. Frozen means frozen-until-someone-passes-force.
- `update_task` (index.ts:4113) blind-writes a patch. Field history is lost; only `tasks.updated_at` survives. The `changedFrom` at index.ts:4116 exists solely to fill a webhook payload and is discarded when no webhook matches (index.ts:113).
- `disable_task_review` (index.ts:7177) is the one handler written in the right spirit — it leaves a superseding {cleared, reason, prior_overall} tombstone per the TDE-374 immutability comment — but it still overwrites the verdict it is tombstoning.

## Substrate facts (for whoever fixes it)
- `agent_activities` is the only append-only ledger (UPDATE blocked by trigger `reject_agent_activity_update`, migration 20260711120000_agent_session_ledger.sql:41). Exactly ONE line in the 8,400-line MCP writes to it — index.ts:4900, the manual `append_session_activity`. There is no logging helper anywhere.
- Grep across all 68 migrations: NO table named *audit* / *history* / *event* / *changelog* / *revision*, and no trigger-based history.
- `webhook_deliveries` is the closest thing to an event log but is lossy by design — `emitWebhook` returns early with no registered webhook (index.ts:113/117), and only 3 events exist in the whole file: task.updated (:4120), task.completed (:4156), review.submitted (:7162).
- TDE-375's locked spec intended "write actor into ledger entries + **a task-events log**". The actor half shipped; the task-events log was never built.

## Why it matters beyond the feature
The positioning line is "durable, human-shared, quality-gated state that persists across sessions, agents, and people." The gate history is the one part that is not durable — a hole under the load-bearing claim. Tracked as TDE-818.

## Related decision recorded the same day
Query surface DSL vs param-object → **param-object**, folded into TDE-378 item (d) rather than built as a separate engine. Measured surface: 137 MCP tools, 34 of them list_*/get_*. A DSL must be taught in a tool description (our most token-exposed flank) and agents malform novel grammars; a params grammar lets one query tool SUBSUME several narrow read tools instead of becoming tool #138. Record-then-query: TDE-818 before any history queries in TDE-378.
