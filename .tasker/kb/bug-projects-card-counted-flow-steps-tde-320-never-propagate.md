# Bug: /projects card counted flow steps — TDE-320 never propagated off the board (TDE-806)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## The bug

Same project showed two different open/total numbers: one on the project card in `/projects`, another in the project screen header.

## Root cause — a definition split, not a math error

TDE-320 (a flow step is not a board task; steps leave the project denominator entirely) was implemented **only in ProjectBoard**:

- `ProjectBoard.jsx` → `boardTasks = tasks.filter(t => !t.flow_id)`; its header literally reads `{doneCount} / {boardTasks.length} STANDALONE TASKS`. `FrontPage` also receives `boardTasks`, so the whole project screen was already correct.
- `useAllProjectTasks.js` (the card's only data source) selected **every** task for the user with no flow filter — it didn't even fetch `flow_id`. `ProjectCard` then counted `tasks.length` raw.

So card total = standalone + flow steps; board total = standalone only. On TDE that was a ~19–54 task gap (the Flows section).

## Fix

Filter at the query in `useAllProjectTasks`: add `flow_id` to the select and `.is('flow_id', null)`. Filtering at the hook (not in the card) was safe because the hook has exactly one consumer — `HomePage` → `ProjectCard` — and it makes *every* card number consistent, not just the counter: total, done %, overdue, rush/high, "next up", and staleness all stop seeing flow steps. A flow step must never surface as a project card's Next Up either.

## Gotcha: the localStorage cache

`useAllProjectTasks` caches the grouped result under a fixed key and seeds state from it synchronously on mount, fetching only once. A pre-fix cache would keep serving flow-inflated counts after the fix shipped, so the key was bumped (`tasker-all-project-tasks` → `...-v2`) and the v1 blob is removed on read. **Any future change to the shape or filtering of a cached hook needs the same key bump** — otherwise returning users see stale data with no way to know it.

## Consequence to expect

A project whose tasks are *all* flow steps now reads 0/0 · 0% on its card. That is correct per TDE-320, but it means flows-heavy projects look empty at a glance on `/projects`. The rejected alternative was a split display ("42 standalone · 19 in flows"); the user chose to remove flows from the numbers outright.

