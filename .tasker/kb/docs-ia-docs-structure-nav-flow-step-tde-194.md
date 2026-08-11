# Docs IA — /docs structure & nav (flow step ①, TDE-194)

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Tasker Documentation — Information Architecture

Deliverable of flow step ① (TDE-194). The approved outline + route/nav plan that the two drafting tracks consume: TDE-195 (end-user app guide) and TDE-196 (developer / MCP docs). Lives as a `/docs` route in the app (Vite + React). Two audiences: **AI-native web-app users** and **developers connecting via MCP**.

## Top-level nav
1. Getting Started
2. Using the App  (end-user track → TDE-195)
3. Developers / MCP  (dev track → TDE-196)
4. Integrations
5. Reference

---

## 1. Getting Started  `/docs`
- **Welcome / What is Tasker** `/docs` — what Tasker is in one paragraph; the two ways to use it (web app vs. MCP-with-your-own-AI); who it's for.
- **Quickstart** `/docs/quickstart` — account → first project → first task in ~2 minutes; pick your path (app or MCP).
- **Core concepts** `/docs/concepts` — the vocabulary: projects, sections, groups, tasks, statuses, flows, contracts. The mental model used everywhere else.

## 2. Using the App  (end-user — TDE-195)
- **Projects** `/docs/app/projects` — create a project, custom prefix, default project, import from a GitHub repo.
- **Sections & Groups** `/docs/app/sections` — organizing tasks; the default Backlog; reordering.
- **Tasks** `/docs/app/tasks` — create; status (pending / in-progress / done); priority; due dates; pinning; context/detail; milestones.
- **Today & Focus** `/docs/app/today` — the Today view, buckets, ranking, Focus mode.
- **Flows** `/docs/app/flows` — what a flow is (a chain of contract-linked tasks); the Flows page; reading a flow (graph + step list + contracts). NOTE: read-only today; interactive later.
- **Search & navigation** `/docs/app/search` — ⌘K global search, the nav rail.
- **Settings** `/docs/app/settings` — account, your MCP API key, integrations, dark mode.

## 3. Developers / MCP  (dev track — TDE-196)
- **Overview** `/docs/mcp` — what the Tasker MCP is; "bring your own Claude"; the lens model (Tasker is the structure, your agent is the engine); free vs. paid (single repo vs. across repos/team).
- **Setup** `/docs/mcp/setup` — get your API key (Settings), then connect per client:
  - Claude Code `/docs/mcp/setup/claude-code`
  - Cursor `/docs/mcp/setup/cursor`
  - Windsurf `/docs/mcp/setup/windsurf`
  - Roo Code `/docs/mcp/setup/roo`
- **Tool reference** `/docs/mcp/tools` — every MCP tool with params + an example, grouped:
  - Projects & sections (list/create/update_project, list/create_section, …)
  - Tasks (get_task, create_task, update_task, complete_task, list_tasks, rank_tasks, move/group, milestones)
  - Flows & contracts (build_new_flow, set_task_input, set_task_output, validate_output, submit_validation_result, get_flow_order, get_task_connections)
  - Knowledge base & instructions (kb_*, get/update_ai_instructions, get_project_is, create_is_entry)
  - GitHub (github_connect, github_import_project, github_push_task/project, github_sync_issues)
- **Flows & contracts guide** `/docs/mcp/flows` — authoring a flow with build_new_flow; the contract model (input/output, blocker/warning, check/judgment); the validate → submit_validation_result loop; fan-in/fan-out.
- **Session behavior** `/docs/mcp/session` — __init_tasker_session, the standing directives, auto-set-in-progress, dependency/flow blocking prompts.

## 4. Integrations  `/docs/integrations`
- **GitHub** `/docs/integrations/github` — connect, import a repo as a project, push tasks back, sync issues, manual-push safety model.
- **Google Calendar & Tasks** `/docs/integrations/google` — calendar on Today; Google Tasks sync (if/when shipped).

## 5. Reference  `/docs/reference`
- **Plans & limits** `/docs/reference/plans` — free vs. paid tier limits.
- **Keyboard shortcuts** `/docs/reference/shortcuts` — ⌘K, focus toggle, etc.
- **Edge cases & gotchas** `/docs/reference/gotchas` — known constraints (absorbs TDE-121); e.g. reconnect MCP after tool changes, short-ID gaps.
- **Changelog** `/docs/reference/changelog` — version history.

---
## Notes for drafting
- End-user pages (section 2): non-technical voice, no code/MCP jargon required; one concrete example or screenshot placeholder per page.
- Dev pages (section 3): runnable, accurate-to-live snippets; full tool coverage.
- Pull source material from KB entries: "Architecture Overview", "MCP Tool Reference", "Tech Stack", "Known Constraints", "137 Contract Layer — Design Decisions", "Flow's Messaging Angle"; and scattered tasks TDE-33/100/116/117/121.
- Cross-link: app Flows page ↔ MCP flows guide; setup ↔ tool reference.
