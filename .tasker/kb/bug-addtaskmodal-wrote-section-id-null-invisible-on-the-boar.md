# Bug: AddTaskModal wrote section_id: null — invisible on the board (TDE-369)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Found and fixed while building TDE-369 ("Create Task" button). The Today page's quick-add (`components/today/AddTaskModal.jsx`, opened from the calendar's "+") inserted new tasks with `section_id: null`. The project board (`ProjectBoard.jsx`) only renders tasks that match a real section's id — `sections.map(section => tasks.filter(t => t.section_id === section.id))` — so any task created through that modal existed in the DB but was invisible everywhere in the UI. Not a crash, just silent data that looked lost.

**Fix:** added `getOrCreateBacklogSectionId(projectId)` to `hooks/useTasks.js` — looks up the project's section named exactly `Backlog` (the name every project gets by default at creation, see `createProject` in `hooks/useProjects.js`), creating one if it's missing (older project, or the section got renamed/deleted). `AddTaskModal` now resolves this before inserting instead of hardcoding `null`.

**Also shipped alongside:** a new `+ Create Task` button in the project board masthead (`components/board/CreateTaskModal.jsx`), scoped to the currently open project. Defaults its section dropdown to Backlog (creating it on the fly if absent) but lets the user pick any other section in that project. Uses the project's already-loaded `useTasks` hook (`createTask`/`createSection`) rather than raw supabase writes, so the local task/section store stays in sync without a refetch.

**Takeaway for future task-creation paths:** never write `section_id: null` on a `tasks` insert — always resolve a real section id (Backlog via the helper above, or an explicit one) or the task will silently not render anywhere in the board UI.
