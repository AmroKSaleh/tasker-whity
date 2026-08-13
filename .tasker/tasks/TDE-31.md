---
id: TDE-31
title: MCP update_task tool is missing section_id parameter
status: done
priority: medium
section: bugs
order: 2
updated_at: 2026-08-01T09:35:21.789Z
---

The update_task MCP tool does not include section_id in its parameter schema, so it's impossible to move a task to a different section via MCP. The REST API endpoint (PATCH /tasks/{taskId}) already supports section_id — the fix is to expose it in the MCP tool definition and pass it through in the handler.
