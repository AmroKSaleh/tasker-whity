// Developer / MCP docs track (flow step ③ / TDE-196): Developers/MCP, Integrations, Reference.
// Bodies are markdown strings (double-quoted so inline `code` and ```fences``` need no escaping).

const MCP_URL = 'https://rzjhmipbamyvpwlkfvxx.supabase.co/functions/v1/mcp'

export const NAV_MCP = [
  {
    section: 'Developers / MCP',
    items: [
      { slug: 'mcp', title: 'Overview', purpose: 'What the Tasker MCP is and the lens model.' },
      { slug: 'mcp/setup', title: 'Setup', purpose: 'Get your key and connect your agent.' },
      { slug: 'mcp/setup/claude-code', title: 'Claude Code', purpose: 'Connect Tasker to Claude Code.' },
      { slug: 'mcp/setup/cursor', title: 'Cursor', purpose: 'Connect Tasker to Cursor.' },
      { slug: 'mcp/setup/windsurf', title: 'Windsurf', purpose: 'Connect Tasker to Windsurf.' },
      { slug: 'mcp/setup/roo', title: 'Roo Code', purpose: 'Connect Tasker to Roo Code.' },
      { slug: 'mcp/tools', title: 'Tool reference', purpose: 'Every MCP tool, grouped.' },
      { slug: 'mcp/flows', title: 'Flows & contracts', purpose: 'Author and run flows via the MCP.' },
      { slug: 'mcp/session', title: 'Session behavior', purpose: 'Init, directives, auto in-progress.' },
    ],
  },
  {
    section: 'Integrations',
    items: [
      { slug: 'integrations/github', title: 'GitHub', purpose: 'Import repos, push tasks, sync issues.' },
      { slug: 'integrations/google', title: 'Google Calendar & Tasks', purpose: 'Calendar on Today; Tasks sync.' },
    ],
  },
  {
    section: 'Reference',
    items: [
      { slug: 'reference/plans', title: 'Plans & limits', purpose: 'Free vs. paid.' },
      { slug: 'reference/shortcuts', title: 'Keyboard shortcuts', purpose: 'Get around faster.' },
      { slug: 'reference/gotchas', title: 'Edge cases & gotchas', purpose: 'Known constraints.' },
      { slug: 'reference/changelog', title: 'Changelog', purpose: 'Version history.' },
    ],
  },
]

export const PAGES_MCP = {
  'mcp': "# The Tasker MCP\n\nThe Tasker MCP server lets your own AI agent — Claude Code, Cursor, Windsurf, Roo — read and update your Tasker workspace while it works. You **bring your own AI**; Tasker provides the structure it operates on.\n\nThe model: **Tasker is the lens, your agent is the engine.** Your agent already knows how to write code, plan, and iterate. Tasker adds the durable structure around that work — projects, tasks, and especially **flows with human-authored contracts** the agent is held to, so it can't quietly declare work \"done\" when it isn't.\n\nNext: [Setup](/docs/mcp/setup), then the [Tool reference](/docs/mcp/tools) and the [Flows & contracts guide](/docs/mcp/flows).",

  'mcp/setup': "# Setup\n\n## 1. Get your API key\nIn the app, go to **Settings → API key** and copy your key (it looks like `tsk_…`).\n\n## 2. Add the MCP server\nPoint your client at the Tasker MCP endpoint and pass your key as a Bearer token:\n\n```\n" + MCP_URL + "\n```\n\nPick your client for exact steps:\n\n- [Claude Code](/docs/mcp/setup/claude-code)\n- [Cursor](/docs/mcp/setup/cursor)\n- [Windsurf](/docs/mcp/setup/windsurf)\n- [Roo Code](/docs/mcp/setup/roo)\n\n## 3. Verify\nAsk your agent to *list your projects*. If it returns them, you're connected.\n\n> After changing tools server-side, **reconnect/restart your client** — clients cache the tool list when they connect.",

  'mcp/setup/claude-code': "# Connect Claude Code\n\nAdd Tasker to your MCP servers in `~/.claude.json`:\n\n```json\n{\n  \"mcpServers\": {\n    \"tasker\": {\n      \"url\": \"" + MCP_URL + "\",\n      \"headers\": { \"Authorization\": \"Bearer tsk_your_key_here\" }\n    }\n  }\n}\n```\n\nRestart Claude Code, then ask it to *list your Tasker projects* to confirm. Replace `tsk_your_key_here` with the key from **Settings → API key**.",

  'mcp/setup/cursor': "# Connect Cursor\n\nAdd Tasker as an MCP server in Cursor's MCP settings, using the endpoint below and your `tsk_…` key as a Bearer token:\n\n```\n" + MCP_URL + "\n```\n\nReload Cursor after adding it. *(Full step-by-step coming soon.)*",

  'mcp/setup/windsurf': "# Connect Windsurf\n\nAdd Tasker as an MCP server in Windsurf, using the endpoint below with your `tsk_…` key as a Bearer token:\n\n```\n" + MCP_URL + "\n```\n\n*(Full step-by-step coming soon.)*",

  'mcp/setup/roo': "# Connect Roo Code\n\nAdd Tasker as an MCP server in Roo Code, using the endpoint below with your `tsk_…` key as a Bearer token:\n\n```\n" + MCP_URL + "\n```\n\n*(Full step-by-step coming soon.)*",

  'mcp/tools': "# Tool reference\n\nThe MCP exposes tools grouped by area. Your agent calls these directly.\n\n## Projects & sections\n`list_projects`, `get_project`, `create_project`, `update_project`, `list_sections`, `create_section`, `update_project_context`.\n\n## Tasks\n`get_task` (starting work auto-sets *in progress*), `create_task`, `update_task`, `complete_task`, `uncomplete_task`, `delete_task`, `list_tasks` (excludes done by default), `rank_tasks`, `move_task_to_group`, milestones (`add_milestone`, `complete_milestone`, …).\n\n## Flows & contracts\n`build_new_flow` (start authoring a flow), `set_task_input`, `set_task_output`, `validate_output`, `submit_validation_result`, `get_flow_order`, `get_task_connections`. See the [Flows guide](/docs/mcp/flows).\n\n## Knowledge base & instructions\n`list_kb_entries`, `create_kb_entry`, `update_kb_entry`, `get_knowledge_base`, `get_ai_instructions`, `update_ai_instructions`, `get_project_is`, `create_is_entry`.\n\n## GitHub\n`github_connect`, `github_import_project`, `github_push_task`, `github_push_project`, `github_sync_issues`. See [GitHub integration](/docs/integrations/github).\n\n*(Per-tool parameter tables coming soon.)*",

  'mcp/flows': "# Flows & contracts\n\nA **flow** is a chain of contract-linked tasks. Tasker stores the structure and the contracts; **your agent does the work and the validation**. Tasker never makes its own AI calls.\n\n## Authoring a flow\nTell your agent what you want to build and have it call `build_new_flow`. That returns an interview playbook + your project context; the agent then interviews you (one question at a time), proposes the tasks and their contracts, and — after **one confirmation** — creates everything via `create_task` + `set_task_output` + `set_task_input`.\n\n## Contracts\nEach handoff carries two contracts:\n\n- **Output contract** (on the producer) — its *definition of done*.\n- **Input contract** (on the consumer) — its *acceptance criteria* for what it receives.\n\nEach is a list of **rules** with a `kind` (`check` = deterministic, `judgment` = semantic) and a `severity` (`blocker` reopens the task on failure; `warning` is noted but doesn't block).\n\n## The validation loop\nWhen a producing task is done, the agent calls `validate_output` (which returns the consumer's gate rules + the producer's self-check), evaluates each rule against the real output, then reports results with `submit_validation_result`. A blocker failure on the consumer's gate **reopens the producer**.\n\nFlows are DAGs — a task can take input from several upstream tasks (**fan-in**) and feed several (**fan-out**). `get_flow_order` returns the topological execution order.",

  'mcp/session': "# Session behavior\n\nWhen your agent connects, `__init_tasker_session` returns standing **directives** that shape how it works in Tasker — e.g. *set a task to in progress when you start it*, *bias to action on read-only requests*, *only pause for destructive/outward actions*, and *use `build_new_flow` when building a flow*.\n\nDependency-aware: starting or completing a task whose upstream isn't done returns a prompt asking how to proceed, rather than silently barreling ahead.",

  'integrations/github': "# GitHub\n\nConnect GitHub to bring repositories and Tasker together.\n\n- **Import a repo as a project** — Tasker reads the repo (and optionally its issues) to seed a project.\n- **Push tasks back** — push a task or a whole project out to GitHub.\n- **Sync issues** — keep issues and tasks aligned.\n\n**Safety:** changes are **manual-push only** — an agent never auto-pushes to your live repo. Pushing is always a deliberate, human action.",

  'integrations/google': "# Google Calendar & Tasks\n\nConnect Google Calendar to see your meetings alongside your work on the **Today** view. Google Tasks sync is planned. *(Full content coming soon.)*",

  'reference/plans': "# Plans & limits\n\nTasker's free tier covers a single repo/workspace; paid unlocks work across repos and teams. *(Exact limits coming soon.)*",

  'reference/shortcuts': "# Keyboard shortcuts\n\n- **⌘K / Ctrl+K** — global search\n- **Esc** — close panels / exit overlays\n\n*(More shortcuts coming soon.)*",

  'reference/gotchas': "# Edge cases & gotchas\n\n- **Reconnect after tool changes** — MCP clients cache the tool list when they connect; restart your client to pick up new or changed tools.\n- **Short-ID gaps** — deleting tasks can leave gaps in the `PREFIX-N` numbering; this is normal.\n- **Flows are read-only in the app** — author and edit them via the MCP for now.\n\n*(More coming soon.)*",

  'reference/changelog': "# Changelog\n\n- **Flows & contract layer** — author flows with `build_new_flow`; per-handoff contracts with agent-run validation; a read-only Flows page with a single-flow graph.\n- Earlier: GitHub import/push, Google Calendar on Today, dark mode, Focus mode.\n\n*(Dated entries coming soon.)*",
}
