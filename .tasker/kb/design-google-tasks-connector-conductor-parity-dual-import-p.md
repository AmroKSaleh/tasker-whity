# {design} Google Tasks connector — Conductor parity + dual import paths (TDE-248)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-248 done & verified live.** Google Tasks → Tasker was already built in a prior session (page + google-tasks edge function + MCP tools list_google_task_lists/list_google_tasks/pull_google_task, all deployed); this session added Conductor parity with the other connectors.

## What the Google Tasks page now offers (two import paths)
- **Pull** (pre-existing): direct one-way import of a Google task into a chosen project/section. Tagged intake_source='google_tasks'.
- **+ Task** (new): captures the Google task as an intake_job (source='google_tasks') → surfaces in the docked **Conductor** → agent structures it via `process intake` → Parked → human reviews/edits/imports.

## Key reuse insight
The intake pipeline is **source-agnostic**: pull_intake_job claims the oldest pending job regardless of source and returns {source, payload}; the Conductor component is parameterized by `source`. So adding a connector to the Conductor needs ZERO backend changes — just render `<Conductor source="..." projects defaultProjectId />` and add a button that inserts an intake_jobs row with that source + a payload carrying {subject, body, due, ...}. Gmail and Google Tasks now both use it.

## Resolved open questions (from the task)
Direction = one-way; landing project = manual per-item (Pull modal) or per-proposal (Conductor import); no bidirectional push → no conflict resolution. Bidirectional (complete-in-Tasker pushes back to Google) would be a NEW task.

## Verified
Ran +Task → process intake → submit_intake_result end-to-end (job "Test for the app" landed in Parked). Live.
