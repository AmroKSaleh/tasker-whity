# Agent session ledger (TDE-374) — schema + append-only design decisions

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Backend slice coded on branch `feat/agent-session-ledger-tde374` (commit e11500e), NOT yet deployed as of 2026-07-11. The durable, human-inspectable record of what an agent did on a task.

**Two tables** (migration 20260711120000):
- `agent_sessions` — one per contiguous agent engagement: (id, task_id, user_id, actor, opened_at, last_activity_at, closed_at). The `actor` column is the shared substrate for TDE-375 (provenance) — created here, populated fully there.
- `agent_activities` — append-only typed entries: (id, session_id, task_id, user_id, type ∈ progress|action|question|result|error, body, created_at). `task_id` is denormalized for TDE-383's cross-task pull.

**Non-obvious decisions:**
- **Append-only is enforced by a BEFORE UPDATE trigger ONLY — deliberately NOT a BEFORE DELETE trigger.** tasks→agent_activities is `on delete cascade`; a delete-reject trigger would break task deletion. Deletes are instead blocked for web users by omitting a delete RLS policy, and the MCP (service role, bypasses RLS) simply has no delete tool. Net: effectively immutable without breaking cascades.
- **Derived lifecycle state (active/awaiting_input/error/stale/complete) is computed at READ time** (in get_task_activity), never stored — avoids drift and needs no sweeper for correctness. Rules: question→awaiting_input, error→error, task done or closed_at set→complete, last activity <24h→active, else→stale. A sweeper is only a later optimization to precompute stale on big boards.
- **Sessions are lazily opened**: append_session_activity reuses the newest session with closed_at IS NULL for (task,user), else inserts one. No explicit "open session" call in v1; no "close" call either (a session closes implicitly when the task is done — closed_at is reserved for a future explicit close).
- MCP surface is just two tools (append_session_activity + get_task_activity); get_task-folding of the thread and the inspector/Front-Page render are deferred (milestones 3–4).
