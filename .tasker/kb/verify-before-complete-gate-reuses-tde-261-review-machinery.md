# Verify-before-complete gate reuses TDE-261 review machinery (TDE-344)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-344 (verify-before-complete) ships with NO new data model — it reuses the TDE-261 task-review machinery:
- A frozen `review_bar` (kind=check rules) IS the verification gate; `review_verdict` IS the evidence.
- `verified` := `review_verdict?.overall === 'pass'` on a task that has a `review_bar`.

DESIGN (decided with user 2026-07-13): verification is OPTIONAL, but CLAIMING it is ENFORCED — you can't reach the verified state without submitting a real observed_value (kind=check requires it). NO hard-blocking on complete_task (skippable-by-omission avoids rubber-stamp fatigue); instead the completion is made VISIBLE + durable as verified vs unverified. This is "state Tasker owns," not advisory.

WIRING:
- complete_task tail annotates: "✓ VERIFIED" (bar + passing verdict) / "⚠ DONE (UNVERIFIED)" (bar, no passing verdict) / plain done (no bar). Reads existing fields only.
- ASSISTANT_DIRECTIVE "VERIFY BEFORE COMPLETE (TDE-344)" + /work-loop: the executing agent PROPOSES a deterministic check in its agent_proposal, freezes it via enable_task_review during prep (human confirms work + proof together), then runs it + submit_task_review with raw observed_value before completing.
- Core App BoardCard footer renders ✓ verified / unverified for done tasks whose review_bar has rules (useTasks selects * so review_bar/review_verdict are already present client-side).

Prefer kind=check (deterministic, self-run is fine since observed_value is raw evidence not judgment) over kind=judgment gates (decay into rubber-stamping). Scope: standalone non-flow tasks (flow tasks are governed by flow gates — enable_task_review refuses them).
