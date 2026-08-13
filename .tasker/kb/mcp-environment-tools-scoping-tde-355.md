# MCP: Environment tools + scoping (TDE-355)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Environments MCP layer shipped 2026-07-04 (all in V2/supabase/functions/mcp/index.ts). Builds on the TDE-354 DB layer.

**New tools**
- `list_environments` — envs with per-env project count; active one marked with ●.
- `create_environment {name}` — appends by sort_order; does NOT touch the active pointer.
- `rename_environment {environment_id, name}` — non-destructive.
- `delete_environment {environment_id, reassign_to_id?, confirmed}` — requires `confirmed:true`; refuses to delete the last env; moves its projects to reassign_to_id → else an env named "Default" → else the next env (projects NEVER deleted); repoints active pointer if it was the deleted env.

**Changed**
- `create_project` — new optional `environment_id`. Resolution order: explicit arg → user_settings.active_environment_id → the sole env → error (no env exists / multiple + no active). Confirmation line now shows `| environment: <name>`.
- `list_projects` — new optional `environment_id` filter. Default = ALL projects, grouped by Environment (active marked); **renders FLAT with no group headers when everything sits in one env** (backward-compatible — current state).
- `__init_tasker_session` (ready branch) — now returns `environments`, `active_environment_id`, and an `environment_note`. Downstream tools (tasks/sections/flows/KB/IS) unchanged — they inherit env transitively via project_id.

**Core principle (TDE-308)**: the AI never silently scopes reads to the active env. environment_id is always explicit; the active pointer is only the create_project default. Web owns pointer WRITES; MCP only READS it (no set_active_environment tool in v1 — out of scope).

**Verified live**: list_projects (flat path) + __init_tasker_session env fields confirmed against prod. The 4 new tools + create_project's new param are deployed and `deno check` clean (0 errors) but need a CC/MCP restart to exercise (session-cached tool list). deno check on index.ts is now fully clean.
