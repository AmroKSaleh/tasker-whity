# Web: Environments management page + color column (TDE-358)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-358 (final Environments part) shipped to Netlify 2026-07-04. Adds a management page + a per-env color the user can edit.

**DB**: migration V2/supabase/migrations/20260704130000_add_environment_color.sql — `environments.color text` (nullable), applied live via db query. No backfill: when null, the UI derives a color from the env id (envColorFor), so nothing changes visually until the user picks one.

**Shared color util**: src/lib/envColor.js — ENV_COLORS palette + envColorFor(id) (deterministic hash) + envColor(env) (stored color wins, else derived). Used by the Today badge (TDE-357, refactored to import it), the switcher, and the management page. NOTE: envColorFor previously lived inline in TodayPage — now centralized here.

**Data layer**: src/lib/environments.js — createEnvironment(name,color), updateEnvironment(id,{name|color}), reorderEnvironments(ordered), deleteEnvironment(id,reassignToId?), moveProjectToEnvironment(projectId,envId). Writes via supabase directly (same pattern as projects/useProjects), mirrors the MCP env-tool logic (guard last env, reassign projects to target→"Default"→next, repoint active pointer). Each mutation refreshes useEnvironmentStore; project moves update useProjectStore.

**UI**: src/pages/EnvironmentsPage.jsx (route /environments) + src/components/environments/EnvRow.jsx (dnd-kit sortable row: drag handle, color swatch→palette popover, inline rename, project count, delete). Page has: create form (name + color palette), sortable env list, and a "Projects by Environment" section with a per-project <select> to reassign. Entry point: a "⚙ Manage environments…" item added to the EnvironmentSwitcher dropdown (also gave the switcher color dots). useEnvironments select now includes color.

**Gotcha hit during build**: a Write with a RELATIVE path resolved against the shell's cwd (which had been cd'd to V2), creating V2/V2/app/... — use ABSOLUTE paths for file tools when the Bash cwd has moved. Fixed by moving the file + rm the stray dir.
