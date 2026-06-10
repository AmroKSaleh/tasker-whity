# Flow-level Instruction Sets & Knowledge Bases (TDE-233)

**Date:** 2026-06-10
**Status:** Approved design — ready for implementation
**Approach:** A (dedicated flow tables, mirroring the existing project IS/KB pattern)

## Problem

A flow is a distinct unit of work, but today it is governed only by **project-level**
rules: project IS (`project_instructions`) is auto-injected into every `get_task`, and
project KB is pulled on demand. Flows have just one free-text `context` field. There is
no way to give a flow its own instruction set or knowledge base, and no way for a flow's
rules to take precedence over the project's. This task adds flow-level IS and KB with
flow-first governance.

## Decisions (from the design discussion)

1. **IS precedence — Replace.** For a task in a flow that has its own IS, the flow IS
   governs; the project's IS is suppressed for that task — EXCEPT:
2. **Universals still apply.** Project IS entries marked `universal: true` (short IDs,
   deploy rules, code style, etc.) always apply, even inside a flow. So a flow task sees
   *universal project IS + flow IS*.
3. **Flow KB — auto on every flow task.** Whenever a flow has KB entries, they are
   injected into every `get_task` for tasks in that flow (like IS injection), independent
   of whether the flow has IS.

## Resulting injection behavior (`get_task`)

| Task situation | What `get_task` injects |
|---|---|
| Not in a flow | Full project IS (unchanged from today) |
| In a flow, flow has IS | Universal project IS + flow IS (non-universal project IS suppressed) |
| In a flow, flow has no IS | Full project IS (safe fallback — nothing to replace with) |
| In a flow, flow has KB | Flow KB injected as well (independent of the IS branch) |

Net for a fully-configured flow task: **universal project IS + flow IS + flow KB.**

## Data model

- **New table `flow_instructions`** — `id, user_id, flow_id (FK flows.id), title, content,
  created_at, updated_at`. Mirrors `project_instructions`.
- **New table `flow_kb`** — same shape, keyed by `flow_id`. Mirrors the project KB table.
- **Alter `project_instructions`** — add `universal boolean NOT NULL DEFAULT false`.
- RLS on both new tables scoped by `user_id`, matching the existing tables. `flow_id`
  FK with `ON DELETE CASCADE` so `delete_flow` cleans up its IS/KB rows.

## MCP tools

Flow IS (all accept `flow_id` OR any `task_id` in the flow, consistent with other flow tools):
- `get_flow_is` — full flow IS
- `list_flow_is_entries` — id + title + updated_at
- `create_flow_is_entry` — { flow_id|task_id, title, content }
- `update_flow_is_entry` — { entry_id, title?, content? }
- `delete_flow_is_entry` — { entry_id }

Flow KB — the same five (`get_flow_kb`, `list_flow_kb_entries`, `create_flow_kb_entry`,
`update_flow_kb_entry`, `delete_flow_kb_entry`).

Universal marking — add a `universal` boolean param to the existing project-IS tools
`create_is_entry` and `update_is_entry` (no new tool).

`get_task` injection logic updated per the table above. Rendered sections in the
`get_task` response: `# Project Instruction Set (universal)`, `# Flow Instruction Set`,
`# Flow Knowledge Base` (only the applicable ones shown).

## Rollout

Existing project IS entries default to `universal: false`. No flows have flow IS yet, so
day-one behavior is unchanged. When a user first gives a flow its own IS, they mark which
project rules are universal so those carry through.

## Out of scope (follow-up task)

App UI for viewing/editing flow IS/KB (the board's IS/KB buttons, Blueprint surfacing).
This design is MCP-first: authoring + injection happen through the MCP. UI is a separate
task.

## Verification

Create a test flow; add flow IS + flow KB; mark one project IS entry `universal`. Then:
- `get_task` on a flow task → shows universal project IS + flow IS + flow KB; non-universal
  project IS is gone.
- `get_task` on a non-flow task → shows full project IS (unchanged).
- `delete_flow` → flow IS/KB rows cascade-deleted.
