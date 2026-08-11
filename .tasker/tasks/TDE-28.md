---
id: TDE-28
title: rank_tasks MCP tool doesn't reflect pinned tasks
status: done
priority: high
section: bugs
order: 1
updated_at: 2026-08-01T09:35:21.782Z
---

The pinned field is not being returned correctly via select('*') in the rank_tasks query, so pinned tasks don't receive the score 9999 boost and don't surface at #1. The UI correctly stars the task and updates the DB, but the MCP server doesn't read the pinned value. Needs investigation into whether the field is being returned from Supabase or filtered out somewhere.
