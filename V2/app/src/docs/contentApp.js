// End-user docs track (flow step ② / TDE-195): Getting Started + Using the App.
// Bodies are markdown strings (double-quoted so inline `code` needs no escaping).

export const NAV_APP = [
  {
    section: 'Getting Started',
    items: [
      { slug: '', title: 'Welcome', purpose: 'What Tasker is and the two ways to use it.' },
      { slug: 'quickstart', title: 'Quickstart', purpose: 'From zero to your first task in ~2 minutes.' },
      { slug: 'concepts', title: 'Core concepts', purpose: 'Projects, sections, tasks, flows, contracts.' },
    ],
  },
  {
    section: 'Using the App',
    items: [
      { slug: 'app/projects', title: 'Projects', purpose: 'Create projects, prefixes, defaults, GitHub import.' },
      { slug: 'app/sections', title: 'Sections & Groups', purpose: 'Organize tasks; the default Backlog.' },
      { slug: 'app/tasks', title: 'Tasks', purpose: 'Status, priority, due dates, context, milestones.' },
      { slug: 'app/today', title: 'Today & Focus', purpose: 'The Today view, ranking, and Focus mode.' },
      { slug: 'app/flows', title: 'Flows', purpose: 'Read a flow: graph, steps, and contracts.' },
      { slug: 'app/search', title: 'Search & navigation', purpose: 'Global search and the nav rail.' },
      { slug: 'app/settings', title: 'Settings', purpose: 'Account, API key, integrations, theme.' },
    ],
  },
]

export const PAGES_APP = {
  '': "# Welcome to Tasker\n\nTasker is a task and project manager built for an AI-native workflow. You can use it two ways, and they work together:\n\n- **The web app** — plan and track work in a fast, focused interface: projects, sections, tasks, a daily *Today* view, and *Flows*.\n- **The MCP** — connect your own AI agent (Claude Code, Cursor, Windsurf, Roo) directly to your Tasker workspace, so it can read and update your tasks while it works.\n\nThe idea: **Tasker holds the structure; your AI does the work.** You stay in control of *what* good looks like, and the agent executes against it.\n\nNew here? Start with the [Quickstart](/docs/quickstart), then skim [Core concepts](/docs/concepts).",

  'quickstart': "# Quickstart\n\n## 1. Create an account\nSign in from the login page (email or GitHub).\n\n## 2. Make a project\nClick **New project** in the sidebar. Give it a name and an optional short **prefix** (e.g. `BLOG`) — your tasks become `BLOG-1`, `BLOG-2`, and so on.\n\n## 3. Add a task\nOpen the project board and type a task into any section. New tasks land in **Backlog** by default if you don't pick a section.\n\n## 4. (Optional) Connect your AI\nWant your agent to manage tasks for you? Head to **Settings → API key**, copy your key, and follow the [MCP setup guide](/docs/mcp/setup). Then you can just tell Claude Code *\"add a task to BLOG\"* and it happens.\n\nThat's it — you're running.",

  'concepts': "# Core concepts\n\nA quick tour of the vocabulary used throughout Tasker.\n\n- **Project** — a workspace for a body of work. Has a name and a short **prefix** used in task IDs (e.g. `TDE-52`).\n- **Section** — a column/bucket inside a project (e.g. *Backlog*, *Bugs*). Purely for organizing.\n- **Group** — an optional sub-grouping of tasks within a section.\n- **Task** — a unit of work. Has a **status** (pending → in progress → done), an optional **priority**, due date, free-form **context**, and **milestones**.\n- **Flow** — a chain of tasks linked by dependencies, where each handoff carries a **contract** (a quality bar the work must meet). A flow is a *process*, not just a list. See [Flows](/docs/app/flows).\n- **Contract** — the input/output quality bar on a task in a flow: what it must produce, and what the next step needs. Authored by you, checked by your agent.\n\nFlows and contracts are what make Tasker more than a to-do list — they're covered in depth in the [developer guide](/docs/mcp/flows).",

  'app/projects': "# Projects\n\nProjects are the top level of organization.\n\n## Creating a project\nClick **New project** in the sidebar. Set a name and an optional short **prefix** (2–4 letters). The prefix shows up in every task ID, so `TDE` gives you `TDE-1`, `TDE-2`, …\n\n## Default project\nYou can mark one project as your **default** so MCP tools fall back to it when you don't name a project explicitly.\n\n## Import from GitHub\nYou can create a project from a GitHub repository — Tasker reads the repo (and optionally its issues) to seed the project. See [GitHub integration](/docs/integrations/github).",

  'app/sections': "# Sections & Groups\n\n**Sections** are the buckets inside a project (like *Backlog*, *Bugs*, *Core App*). Every project has a **Backlog** section by default — any task you create without choosing a section lands there.\n\n**Groups** are an optional finer grouping of tasks within a section.\n\nReorder sections and tasks by dragging. Sections are just for organizing — they're independent of [Flows](/docs/app/flows), which are defined by task dependencies, not by which section a task sits in.",

  'app/tasks': "# Tasks\n\nThe core unit of work.\n\n## Status\nEvery task is **pending**, **in progress**, or **done**. Starting work flips a task to *in progress*; finishing marks it *done*.\n\n## Priority\nOptional: `rush`, `high`, `medium`, or `low`. Priority feeds the ranking on your [Today](/docs/app/today) view.\n\n## Due dates & pinning\nGive a task a due date, or **pin** it to keep it at the top.\n\n## Context\nEach task has a free-form **context** field — paste the spec, links, notes, or background. This is also what your AI agent reads when it picks up the task.\n\n## Milestones\nBreak a task into **milestones** — checkpoints you complete one by one. (Add each milestone as its own entry, not as a checklist inside a note.)",

  'app/today': "# Today & Focus\n\n## The Today view\n*Today* is your daily cockpit. It pulls tasks across all projects into buckets — **Overdue**, **Due today**, **In progress**, **Pinned**, **Queued** — and surfaces a single **Today's Focus** task at the top, chosen by Tasker's ranking (priority, due date, pins, age).\n\nFilter by project with the pills, and check off work inline.\n\n## Focus mode\nClick **Focus** to drop into a distraction-free view of one task at a time — just you and the work in front of you.",

  'app/flows': "# Flows\n\nA **flow** is a chain of tasks connected by dependencies, where each handoff carries a **contract**. Think of it as a repeatable *process* (e.g. \"write and publish an article\") rather than a loose list.\n\n## The Flows page\nOpen **Flows** from the nav rail to see every flow across your projects, filtered by project. Click one to view it.\n\n## Reading a flow\nThe flow detail shows two things:\n\n- **The graph** — your tasks as nodes, laid out left→right in the order they should be tackled, with arrows showing dependencies (including *fan-in*, where one step needs several others first).\n- **The step list** — the same steps in order. Click any step to expand its **contracts**: the *input* (what it needs from earlier steps) and *output* (its definition of done), each rule tagged blocker/warning.\n\nDrag the divider to resize the graph vs. the list, or hide the list to give the graph room.\n\n> Flows are read-only in the app today. They're authored and run through the [MCP](/docs/mcp/flows); editing them directly in the app is coming.",

  'app/search': "# Search & navigation\n\nPress **⌘K** (or Ctrl+K) anywhere to open global search and jump to any task or project.\n\nThe left **nav rail** holds your main destinations — Today, Projects, Flows, Settings. It stays collapsed to a thin strip and expands on hover.",

  'app/settings': "# Settings\n\nFrom **Settings** you can manage:\n\n- **Your account** — email, password, sign-out.\n- **MCP API key** — generate, copy, regenerate, or revoke the key your AI agent uses to connect. See [MCP setup](/docs/mcp/setup).\n- **Integrations** — connect GitHub and Google Calendar.\n- **Appearance** — light/dark theme.",
}
