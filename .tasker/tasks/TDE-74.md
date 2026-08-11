---
id: TDE-74
title: "Write a platform-agnostic AI primer: what Tasker is, what the MCP does, how to interact"
status: done
priority: low
section: core-app
order: 20
updated_at: 2026-07-25T07:41:59.616Z
---

A platform-agnostic primer any AI coding agent (Claude Code, Cursor, Windsurf, Roo Code, etc.) can be given — via CLAUDE.md, .cursorrules, a system prompt, or a Tasker IS entry — so it understands the system from zero and interacts correctly. Portable: no Claude-Code-only assumptions (per-platform install lives in TDE-33).

Three parts:

1) What Tasker is
- Task/project manager: projects → sections → tasks → milestones, plus per-project Knowledge Base (KB) and Instruction Set (IS).
- Living-context model per project (goal / why / scope / risks / done_looks_like).
- Short IDs (e.g. TDE-31), priorities (rush/high/medium/low), the focus model.

2) What the MCP does
- Exposes Tasker over an MCP server so an agent reads/writes tasks without leaving the editor.
- Tool inventory grouped by purpose:
  - Projects: list_projects, get_project, create_project, update_project_context
  - Tasks: list_tasks, get_task, create_task, update_task, complete_task, rank_tasks
  - Milestones: add_milestone, complete_milestone, delete_milestone, list_milestones
  - KB: get_knowledge_base, list_kb_entries, create/update/delete_kb_entry
  - IS: get_project_is, list_is_entries, create/update/delete_is_entry
- When to reach for each.

3) How to interact (conventions + workflow)
- Conventions: short IDs not UUIDs; never number task lists; omit done tasks unless asked; no markdown tables for tasks; group by section.
- Workflow: "start the next task" → rank_tasks, pick top, confirm before starting. Milestone discipline: one milestone per step, never a checklist in notes.
- KB/IS usage: when to pull get_knowledge_base / get_project_is.

Output: one tight markdown doc (<120 lines) that drops into any agent's instruction surface.
