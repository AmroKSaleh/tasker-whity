# KB: source field — 'user' vs 'agent', filter params, frontend tabs

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

`project_knowledge` table has a `source` column: `'user' | 'agent'`, default `'agent'`.

**MCP behavior:**
- `create_kb_entry`: accepts optional `source` param. If omitted or called by an AI agent, defaults to `'agent'`. Pass `source: 'user'` only if the user is explicitly authoring the entry.
- `get_knowledge_base` and `list_kb_entries`: both accept optional `source` filter (`'user'` | `'agent'` | `'all'`). Omitting = `'all'`.
- `list_kb_entries` now includes source in output: `[id: ...] [agent] Title  (updated ...)`

**Frontend (KnowledgeBaseModal):**
- Filter tabs: All / Mine / AI — default All.
- Agent entries show a small `AI` badge in the list.
- `createEntry()` in `useKnowledgeBase.js` always passes `source: 'user'` (user-created entries from the UI are always 'user').

**Stale archiving (not yet built):** agent entries auto-archive after 60 days unreferenced; user entries require explicit confirmation. KB Health surface (milestones 4-5 on TDE-184) still pending.
