# Tasker MCP — Tools Reference

**Audience:** Non-technical. This document explains what every Tasker MCP tool does and when Claude uses it — so you understand what is happening "under the hood" when you direct Claude Code to work on your tasks.

---

## What is MCP?

MCP stands for **Model Context Protocol**. It is a standard way for AI assistants (Claude Code, Cursor, etc.) to talk to external tools and services.

Without MCP, there is a wall between your AI and your task manager. You copy tasks into chat, the AI works, you go back to the task app and update it by hand. With MCP, that wall disappears. Claude Code can read, create, and update your Tasker data directly — as naturally as it reads your code files.

Each MCP "tool" is like a named action Claude can invoke. When you say "mark TDE-42 done and start on the next task," Claude does not guess — it calls specific tools in a specific order and gets structured results back from the server.

---

## How Tasker's MCP Works

Tasker's MCP server is a Supabase Edge Function that receives JSON-RPC calls from Claude Code. Claude sends: "call tool X with these inputs." The server executes the action against the database and returns a structured result. Claude reads that result and decides what to do next.

The tools are grouped below by what they operate on.

---

## 1. Session

### `__init_tasker_session`
**What it does:** The mandatory first call at the start of any Tasker session. Returns your saved behavioral preferences (how to display tasks, communication style, etc.) and the full directive playbook — the rules Claude must follow for the task lifecycle, flow execution, validation, and dependency enforcement.

**When Claude uses it:** Always, as the very first thing in a new conversation, before touching any task data.

---

## 2. Projects

A **project** is the top-level container. Everything — sections, tasks, flows, knowledge — lives inside a project.

### `list_projects`
Returns all your projects with name, prefix (e.g. TDE), progress stats, and the goal/why context.

**When used:** When you ask "what projects do I have?" or when Claude needs to find the right project before creating or listing tasks.

---

### `create_project`
Creates a new project with a name, prefix, goal, and why.

**When used:** When you start a new initiative and want it tracked separately.

---

### `get_project`
Fetches full detail for a single project — goal, scope, context, and all metadata.

**When used:** When Claude needs the project's context before making decisions (e.g. deciding what section a new task belongs in).

---

### `update_project`
Updates the name, prefix, or other metadata of a project.

**When used:** Rare — only when renaming or restructuring a project.

---

### `update_project_context`
Updates the goal, why, and scope fields of a project — the text that explains what the project is for and why it exists.

**When used:** When the project's direction shifts and the context needs to reflect the new reality.

---

### `delete_project`
Permanently deletes a project and everything inside it.

**When used:** Almost never — this is destructive and irreversible. Claude will always confirm with you before calling this.

---

## 3. Sections

A **section** is a logical grouping inside a project — like a phase, a feature area, or a workstream (e.g. "Core App", "Flows", "Bugs").

### `list_sections`
Returns all sections in a project with their IDs.

**When used:** When Claude needs to know where to place a new task, or when listing tasks by area.

---

### `create_section`
Creates a new section inside a project.

**When used:** When you add a new workstream or phase to a project.

---

### `delete_section`
Deletes a section (and all tasks inside it).

**When used:** Rarely, and only with your explicit confirmation — this is destructive.

---

## 4. Groups

A **group** is a named cluster of tasks inside a section — like a sprint bucket or a sub-feature. Groups are optional; tasks can exist without one.

### `list_groups`
Lists all groups in a section.

**When used:** When displaying tasks organized by group, or before creating a task to find the right group.

---

### `create_group`
Creates a new group inside a section.

**When used:** When you want to cluster related tasks together within a section.

---

### `rename_group`
Changes the name of an existing group.

**When used:** When a group's scope shifts and the name no longer fits.

---

### `delete_group`
Deletes a group (tasks inside it become ungrouped, not deleted).

**When used:** When reorganizing and the grouping no longer serves a purpose.

---

## 5. Tasks

A **task** is the core unit of work. It has a title, status, priority, due date, context/detail, and milestones. Status moves: `pending → in_progress → done`.

### `list_tasks`
Lists tasks in a project or section, filtered by status, group, or other criteria.

**When used:** Constantly — any time you ask "what's open?", "what's in the auth section?", or "what should I work on next?"

---

### `create_task`
Creates a single new task with title, section, priority, due date, and optional detail/context.

**When used:** When you identify a new piece of work. For multi-step processes with handoffs, `build_new_flow` is used instead.

---

### `get_task`
Fetches full detail for a single task — and automatically marks it `in_progress` as a side effect. Pass `peek: true` to read without starting it.

Also returns: the task's verdict block (if it has been judged), and a **Knowledge Base titles index** — a list of all KB entries for the project, so Claude can selectively pull relevant ones.

**When used:** At the start of working on any task. This is Claude's signal to the system that it has picked up the task.

---

### `update_task`
Updates any field of a task: title, priority, due date, status, detail.

**When used:** When a task's scope, priority, or context changes mid-stream.

---

### `complete_task`
Marks a task as done. Blocked if the task has unmet upstream flow dependencies. Also triggers a review nudge if the task has review enabled.

**When used:** When the work on a task is genuinely, verifiably complete.

---

### `uncomplete_task`
Reopens a done task back to `in_progress`.

**When used:** When a task that was marked done turns out to be incomplete — or when the judge reopens it after a failed review.

---

### `delete_task`
Permanently deletes a task.

**When used:** Rarely. Claude confirms with you first.

---

### `move_task_to_group`
Moves a task from one group to another (within the same section).

**When used:** When reorganizing tasks between group buckets.

---

### `rank_tasks`
Reorders tasks within a group or section by setting their sort position.

**When used:** When you ask Claude to reprioritize or reorder the task list.

---

### `clear_task_output`
Removes the stored output/artifact from a task (resets its deliverable).

**When used:** When a task's output needs to be regenerated from scratch — e.g. after a major revision to its requirements.

---

## 6. Milestones

A **milestone** is a discrete sub-step inside a task — a checkbox that marks one piece of the task complete. They provide granularity without creating separate tasks.

### `list_milestones`
Lists all milestones for a task.

**When used:** When reviewing progress on a task that has multiple sub-steps.

---

### `add_milestone`
Adds a new milestone to a task with a title and optional due date.

**When used:** When breaking a task into trackable sub-steps, or when a new step is discovered mid-execution.

---

### `complete_milestone`
Marks a milestone as done.

**When used:** After each sub-step of a task is finished.

---

### `uncomplete_milestone`
Reopens a completed milestone.

**When used:** When a milestone that was marked done turns out to need more work.

---

### `delete_milestone`
Removes a milestone from a task.

**When used:** When a planned sub-step is no longer needed.

---

## 7. The I/O System

The **Input/Output system** is how tasks are linked together. When one task's output becomes another task's required input, you get a dependency: the downstream task cannot start until the upstream one is done. This is the foundation of Flows.

### `set_task_output`
Defines what a task produces — its deliverable. This is called the task's **output contract**. It specifies the format and quality rules the output must satisfy.

**When used:** When authoring a flow, to define what each task hands to the next one.

---

### `set_task_input`
Links a task's required input to the output of another task, optionally with an **acceptance contract** — rules that the incoming output must pass before this task can begin.

**When used:** When wiring together tasks in a flow so that quality gates are enforced between steps.

---

### `remove_task_input`
Removes the dependency link between two tasks.

**When used:** When restructuring a flow and a dependency is no longer valid.

---

### `get_task_connections`
Returns all input and output links for a task — what it receives and what it produces.

**When used:** When inspecting a flow's structure or debugging a blocked task.

---

### `confirm_contract`
Marks a contract (output or acceptance) as reviewed and confirmed — signalling that the quality bar has been inspected and agreed on.

**When used:** During flow authoring review, after the human has seen and approved the quality rules.

---

## 8. Flows

A **flow** is a named, contract-linked chain of tasks with quality gates between each step. Instead of free-form work, a flow enforces: this task's output must pass these rules before the next task can start. Flows are Tasker's answer to multi-step, high-stakes work.

### `build_new_flow`
Returns the flow authoring playbook — the interview protocol Claude runs with you to design a flow: what tasks it contains, what each task produces, and what quality rules govern each handoff.

**When used:** When you want to build a new flow from scratch. Claude runs a grill-me-style interview (one question at a time, always recommending a path) and gets your confirmation on the whole design before persisting anything.

---

### `run_flow`
Starts executing a flow from the beginning (or from where it left off). Returns the execution playbook Claude follows: execute → store artifact → complete → validate → handle the result.

**When used:** When you say "run the flow" — Claude self-sequences through all steps, handling retries and escalations without interrupting you unless a gate fails and cannot be automatically resolved.

---

### `name_flow`
Assigns a human-readable name and optional context to a flow after all its tasks have been created and linked.

**When used:** At the end of flow authoring, after all `create_task` + `set_task_output` + `set_task_input` calls are done.

---

### `list_flows`
Lists all flows in a project with their names and member tasks.

**When used:** When you want to see what flows exist, or before running one.

---

### `delete_flow`
Removes the flow linkage (does not delete the tasks themselves — it just unlinks them).

**When used:** When a flow is no longer valid but you want to keep the tasks.

---

### `get_flow_context`
Returns the flow's context — the goal, constraints, and background that apply to all tasks in it.

**When used:** At the start of a flow run, so Claude orients itself to the flow's purpose before executing the first task.

---

### `update_flow_context`
Updates the flow's context — logs progress, decisions, or notes that future agents running this flow should know.

**When used:** During or after a flow run, to record what was decided and why, so the next run (or the next session) picks up with full context.

---

### `get_flow_order`
Returns the ordered sequence of tasks in a flow.

**When used:** When Claude needs to know which task comes next, or when auditing a flow's structure.

---

### `get_flow_audit`
Returns the full audit trail for a flow — every validation attempt, every result, every gate decision.

**When used:** When debugging a flow, reviewing quality history, or understanding why a task was reopened.

---

### `recompute_flow_steps`
Recalculates the flow's task ordering after structural changes (e.g. a task was added or a dependency was modified).

**When used:** After modifying a flow's structure — ensures the execution order is correct.

---

### `save_flow_as_template`
Saves a flow's structure (tasks + contracts, without content) as a reusable template.

**When used:** When a flow represents a repeatable process (e.g. an 8-step article production pipeline) that you want to instantiate again for new content.

---

### `list_flow_templates`
Lists all saved flow templates.

**When used:** Before instantiating a new flow, to see what templates exist.

---

### `instantiate_flow_template`
Creates a new flow from a saved template — generating all the tasks and links in one call.

**When used:** When starting a new instance of a repeatable process (e.g. a new article, a new onboarding run).

---

## 9. Validation / Gates

When a flow task completes, its output must pass a quality gate before the next task can start. This is handled by the validation system — a two-agent loop where an independent subagent (not the one that did the work) grades the output against the contract rules.

### `store_artifact`
Stores the verbatim output of a task on the server — the actual deliverable, not a summary. This is what the independent validator grades. It is required before completing any task with judgment-type output rules.

**When used:** After a task's work is done, before calling `complete_task`. The artifact is embedded server-side into the validator's prompt, so the validator reads it from the server (not from the executor's claims).

---

### `validate_output`
Returns the **validator agent prompt** — a complete, self-contained instruction set that an independent subagent uses to grade the stored artifact against the output contract rules. Contains the frozen bar and the artifact.

**When used:** When a task has judgment-type contract rules. Claude spawns a fresh Agent, passes it this prompt unmodified, and the subagent calls `submit_validation_result` with its verdict. Claude never grades judgment rules itself — independence is the point.

---

### `submit_validation_result`
Records the independent validator's verdict per rule (pass/fail with observed values and notes). Triggers the gate: if a blocker rule fails, the task is reopened and the executor gets a specific critique. After 3 failed attempts, escalates to the human.

**When used:** By the independent validator subagent, after grading the artifact.

---

### `get_task_critique`
Returns the clean critique from the last failed validation — the specific deficiencies the executor needs to address in the next regeneration attempt.

**When used:** When a gate fails and the human needs to be involved (the 3-attempt limit was hit). Claude calls this to get the structured critique and presents it to you via a dialog.

---

### `get_validation_feedback`
Returns the full validation history for a task — all attempts, all rule verdicts.

**When used:** When auditing why a task kept failing, or when the human wants to inspect the gate's reasoning.

---

## 10. Knowledge Base

The **Knowledge Base (KB)** is a per-project library of non-obvious learnings that Claude writes to and reads from across sessions. It is the project's "institutional memory" — things that would otherwise be reconstructed from scratch every time.

Every entry has: a title, content, source (`user` or `agent`), and category (architecture / database / deployment / mcp / flows / design / product / reference / other).

### `create_kb_entry`
Creates a new KB entry with title, content, category, and source.

**When used:** When Claude finishes a task and surfaces something non-obvious — a decision made, a constraint discovered, a gotcha that cost effort to learn. The Dynamic KB Rule (a universal Instruction Set rule) requires Claude to ask "did this work surface anything worth keeping?" before completing any task.

---

### `update_kb_entry`
Updates the content or metadata of an existing KB entry.

**When used:** When a previously recorded learning turns out to be wrong, incomplete, or outdated. The KB should reflect current truth, not history.

---

### `delete_kb_entry`
Permanently removes a KB entry.

**When used:** When an entry is no longer relevant and archiving is not enough.

---

### `get_knowledge_base`
Returns all non-archived KB entries for a project, optionally filtered by source (`user` or `agent`).

**When used:** When you explicitly ask to see the knowledge base, or when Claude needs full context for a broad decision.

---

### `get_kb_entries`
Returns full content for a specific set of KB entries, identified by ID or title. This is the **selective pull** — instead of dumping the whole KB, Claude reads the titles index (returned by `get_task`) and pulls only the few entries relevant to the current task.

**When used:** After `get_task` returns the KB titles index, Claude identifies which entries are relevant and calls this to pull just those. This keeps token usage low while ensuring the right context is available.

---

### `list_kb_entries`
Lists KB entries (titles + metadata only, no content). Supports filtering by source, category, or archived status.

**When used:** When inspecting what is in the KB without loading all the content.

---

### `archive_kb_entry`
Marks a KB entry as archived — it is hidden from normal queries but not deleted. Used for stale entries that are no longer current but may be worth keeping for historical reference.

**When used:** When an agent entry is outdated (e.g. describes a design that was replaced). Also triggered automatically by the KB Health daily sweep for agent-written entries that have not been reviewed or updated in a long time.

---

### `kb_health`
Returns a health report for the KB: counts by source and category, stale agent entries (old, unreviewed), and entries flagged for human review. Can also trigger a bulk archive of stale agent entries.

**When used:** When you want to audit the quality of the KB, or when Claude runs a periodic health check before a session's KB usage.

---

## 11. Instruction Sets

An **Instruction Set (IS)** is a set of standing rules that govern how Claude works on tasks in a project. Think of it as the project's style guide, code standards, and deployment rules — baked in once so Claude does not need to be reminded every session.

### `create_is_entry`
Creates a new IS entry with a title and content.

**When used:** When you establish a new standing rule for the project (e.g. "all new frontend code is JSX, no TypeScript").

---

### `update_is_entry`
Updates an existing IS entry.

**When used:** When a rule changes (e.g. you switch from one deploy target to another).

---

### `delete_is_entry`
Removes an IS entry.

**When used:** When a rule is no longer applicable.

---

### `list_is_entries`
Lists all IS entries for a project.

**When used:** When auditing what rules are in effect, or before adding a new one to check for duplicates.

---

### `get_project_is`
Returns the full content of all IS entries for a project — the complete instruction set.

**When used:** When Claude needs to check the full set of rules before making a decision (e.g. before writing code, to check the code style rules).

---

## 12. Flow-Level IS and KB

Flows can have their own Instruction Sets and Knowledge Base entries — rules and learnings that apply specifically to that flow, separate from the project-wide ones.

### `create_flow_is_entry` / `update_flow_is_entry` / `delete_flow_is_entry` / `list_flow_is_entries` / `get_flow_is`
The same as the project IS tools, but scoped to a specific flow. The flow IS travels with the flow — every task in it inherits these rules.

**When used:** When a flow has specific conventions that do not apply to the rest of the project (e.g. a content production flow with specific tone and format rules).

---

### `create_flow_kb_entry` / `update_flow_kb_entry` / `delete_flow_kb_entry` / `list_flow_kb_entries` / `get_flow_kb`
The same as the project KB tools, but scoped to a specific flow. Learnings recorded here are specific to this flow's execution history.

**When used:** When a flow run surfaces something that is only relevant to future runs of that same flow (e.g. "article topic X requires a longer research phase than average").

---

## 13. Task-Level Output Judge

The **judge** is an opt-in quality gate for standalone tasks (tasks that are not part of a flow). You author a bar — a set of acceptance rules — and Claude freezes it. When the task is done, an independent agent grades the output against the frozen bar.

This is separate from flow gates and cannot be used on flow tasks (they are governed by the flow's contracts instead).

### `enable_task_review`
Two modes:
- **Called without a bar:** Returns the task's text and Instruction Set as grounding, plus the KB titles index. This is the "dispenser" mode — Claude authors a bar from these inputs and shows it to you for confirmation.
- **Called with a bar:** Freezes the authored bar as a snapshot on the task, turning review on. The bar cannot be changed after freezing without using `force: true`.

**When used:** Before starting work on a task you want judged. You establish the bar first (before the executor runs), so the judge is grading against a pre-committed standard — not one invented after the fact.

---

### `review_task`
Returns the judge protocol for a review-enabled task: the frozen bar and the server-stored artifact, together. This is how independence is enforced — the artifact comes from the server, not from the executor's claims.

**When used:** After the task is marked done and the artifact is stored. Claude calls this to get the prompt it passes to the independent judge subagent.

---

### `submit_task_review`
Records the per-rule verdict from the judge. If any blocker rule fails: the task is reopened with a specific critique and the executor must try again (up to 3 times, then escalates to you). If all blockers pass: the task stays done and the verdict is stored on the task.

**When used:** By the independent judge subagent, after grading the artifact.

---

## 14. AI Instructions

These tools manage the standing directives you have configured for Claude's behavior in Tasker — things like "always show done tasks hidden" or "prefer detailed communication."

### `get_ai_instructions`
Returns the current behavioral instructions.

**When used:** When Claude needs to check your preferences before acting.

---

### `update_ai_instructions`
Updates your behavioral preferences.

**When used:** When you say "change settings" and Claude runs the settings questionnaire.

---

## 15. Section Analysis

### `analyze_section`
Runs a structural analysis of a section: task distribution, blockers, bottlenecks, and open questions. Returns a summary designed to surface problems proactively.

**When used:** When you want Claude to give you a health check on a section — not just list tasks, but flag what looks off.

---

### `section_insights`
Returns richer insights for a section: patterns across tasks, risk signals, and recommendations.

**When used:** During a planning or review conversation where you want Claude to reason about the section's state, not just report it.

---

## 16. GitHub Integration

These tools connect a Tasker project to a GitHub repository, enabling Claude to read files, push code, and sync issues directly from Tasker tasks.

### `github_connect`
Connects a GitHub account to Tasker.

### `github_disconnect`
Removes the GitHub connection.

### `github_list_repos`
Lists accessible repositories.

### `github_import_project`
Imports a GitHub repo's issues as a Tasker project (or section).

### `github_push_file`
Pushes a file to a connected repo.

### `github_push_project`
Pushes a full project's task structure to a repo (as structured data).

### `github_push_task`
Pushes a single task (and its artifact) to a repo.

### `github_read_file`
Reads a file from a connected repo.

### `github_sync_issues`
Syncs open GitHub issues into Tasker tasks.

**When used:** These tools are part of the "repo-native" direction — the idea that Tasker's task structure lives alongside your code in the repo, so your tasks and your codebase are always in sync.

---

## Summary: The Mental Model

| Layer | What it is | Tools |
|---|---|---|
| **Projects / Sections / Groups** | Hierarchy and organization | list, create, update, delete |
| **Tasks / Milestones** | The actual work units | create, get, complete, rank |
| **I/O System** | How tasks talk to each other | set_task_output, set_task_input |
| **Flows** | Multi-step work with quality gates | build_new_flow, run_flow |
| **Validation** | Independent quality checking | store_artifact, validate_output, submit_validation_result |
| **Knowledge Base** | Project memory that grows over time | create_kb_entry, get_kb_entries |
| **Instruction Sets** | Standing rules that govern Claude's behavior | create_is_entry, get_project_is |
| **Judge** | Opt-in output gate for standalone tasks | enable_task_review, review_task, submit_task_review |
| **GitHub** | Code ↔ task sync | github_push_*, github_read_file |

The entire system is designed around one idea: **the AI is a first-class user of the task manager, not a bystander.** Every tool exists to make the loop between "what needs doing" and "what got done" tight, automatic, and high-quality — without you being the integration layer in the middle.
