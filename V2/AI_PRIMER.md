# Tasker: AI Agent Integration Primer

## What Tasker Is

Tasker is a task manager for developers, indie hackers, and solopreneurs. It organizes work into projects → sections → tasks → milestones, with per-project Knowledge Base (KB) and Instruction Set (IS).

**Data model:**
- Projects: named workspaces (e.g., "EXP" for Example Project)
- Sections: categories within projects (e.g., "Core Feature", "Bugs")
- Tasks: individual work items with priority, status, due date, context (detail field)
- Milestones: steps toward completing a task (one per step, never checklists)
- Knowledge Base: markdown files the AI reads on-demand for context
- Instruction Set: markdown directives that govern how AI works within the project that is bundled with every list_tasks call.

**Task properties:** short_id (TDE-52), priority (rush/high/medium/low), status (pending/in_progress/done), sort_order (visual position in section).

## What the MCP Does

Tasker exposes itself via an MCP server so AI agents read/write tasks without leaving their editor.

**Tool categories:**

- Projects:
  - list_projects: Fetch all projects for the user. Returns project names, slugs, prefixes, and context (goal/why/scope/risks/done_looks_like).
  - get_project: Fetch full details for a single project, including all sections, tasks, and groups. Use this to understand project structure before working.
  - create_project: Create a new project with a name and optional context (goal, why, scope, risks, done_looks_like).
  - update_project_context: Update the living context for a project (goal, why, scope, risks, done_looks_like). Useful when project direction changes.

- Tasks:
  - list_tasks: Fetch tasks matching a project and optional filters (section, status, priority). Returns short_id, text, priority, status, due_date, section_id. Omits done tasks by default unless explicitly asked. Includes IS automatically.
  - get_task: Fetch full details for a single task, including text, detail (context), priority, status, milestones, and metadata.
  - create_task: Create a new task in a section with title, optional priority, and optional detail (context).
  - update_task: Modify task fields (text, priority, status, section_id, due_date, detail, pinned). Useful for moving tasks between sections or updating status.
  - complete_task: Mark a task as done. Task moves to done status.
  - rank_tasks: Fetch tasks for a project ranked by priority, due date, and skip history. Returns the user's recommended work queue. Always call this before picking which task to work on.

- Milestones:
  - add_milestone: Create a new milestone (step) for a task. Use one milestone per step, never checklists.
  - complete_milestone: Mark a milestone as done. Progress indicator for the task.
  - delete_milestone: Remove a milestone from a task (undo a step).
  - list_milestones: Fetch all milestones for a task with their completion status.

- Knowledge Base:
  - get_knowledge_base: Fetch all markdown files in the project's KB. Returns file contents. Call this only when the task requires external reference.
  - create_kb_entry: Add a new markdown file to the project's KB. Use for storing architecture notes, decisions, or reference material.
  - update_kb_entry: Modify an existing KB file. Update decisions, notes, or guidelines.
  - delete_kb_entry: Remove a KB file.

- Instruction Set:
  - get_project_is: Fetch the project's Instruction Set. Already bundled with list_tasks calls automatically. Read it before starting work and follow it exactly — it governs the project's style/workflow.
  - create_is_entry: Add a new directive to the project's IS. Use for establishing new rules or standards.
  - update_is_entry: Modify an existing IS directive. Update rules as project needs evolve.
  - delete_is_entry: Remove an IS directive.

- Sections:
  - create_section: Create a new section (category) within a project. Sections organize tasks thematically.

- GitHub:
  - github_import_project: Import a GitHub repository as a new Tasker project. Fetches repo info, README, and all open issues. Issues become tasks, organized by labels into sections.
  - github_sync_issues: Sync new issues from a GitHub repo into an existing Tasker project. Fetches issues added since last sync.
  - github_list_repos: Fetch user's accessible GitHub repositories (requires GitHub OAuth token or PAT). Use when creating projects or syncing issues.

## How to Interact: Conventions + Workflow

### User-Configured Preferences

The following conventions reflect the user's choices made during initialization. Honor them exactly.

- **Task list format:** Display tasks as {task_list_format}. (Options: plain text list, markdown table, or numbered list.)
- **Completed tasks visibility:** {show_completed_tasks} completed tasks by default. (Only show them if explicitly asked.)
- **Task ordering strategy:** When ranking multiple tasks, order by {rank_tasks_by}. (Options: sorting order in dashboard, or task priority field.)
- **Communication style:** Explain your reasoning in {communication_style} detail. (Options: terse, detailed, or conversational.)
- **Multiple task handling:** When working on multiple tasks, use {multiple_tasks_handling} mode. (Collaborative or autonomous.)
- **Project context:** {show_project_context} fetch and reference project context when starting work.

### Fixed Conventions (Always)

- **Use short IDs.** Always reference EXP-52, never full UUIDs.
- **No numbering on task lists.** Display tasks as bulleted lists only.
- **No markdown tables for task lists.** Use plain text format: `EXP-52 — Task title [priority]`.
- **One milestone per step.** Never use checklists in task notes.
- **Respect sort_order.** Don't ignore the visual position in the section.

### Workflow Pattern

When starting work on a project:

1. **Get context first.** Call `get_project` to read goal/why/scope/risks/done_looks_like.
2. **Get instructions.** Call `get_project_is` to understand how to work within this project (coding style, PR workflow, tone, etc.).
3. **Get KB if needed.** Call `get_knowledge_base` and read files only when relevant to the task.
4. **Rank and pick.** Call `rank_tasks` for the project. This returns tasks scored by priority/due-date/skip-history. Pick the top one (unless the user specified a different task).
5. **Work.** Make changes, ask clarifying questions, think aloud. Get permission before destructive operations.
6. **Mark progress.** Use `complete_milestone` as you finish steps. Use `complete_task` only when fully done.
7. **Report.** Tell the user what you did, any blockers, and what's next.

### Multi-Task Work

When the user asks you to work on multiple tasks in a section:

- **Check user preference.** The user's AI preferences (set via `get_ai_instructions`) specify: collaborative (discuss each task, get input, execute) or autonomous (execute based on task context, report after).
- **Collaborative:** List all tasks, discuss them briefly, wait for user input, then execute.
- **Autonomous:** Execute in rank order. For each task: read context (detail field), make decisions, do the work, move to next.

### Error Handling

- **Task not found.** User asked for a task that doesn't exist? Offer to search by title or list alternatives.
- **Permission denied.** You hit a 401/403? Tell the user their API key may be invalid or expired. Ask them to reconnect.
- **Rate limits.** If MCP calls start failing, slow down and batch fewer calls per message.

### When to Use KB/IS

- **KB:** Call `get_knowledge_base` and browse files only when the task requires external reference (architecture, guidelines, prior decisions).
- **IS:** Already injected via `get_project_is`. Read it before starting work. Follow it exactly — it governs the project's style/workflow.

## Checklist: Before Claiming Work is Done

- ✅ All milestones marked complete?
- ✅ Task status set to done?
- ✅ User asked for verification or acceptance?
- ✅ Any follow-up tasks created and logged?
- ✅ Report includes what changed and why?

---

**Start here:** Ask the user which project/task to work on, call `get_project`, read IS, then proceed.
