# Web: Today cross-env + per-item Environment badge (TDE-357)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-357 shipped to Netlify 2026-07-04. Today is the ONLY surface here — Focus mode is a disabled null-stub (see "Focus Mode Disabled" KB), so "Today/Focus" reduced to Today.

**Key realization**: Today already spans ALL projects (useAllTasks fetches every project + task, and TodayPage never touches the environment store), so cross-environment was ALREADY satisfied — the only requirement was NOT to scope it (confirmed) + add the per-item badge.

**What was built**
- useAllTasks PROJECT_FIELDS + prefetch.js prefetchToday projects select: added environment_id (so task.project.environment_id is available, incl. from the localStorage cache on first paint).
- editorial/atoms.jsx TaskRow: new optional `envBadge={name,color}` prop → renders a small colored dot + env name before the project prefix. Safe/no-op for all other TaskRow callers (defaults null).
- TodayPage: useEnvironments() → getEnvBadge(task) threaded into every Bucket + ActivitySection; FocusCard hero kicker shows the env name too. Badge shown ONLY when environments.length > 1 (zero noise in the single-env case — mirrors the list_projects "flat when single" and 356 switcher-hidden decisions).
- Env COLOR: environments table has no color column, so colors are DERIVED deterministically from the env id via a hash → ENV_COLORS palette (envColorFor in TodayPage). If a real color column is ever added (e.g. in 358), swap envColorFor for it.

**Verification note**: badge only renders with 2+ environments; in the current single-env (Default only) state nothing changes visually. Live badge appearance is best verified once 358 ships env management (or via a temp 2nd env).
