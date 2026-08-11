# Web: /new prefilled task composer + copy-link (TDE-394)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped `linear.new`-style prefilled task creation, deployed live.

**Route:** `NewTaskPage.jsx` at `/new?title=...&detail=...&project=...&priority=...` (App.jsx, public route — auth check happens *inside* the page, not at the router level, so query params survive the login round-trip via `?next=`).

**Reused existing code — no new patterns needed:**
- `getOrCreateBacklogSectionId(projectId)` was already exported from `useTasks.js` (added for `EditTaskModal`/`AddTaskModal`) — reused as-is for section fallback, no need to duplicate `CreateTaskModal`'s inline fallback.
- Auth redirect-back: `LoginPage.jsx`'s generic `?next=<path>` param already handles arbitrary routes; no InvitePage-style localStorage token needed since the full querystring rides in `next`.
- Project resolution mirrors the MCP's `resolveProject` order exactly (slug exact → id exact → prefix ilike, all scoped `eq('user_id', ...)`) so the same `project=` value works whether it came from an agent or a human typing a prefix.

**Reverse affordance:** `TaskDetailPanel.jsx` header got a `Link2`/`Check` icon button (`copyPrefilledLink`) that builds the same `/new?...` URL from the open task's current text/detail/priority/project-slug and copies it — mirrors the existing "Copy task list" copied-state pattern from `ProjectHeader.jsx` (`setLinkCopied(true)` + 2s timeout).

**Not needed:** no MCP tool changes, no DB migration, no changes to `createTask` itself — pure web-app addition, confirmed by the pre-sizing note on the task before work started.
