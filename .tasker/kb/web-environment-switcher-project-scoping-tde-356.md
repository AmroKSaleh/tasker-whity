# Web: Environment switcher + project scoping (TDE-356)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Environments web layer (TDE-356) shipped to Netlify 2026-07-04. IMPORTANT reality note: the task's original file map was STALE — src/components/layout/NavigationRail.jsx is DEAD CODE (defined, never imported; replaced by the editorial redesign). The real structure:
- Persistent rail = src/components/editorial/AppShell.jsx (56px hover-rail, no project list).
- Project LIST lives in src/pages/HomePage.jsx (route /projects).
- Board = DashboardPage → ProjectBoard (per-project via slug).

**What was built**
- src/store/useEnvironmentStore.js — persisted zustand (key 'tasker-environments'): environments[] + activeEnvironmentId.
- src/hooks/useEnvironments.js — loads envs + resolves active pointer (server user_settings.active_environment_id wins → persisted local → first env). setActiveEnvironment() writes the pointer to user_settings (upsert by user_id) AND updates local optimistically.
- src/components/home/EnvironmentSwitcher.jsx — dropdown; DECIDED PLACEMENT: on the /projects page header (next to Create), NOT in the rail (user chose page over global rail; rail too cramped). Hidden when 0 envs.
- HomePage: visibleProjects = filter by activeEnvironmentId (exclusive switching). Grid + SortableContext + Kicker count all use visibleProjects. handleDragEnd still operates on the FULL projects array (arrayMove by global index) so reorder never drops other envs' projects from the store. Added an env-specific empty state.
- All THREE creation paths stamp environment_id = active: createProject (useProjects.js), createProjectWithStructure (lib/projectBuilder.js), and the inline GitHub insert (NewProjectModal.handleGitHubCreate).
- useProjects fetch select now includes environment_id.
- prefetch.js unchanged (prefetchBoard is per-project; prefetchToday is cross-env = 4/5's concern).

**Not in scope here**: Today/Focus cross-env badges (TDE-357); env management UI create/rename/delete (TDE-358 — for now envs are created via the MCP create_environment tool).
