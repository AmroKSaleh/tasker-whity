---
id: TDE-32
title: Optimize Tasker API queries — avoid fetching all tasks/sections unnecessarily
status: done
priority: medium
section: core-app
order: 6
updated_at: 2026-08-07T11:31:54.509Z
---

When users query for a specific section's tasks, don't fetch all tasks across all projects first. Instead: (1) search sections by name/ID, (2) get tasks for that specific section only. This reduces API calls and response payload. Audit all Tasker integration points (MCP, Claude Code workflows, etc.) for similar inefficiencies and document best practices for filtering queries.
