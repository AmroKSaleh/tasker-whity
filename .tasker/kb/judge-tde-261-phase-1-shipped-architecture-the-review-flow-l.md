# Judge: TDE-261 Phase 1 shipped — architecture & the review≠flow-ledger gotcha

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Task-level output judge (TDE-261) Phase 1 is built, deployed, validated.

**Schema (tasks):** `review_enabled` (bool), `review_bar` (jsonb — frozen snapshot `{rules, frozen_at, source}`), `review_verdict` (jsonb — `{overall, results, critique, attempt, escalated, validator}`). Migration 20260615120000_add_task_review.sql.

**MCP tools (functions/mcp/index.ts):**
- `enable_task_review(task_id, bar?, force?)` — dispenser: no bar → returns grounding (task text + IS, NO KB in Phase 1) + authoring instruction; with bar → freezes it. Refuses flow tasks; won't overwrite a frozen bar without force.
- `review_task(task_id)` — returns the single-task judge protocol; embeds the SERVER-STORED artifact (`output.artifact`) for independence; refuses flow tasks.
- `submit_task_review(task_id, results, validator)` — writes review_verdict; blocker fail → reopen (status=in_progress) + critique + attempt++; ≥3 → escalate (ask_human); pass → stays done.
- `complete_task` appends a review nudge for review-enabled non-flow tasks.
- `get_task` prints a "Review verdict" block (overall + per-rule ✓/✗ + observed/notes + critique).

**Helpers:** `isFlowTask`, `hasCheckableDeliverable`, `isReviewEligible` (added after `outputContract`). `resolveTask` select extended to include detail/project_id/review_* columns.

**Web app:** `ReviewVerdictPanel.jsx` (panel) in TaskDetailPanel + a card badge in TaskItem. Board already selects '*' so review_* fields flow through.

**GOTCHA / design choice worth knowing:** task-level review uses its OWN store (`review_bar`/`review_verdict`) and its OWN submit (`submit_task_review`) — it **mirrors** the flow loop (store_artifact → validate_output → submit_validation_result) but does **not** reuse `submit_validation_result`/the output-contract ledger. So a reviewed task's verdict lives in `review_verdict`, separate from flow validation. HARD RULE enforced everywhere: review applies only to NON-flow tasks (mutual exclusivity).

**Phase 2 (TDE-268/269, KB-enriched bar + category) is BLOCKED on TDE-254** (selective KB read-loop) — not built.
