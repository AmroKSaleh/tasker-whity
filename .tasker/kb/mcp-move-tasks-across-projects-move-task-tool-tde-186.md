# {mcp} Move tasks across projects — move_task tool (TDE-186)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-186 shipped & verified: `move_task(task_id, target_project_id, target_section_id?)`.**

## What it does
Moves a single task to a different project. Preserves text, detail, priority, status, output contract, stored artifact. Side effects (task is leaving its project): unlinks flow (flow_id/flow_step null), resets section/group (project-scoped), and warn-and-drops cross-boundary I/O edges — both the task's own input edges and references to it from tasks left behind. Response reports what was dropped.

## short_id reassignment — now ATOMIC at the DB level (updated 2026-06-25)
The `task_short_id_trigger` (assign_task_short_id) now fires BEFORE INSERT **OR UPDATE** and reassigns short_id whenever a row's project_id changes, holding `pg_advisory_xact_lock(hashtext(project_id))` on the target project. So a cross-project move gets the correct next number atomically. move_task NO LONGER computes MAX+1 in app code — it just sets the new project_id and reads the trigger-assigned short_id back via `.update(...).select('short_id').single()`. Migration: 20260625140000_short_id_atomic_on_move.sql.

**Bulk/concurrent moves are now SAFE** — the earlier "must run sequentially" caveat is OBSOLETE (the advisory lock serializes inserts+moves into the same project). Verified: throwaway task moved into TG got the correct next number (TG-45) via the trigger.

## Scope
Phase 1 = MCP-only, single task, drop cross-boundary edges. Phase 2 (deferred): bulk/section move + edge REMAP instead of drop. No web-UI move surface yet.

## Related incident
A task was once lost mid-move by a concurrent edge-function redeploy — see the "{deployment} NEVER redeploy an edge function while a request is in flight" KB. That was a deploy-collision, NOT a move_task bug.
