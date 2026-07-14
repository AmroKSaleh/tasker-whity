---
id: TDE-89
title: list_tasks should return section_id for each task
status: done
priority: medium
section: bugs
order: 9
updated_at: 2026-07-14T23:09:51.590Z
---

When calling list_tasks, the response doesn't include section_id for each task. This makes it impossible to programmatically determine which section a task belongs to without making additional API calls to get_task for each item. This impacts both the UI and external integrations (like MCP tools) that need to display or organize tasks by section efficiently.
