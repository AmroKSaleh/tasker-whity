// Developer / MCP docs track for /docsV2 (flow TDE-218–223, step ③).

const MCP_URL = 'https://rzjhmipbamyvpwlkfvxx.supabase.co/functions/v1/mcp'

export const NAV_MCP_V2 = [
  {
    section: 'Developer / MCP Guide',
    items: [
      { slug: 'dev', title: 'Overview', purpose: 'How the Tasker MCP server works.' },
      { slug: 'dev/claude-code', title: 'Claude Code Setup', purpose: 'Connect Tasker MCP to Claude Code.' },
      { slug: 'dev/cursor', title: 'Cursor Setup', purpose: 'Connect Tasker MCP to Cursor.' },
      { slug: 'dev/windsurf', title: 'Windsurf Setup', purpose: 'Connect Tasker MCP to Windsurf.' },
      { slug: 'dev/roo', title: 'Roo Cline Setup', purpose: 'Connect Tasker MCP to Roo Cline.' },
      { slug: 'dev/tools', title: 'Tool Reference', purpose: 'All 65 MCP tools with parameters and examples.' },
    ],
  },
]

export const PAGES_MCP_V2 = {
  'dev': `# Developer Overview

Tasker exposes a **Model Context Protocol (MCP) server** that lets AI assistants — Claude Code, Cursor, Windsurf, Roo Cline — read and write your tasks, run flows, validate output contracts, and manage your full project hierarchy directly from their chat interfaces.

## What the MCP server enables

- Your AI can create, update, and complete tasks without you switching to the app
- Flows with quality gates run step-by-step, with AI validators checking each output
- Project context, Knowledge Base, and AI Instructions are accessible in-session
- GitHub integration for syncing issues

## Architecture

\`\`\`
Your AI client (Claude Code / Cursor / Windsurf / Roo)
        │
        │  HTTP (MCP protocol)
        ▼
Tasker MCP Server (Supabase Edge Function)
  ${MCP_URL}
        │
        ▼
Supabase Postgres (your data)
\`\`\`

## Authentication

All requests require an **API key** passed in the \`Authorization\` header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

Get your API key from the Tasker app: **Settings → API Keys → Generate Key**. Keys start with \`tsk_\`.

## Client setup guides

- [Claude Code](/docsV2/dev/claude-code)
- [Cursor](/docsV2/dev/cursor)
- [Windsurf](/docsV2/dev/windsurf)
- [Roo Cline](/docsV2/dev/roo)`,

  'dev/claude-code': `# Claude Code Setup

## Prerequisites
- Claude Code installed (via the desktop app or \`npm install -g @anthropic/claude-code\`)
- A Tasker API key (see [Developer Overview](/docsV2/dev))

## Configuration

Edit \`~/.claude.json\` (your global Claude Code config). Add the \`mcpServers\` block — or merge it into your existing one if already present:

\`\`\`json
{
  "mcpServers": {
    "tasker": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Replace \`YOUR_API_KEY\` with your actual \`tsk_…\` key.

## Verify

Restart Claude Code. In any project session, run:

\`\`\`
list_projects
\`\`\`

If you see your projects listed, the MCP connection is working.

## First session tip

Start each session with:

\`\`\`
__init_tasker_session
\`\`\`

This authenticates your session and returns your project list with context.`,

  'dev/cursor': `# Cursor Setup

## Prerequisites
- Cursor installed (cursor.sh)
- A Tasker API key (see [Developer Overview](/docsV2/dev))

## Configuration

Create or edit \`~/.cursor/mcp.json\` (global) or \`.cursor/mcp.json\` in your project root:

\`\`\`json
{
  "mcpServers": {
    "tasker": {
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Replace \`YOUR_API_KEY\` with your actual \`tsk_…\` key.

## Alternative: Cursor Settings UI

1. Open Cursor → Settings → MCP
2. Click **Add Server**
3. Set URL to \`${MCP_URL}\`
4. Add header \`Authorization: Bearer YOUR_API_KEY\`
5. Save and reload

## Verify

In Cursor's chat, type:

\`\`\`
list_projects
\`\`\``,

  'dev/windsurf': `# Windsurf Setup

## Prerequisites
- Windsurf installed (codeium.com/windsurf)
- A Tasker API key (see [Developer Overview](/docsV2/dev))

## Configuration

Edit \`~/.codeium/windsurf/mcp_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "tasker": {
      "serverUrl": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Replace \`YOUR_API_KEY\` with your actual \`tsk_…\` key.

**Note:** Windsurf uses \`serverUrl\` (not \`url\`) — copy the snippet exactly.

## Verify

In Windsurf's Cascade chat, type:

\`\`\`
list_projects
\`\`\``,

  'dev/roo': `# Roo Cline Setup

## Prerequisites
- VS Code with the Roo Cline extension installed
- A Tasker API key (see [Developer Overview](/docsV2/dev))

## Configuration

**Windows:** Edit \`%APPDATA%\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json\`

**Mac/Linux:** Edit \`~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json\`

\`\`\`json
{
  "mcpServers": {
    "tasker": {
      "type": "streamable-http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Replace \`YOUR_API_KEY\` with your actual \`tsk_…\` key.

**Note:** Roo Cline uses \`type: "streamable-http"\` — required for proper streaming.

## Verify

In Roo Cline's chat, type:

\`\`\`
list_projects
\`\`\``,

  'dev/tools': `# Tool Reference

Complete reference for all 65 Tasker MCP tools. Organized by domain. Each tool shows: description, parameters, and a usage example.

**Parameter notation:** \`param\` = required, \`param?\` = optional.

---

## Session

### \`__init_tasker_session\`
Initialize a Tasker session. Authenticates your API key and returns your project list with context. Call this at the start of every AI session.

**Parameters:** none

**Example:** \`__init_tasker_session\`

---

## Projects

### \`list_projects\`
List all projects for the authenticated user.

**Parameters:** none · **Example:** \`list_projects\`

---

### \`get_project\`
Get full project details including context, sections count, and metadata.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Project prefix (e.g. \`TDE\`), slug, or UUID |

**Example:** \`get_project(project_id: "TDE")\`

---

### \`create_project\`
Create a new project.

| Parameter | Type | Description |
|---|---|---|
| \`name\` | string | Project display name |
| \`prefix?\` | string | 2–6 letter prefix for task IDs |
| \`slug?\` | string | URL-safe identifier |

**Example:** \`create_project(name: "Landing Page Redesign", prefix: "LPR")\`

---

### \`update_project\`
Update a project's name or context.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`name?\` | string | New display name |
| \`context?\` | string | Project context (shown to AI) |

**Example:** \`update_project(project_id: "TDE", context: "React + Vite + Supabase stack.")\`

---

### \`update_project_context\`
Update only the project context field.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`context\` | string | New context text |

**Example:** \`update_project_context(project_id: "TDE", context: "Tasker — React frontend, Supabase backend.")\`

---

### \`delete_project\`
Permanently delete a project and all its data.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`delete_project(project_id: "OLD")\`

---

## Sections

### \`list_sections\`
List all sections in a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`list_sections(project_id: "TDE")\`

---

### \`create_section\`
Create a new section in a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`name\` | string | Section name |

**Example:** \`create_section(project_id: "TDE", name: "Documentation")\`

---

## Groups

### \`list_groups\`
List all groups in a section.

| Parameter | Type | Description |
|---|---|---|
| \`section_id\` | string | Section UUID or name |

**Example:** \`list_groups(section_id: "Documentation")\`

---

### \`create_group\`
Create a new group in a section.

| Parameter | Type | Description |
|---|---|---|
| \`section_id\` | string | Section UUID or name |
| \`name\` | string | Group name |

**Example:** \`create_group(section_id: "Documentation", name: "In Progress")\`

---

### \`rename_group\`
Rename an existing group.

| Parameter | Type | Description |
|---|---|---|
| \`group_id\` | string | Group UUID |
| \`name\` | string | New name |

**Example:** \`rename_group(group_id: "abc-123", name: "Backlog")\`

---

### \`delete_group\`
Delete a group.

| Parameter | Type | Description |
|---|---|---|
| \`group_id\` | string | Group UUID |

**Example:** \`delete_group(group_id: "abc-123")\`

---

## Tasks

### \`list_tasks\`
List tasks, optionally filtered.

| Parameter | Type | Description |
|---|---|---|
| \`project_id?\` | string | Filter by project |
| \`section_id?\` | string | Filter by section |
| \`group_id?\` | string | Filter by group |
| \`status?\` | string | \`pending\`, \`in_progress\`, or \`done\` |

**Example:** \`list_tasks(project_id: "TDE", status: "pending")\`

---

### \`get_task\`
Get full task details and auto-set it to in_progress. Pass \`peek: true\` to inspect without starting.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID (e.g. \`TDE-31\`) or UUID |
| \`peek?\` | boolean | Read without changing status |

**Example:** \`get_task(task_id: "TDE-218")\`

---

### \`create_task\`
Create a new task in a group.

| Parameter | Type | Description |
|---|---|---|
| \`group_id\` | string | Group UUID |
| \`text\` | string | Task title |
| \`priority?\` | string | \`low\`, \`medium\`, \`high\`, \`rush\` |
| \`due_date?\` | string | ISO date string |

**Example:** \`create_task(group_id: "abc-123", text: "Write the API reference", priority: "high")\`

---

### \`update_task\`
Update task fields.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`text?\` | string | New title |
| \`priority?\` | string | New priority |
| \`due_date?\` | string | New due date |
| \`context?\` | string | Notes / context |

**Example:** \`update_task(task_id: "TDE-5", priority: "rush", context: "Needed for the Monday demo.")\`

---

### \`complete_task\`
Mark a task as done.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`complete_task(task_id: "TDE-218")\`

---

### \`uncomplete_task\`
Reopen a completed task.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`uncomplete_task(task_id: "TDE-218")\`

---

### \`delete_task\`
Permanently delete a task.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`delete_task(task_id: "TDE-99")\`

---

### \`move_task_to_group\`
Move a task to a different group.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`group_id\` | string | Target group UUID |

**Example:** \`move_task_to_group(task_id: "TDE-5", group_id: "xyz-456")\`

---

### \`rank_tasks\`
Reorder tasks within a group.

| Parameter | Type | Description |
|---|---|---|
| \`tasks\` | array | Ordered list of task IDs |

**Example:** \`rank_tasks(tasks: ["TDE-3", "TDE-1", "TDE-5"])\`

---

## Milestones

### \`list_milestones\`
List all milestones on a task.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`list_milestones(task_id: "TDE-7")\`

---

### \`add_milestone\`
Add a milestone to a task.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`text\` | string | Milestone description |

**Example:** \`add_milestone(task_id: "TDE-7", text: "Deploy to staging")\`

---

### \`complete_milestone\`
Mark a milestone as done.

| Parameter | Type | Description |
|---|---|---|
| \`milestone_id\` | string | Milestone UUID |

**Example:** \`complete_milestone(milestone_id: "ms-uuid")\`

---

### \`uncomplete_milestone\`
Reopen a completed milestone.

| Parameter | Type | Description |
|---|---|---|
| \`milestone_id\` | string | Milestone UUID |

**Example:** \`uncomplete_milestone(milestone_id: "ms-uuid")\`

---

### \`delete_milestone\`
Delete a milestone.

| Parameter | Type | Description |
|---|---|---|
| \`milestone_id\` | string | Milestone UUID |

**Example:** \`delete_milestone(milestone_id: "ms-uuid")\`

---

## I/O & Dependencies

### \`set_task_output\`
Define what a task produces.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`output\` | string | Description of the task's output |

**Example:** \`set_task_output(task_id: "TDE-3", output: "Approved color palette: primary #1E3A5F, secondary #D97757")\`

---

### \`set_task_input\`
Connect a task's input to another task's output.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | The consuming task |
| \`source_task_id\` | string | The producing task |
| \`input\` | string | What this task needs from the source |

**Example:** \`set_task_input(task_id: "TDE-5", source_task_id: "TDE-3", input: "The approved color palette")\`

---

### \`get_task_connections\`
View a task's input and output connections.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`get_task_connections(task_id: "TDE-5")\`

---

## Flows & Validation

### \`list_flows\`
List all named flows in a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`list_flows(project_id: "TDE")\`

---

### \`run_flow\`
Get the full execution playbook for a flow.

| Parameter | Type | Description |
|---|---|---|
| \`flow_id?\` | string | Flow UUID or partial name |
| \`task_id?\` | string | Any task in the flow |
| \`project_id?\` | string | Narrows name lookup |

**Example:** \`run_flow(flow_id: "define docs structure")\`

---

### \`get_flow_order\`
Get the ordered step list for a flow.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Any task in the flow |

**Example:** \`get_flow_order(task_id: "TDE-218")\`

---

### \`build_new_flow\`
Build a new named flow from scratch.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`section_id\` | string | Section for the new tasks |
| \`steps\` | array | Step definitions with text and contracts |

**Example:** \`build_new_flow(project_id: "TDE", section_id: "Documentation", steps: [...])\`

---

### \`name_flow\`
Give a name to an existing flow.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Any task in the flow |
| \`name\` | string | Flow name |

**Example:** \`name_flow(task_id: "TDE-194", name: "Define docs structure")\`

---

### \`get_flow_context\`
Get the shared context bag for a flow.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Any task in the flow |

**Example:** \`get_flow_context(task_id: "TDE-218")\`

---

### \`update_flow_context\`
Update the shared context for a flow, or rename it.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Any task in the flow |
| \`context\` | string | New context (replaces existing) |
| \`name?\` | string | Optional: rename the flow |

**Example:** \`update_flow_context(task_id: "TDE-218", context: "Target route: /docsV2")\`

---

### \`store_artifact\`
Store the produced output for a task before completing it. Required before \`complete_task\` on tasks with judgment output rules.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`content\` | string | The actual produced output (verbatim) |
| \`format?\` | string | \`text\`, \`markdown\`, \`code\`, or \`json\` |

**Example:** \`store_artifact(task_id: "TDE-218", content: "# Docs Structure\\n...", format: "markdown")\`

---

### \`validate_output\`
Get the validator prompt for a task's output contract.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | The producing task |
| \`target_task_id?\` | string | Which consumer edge to validate |

**Example:** \`validate_output(task_id: "TDE-218", target_task_id: "TDE-219")\`

---

### \`submit_validation_result\`
Submit the results of an independent validation pass.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | The producing task |
| \`target_task_id\` | string | The consumer task |
| \`validator\` | string | Validator identifier |
| \`results\` | array | Array of \`{rule_id, status, note, observed_value?}\` |

**Example:** \`submit_validation_result(task_id: "TDE-218", target_task_id: "TDE-219", validator: "independent-subagent", results: [{rule_id: "r1", status: "pass", note: "All 8 pages listed."}])\`

---

### \`get_task_critique\`
Get a critique of a task's current output.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`get_task_critique(task_id: "TDE-218")\`

---

### \`get_validation_feedback\`
Get the feedback from the most recent validation pass.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`get_validation_feedback(task_id: "TDE-218")\`

---

### \`get_flow_audit\`
Get the full validation audit trail for a flow.

| Parameter | Type | Description |
|---|---|---|
| \`flow_id\` | string | Flow UUID |

**Example:** \`get_flow_audit(flow_id: "678ee7bc-9209-4802-ad59-5c209f1ce19d")\`

---

### \`confirm_contract\`
Human-bless a contract rule.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |
| \`edge?\` | string | Which edge to confirm |

**Example:** \`confirm_contract(task_id: "TDE-218")\`

---

## Knowledge Base

### \`get_knowledge_base\`
Get the full Knowledge Base for a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`get_knowledge_base(project_id: "TDE")\`

---

### \`list_kb_entries\`
List all KB entries in a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`list_kb_entries(project_id: "TDE")\`

---

### \`create_kb_entry\`
Add a new Knowledge Base entry.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`title\` | string | Entry title |
| \`content\` | string | Entry content |

**Example:** \`create_kb_entry(project_id: "TDE", title: "Tech Stack", content: "React + Vite + Supabase")\`

---

### \`update_kb_entry\`
Update a KB entry.

| Parameter | Type | Description |
|---|---|---|
| \`entry_id\` | string | Entry UUID |
| \`title?\` | string | New title |
| \`content?\` | string | New content |

**Example:** \`update_kb_entry(entry_id: "kb-uuid", content: "Updated June 2026")\`

---

### \`delete_kb_entry\`
Delete a Knowledge Base entry.

| Parameter | Type | Description |
|---|---|---|
| \`entry_id\` | string | Entry UUID |

**Example:** \`delete_kb_entry(entry_id: "kb-uuid")\`

---

## AI Instructions

### \`get_ai_instructions\`
Get the AI instructions for a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`get_ai_instructions(project_id: "TDE")\`

---

### \`update_ai_instructions\`
Update the AI instructions for a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`instructions\` | string | New instructions text |

**Example:** \`update_ai_instructions(project_id: "TDE", instructions: "Always use short task IDs.")\`

---

### \`get_project_is\`
Get the full Instruction Set for a project.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`get_project_is(project_id: "TDE")\`

---

### \`list_is_entries\`
List all Instruction Set entries.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`list_is_entries(project_id: "TDE")\`

---

### \`create_is_entry\`
Add a new Instruction Set entry.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`title\` | string | Entry title |
| \`content\` | string | Entry content |

**Example:** \`create_is_entry(project_id: "TDE", title: "Deploy Rule", content: "MCP → Supabase with --no-verify-jwt.")\`

---

### \`update_is_entry\`
Update an Instruction Set entry.

| Parameter | Type | Description |
|---|---|---|
| \`entry_id\` | string | Entry UUID |
| \`title?\` | string | New title |
| \`content?\` | string | New content |

**Example:** \`update_is_entry(entry_id: "is-uuid", content: "Updated rule.")\`

---

### \`delete_is_entry\`
Delete an Instruction Set entry.

| Parameter | Type | Description |
|---|---|---|
| \`entry_id\` | string | Entry UUID |

**Example:** \`delete_is_entry(entry_id: "is-uuid")\`

---

## Section Analysis

### \`analyze_section\`
Analyze a section's task distribution and health.

| Parameter | Type | Description |
|---|---|---|
| \`section_id\` | string | Section UUID or name |

**Example:** \`analyze_section(section_id: "Documentation")\`

---

### \`section_insights\`
Get AI-generated insights for a section.

| Parameter | Type | Description |
|---|---|---|
| \`section_id\` | string | Section UUID or name |

**Example:** \`section_insights(section_id: "Documentation")\`

---

## GitHub

### \`github_connect\`
Connect a Tasker project to a GitHub repository.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |
| \`repo\` | string | \`owner/repo\` format |

**Example:** \`github_connect(project_id: "TDE", repo: "Xardoxis/tasker")\`

---

### \`github_disconnect\`
Disconnect a Tasker project from GitHub.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`github_disconnect(project_id: "TDE")\`

---

### \`github_list_repos\`
List GitHub repositories accessible to the authenticated user.

**Parameters:** none · **Example:** \`github_list_repos\`

---

### \`github_import_project\`
Import a GitHub repository as a new Tasker project.

| Parameter | Type | Description |
|---|---|---|
| \`repo\` | string | \`owner/repo\` format |

**Example:** \`github_import_project(repo: "Xardoxis/my-app")\`

---

### \`github_push_project\`
Push a Tasker project's tasks to GitHub as issues.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`github_push_project(project_id: "TDE")\`

---

### \`github_push_task\`
Push a single task to GitHub as an issue.

| Parameter | Type | Description |
|---|---|---|
| \`task_id\` | string | Short ID or UUID |

**Example:** \`github_push_task(task_id: "TDE-42")\`

---

### \`github_sync_issues\`
Sync GitHub issues back into Tasker tasks.

| Parameter | Type | Description |
|---|---|---|
| \`project_id\` | string | Prefix, slug, or UUID |

**Example:** \`github_sync_issues(project_id: "TDE")\``,
}
