# Architecture: task_events — the append-only gate-history log (TDE-818 shipped; lifecycle gap closed by TDE-819)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SHIPPED + DEPLOYED 2026-07-28. Migration 20260728120000_task_events.sql, branch tde-818-durable-gate-history (commit 519d244, merged to main in 51d1833). Supersedes the "gate state is OVERWRITTEN" gap entry — that entry describes the problem, this one describes the fix.

## What exists now
`task_events` — append-only log of what changed on a task's contract / review bar / gate verdicts.
Columns: task_id, user_id, kind, entity, actor, summary, before jsonb, after jsonb, meta jsonb, created_at.
Kinds: contract_set · contract_cleared · contract_confirmed · review_bar_frozen · review_bar_cleared · review_submitted · validation_submitted · fields_changed.
Read it with the new **get_task_history** tool (filter by kind, `verbose:true` for full before/after).

## Why a new table and NOT agent_activities (the decision, so it isn't re-litigated)
1. `agent_activities.session_id` is NOT NULL → every row needs an `agent_sessions` parent. A human confirming a contract in the web app has no agent session; synthesising one per human click corrupts what "session" means.
2. `get_task_activity` DERIVES session lifecycle (active/awaiting_input/error/stale) from the LAST entry's type (index.ts ~4922-4928). Structural audit rows would become "last" and break that derivation.
3. Its `type` CHECK is narrative and `body` is text; audit needs structured before/after JSONB.
TDE-375's locked spec already named this log ("write actor into ledger entries + a task-events log"); the actor half shipped in July, this is the log.

## Design choices worth keeping
- **recordTaskEvent is AWAITED, not fire-and-forget** (unlike emitWebhook). A webhook is a notification and may drop; this is the audit record. It still never fails the mutation — a lost audit row must not block a human confirming a contract — but a drop is written to `mcp_error_logs` so it is *detectable* rather than silent.
- **Immutability by trigger, not policy.** The MCP is service role and bypasses RLS, so append-only cannot rely on policies: `reject_task_event_update` hard-blocks UPDATE. DELETE is deliberately NOT blocked so `on delete cascade` from tasks still works.
- **`meta.erased_confirmation`** is the flag that answers the question the whole table exists for: was a human blessing silently destroyed by a later edit? It has a partial index, and `get_task_history` surfaces it as a banner.
- `set_task_output` now WARNS the caller when it voids a confirmation. Previously that was completely silent — the caller had no idea they had just unblessed a human-approved bar.
- `get_flow_audit`'s header now reads "Gate Snapshot" + points to get_task_history. Its old name implied a log it never was.

## Gotcha found while building (this bit others will hit — and bit TDE-821 three more times)
`resolveTask` selects a FIXED column list — id, text, detail, input, output, status, short_id, flow_id, flow_step, project_id, section_id, kind, seed_target, seed_open_questions, review_enabled, review_bar, review_verdict. It does NOT include priority, due_date, pinned, executor, group_id, agent_ready, completed_at, phase_id. So the long-standing `changedFrom` loop in update_task (`if (k in task)`) silently omitted those fields — an audit row reading "changed priority" with no prior priority. Caught it on the first live test. update_task now fetches the missing changed columns before the write (one indexed PK lookup, only when a field outside the projection is changed). ANY code deriving before-state from a resolveTask result has this same hole — and where the value isn't cheaply available, OMIT the field rather than asserting null.

## Verification status — ALL 8 EVENT KINDS LIVE-FIRED
Fired on throwaway tasks (since deleted): contract_set, contract_confirmed, contract_cleared, review_bar_frozen, review_bar_cleared, review_submitted (×2 attempts), fields_changed, and validation_submitted (×2 attempts, on a real 2-task I/O edge).
Proven specifically:
- confirm→overwrite preserves the destroyed blessing incl. confirmed_by + confirmed_at, flagged erased_confirmation.
- Two failing review attempts retain DISTINCT critiques — attempt 1 survives attempt 2.
- Two failing GATE attempts retain distinct observed_values (6 words / 21 words) and notes, while the task row's validation_ledgers holds only attempt 2. get_flow_audit shows "Retries: 2" with only the latest body — which is precisely why the log had to exist.
- disable_task_review preserves the full bar + verdict it tombstones (previously only prior_overall survived).

STILL NOT empirically tested: the append-only UPDATE trigger. Creation is confirmed (migration recorded applied remotely) but nothing fired it — no MCP tool updates task_events, and the user/anon path is blocked by RLS before reaching the trigger. Would need service-role SQL access.

## The lifecycle gap this entry used to document is CLOSED (TDE-821, same day)
`fields_changed` originally fired only from update_task, so complete_task / uncomplete_task / move_task / move_task_to_group / set_task_phase / merge_task_as_duplicate / resolve_seed / get_task autostart / advance_guide produced no rows — a completed task was absent from its own history. All 9 now record via a `recordLifecycleChange` wrapper that stamps `meta.via` with the handler name. See the companion entry "Architecture: lifecycle changes now recorded too — the 9 handlers that bypass update_task (TDE-821)".
Remaining hole: the Local Mode flush path still writes task fields directly, so file-driven edits leave no history — deliberately deferred, different semantics.
Also by design: a detail-only `update_task(append:true)` is skipped — additive by construction, and the text is already durable.

## History starts 2026-07-28
`task_events` records FORWARD only. Contract/review/gate changes made before this date are gone — overwritten in place, not reconstructible. get_task_history says so on tasks with no events.

## Downstream
TDE-378 owns the shared filter grammar that will query this (decided: param-object, not a DSL). TDE-556 is the human-facing saved-views wrapper. Record-then-query: this had to land first.
