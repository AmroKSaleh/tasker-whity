# Project export/import: full-fidelity portable bundle (MCP + web twins)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped 2026-06-24. A whole project can be serialized to a portable JSON bundle and recreated under any account. Replaces the old Excel "Export" button. Verified live: TDE → "tasker testttt" (TT) round-trip reproduced 283 tasks, the 6-step flow, 27 KB, 5 IS, custom statuses, milestones, I/O contracts — exactly.

**Two MIRRORED implementations — bundles are interchangeable, KEEP IN SYNC:**
- MCP (Deno): `export_project` / `import_project` tools + `exportProjectBundle`/`importProjectBundle` helpers in V2/supabase/functions/mcp/index.ts.
- Web (browser): V2/app/src/lib/projectTransfer.js (same logic, runs against the RLS-scoped supabase client) + components/board/TransferModal.jsx (Export/Import tabs, the "copy as-is vs clear progress" choice on BOTH). Wired into ProjectBoard header.

**Why NO migration:** export = read rows; import = insert rows with fresh IDs. Pure read/insert, nothing persisted server-side.

**Key non-obvious decisions:**
- PRESERVE task short_id on import (e.g. TDE-264 → TT-264). Safe because import always targets a NEW empty project, so originals stay unique — AND it sidesteps the assign_task_short_id trigger's batch-collision risk (the trigger does MAX(short_id)+1 per project with NO unique constraint; it only fires when short_id IS NULL, so explicit values pass through untouched).
- REGENERATE flow short_id — it's unique PER ACCOUNT (partial unique index flows_user_short_id_idx), so it can't be preserved.
- CLEAR the auto-seeded baseline IS before inserting the bundle's IS: the projects AFTER-INSERT trigger seeds a baseline Instruction Set; the bundle already carries the source IS (baseline included), so delete project_instructions for the new project first to avoid duplicates / keep an exact copy.
- Generic row copy via a `stripManaged` denylist (id, created_at, updated_at, user_id, project_id + per-table extras) → robust to column drift; only the handful of cross-row refs are remapped.

**Reference remap targets on import:** section/group/flow/custom_status FKs; tasks.input.edges[].source_task_id (+ legacy output.target_task_id); spawned_from_seed_id (done in a 2nd pass after all tasks exist). Insert order: project → sections → groups → project_statuses → flows → tasks → (task_discussions, task_statuses, flow_instructions, flow_knowledge, project_knowledge, project_instructions).

**Excluded (ephemeral):** project_drafts, intake_jobs. **`reset_progress`/clear-progress** option (both export and import): sets task status→pending + clears completed_at (base status only).

**Confirmed:** browser inserts into the RLS-sensitive tables (task_statuses, flow_instructions, flow_knowledge, project_statuses) succeed under the user's JWT — no policy changes were needed.
