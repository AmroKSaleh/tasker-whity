// End-user docs track for /docsV2 (flow TDE-218–223, step ②).

export const NAV_APP_V2 = [
  {
    section: 'Introduction',
    items: [
      { slug: '', title: 'Welcome to Tasker', purpose: 'What Tasker is and who it is for.' },
      { slug: 'quick-start', title: 'Quick Start', purpose: 'From zero to your first task in five minutes.' },
      { slug: 'concepts', title: 'Core Concepts', purpose: 'Projects, sections, groups, tasks, milestones.' },
    ],
  },
  {
    section: 'User Guide',
    items: [
      { slug: 'guide/projects', title: 'Projects', purpose: 'Creating, renaming, and organizing projects.' },
      { slug: 'guide/sections', title: 'Sections', purpose: 'Structuring work into labelled sections.' },
      { slug: 'guide/tasks', title: 'Groups & Tasks', purpose: 'Creating groups, adding tasks, setting status and priority.' },
      { slug: 'guide/milestones', title: 'Milestones', purpose: 'Tracking sub-goals by attaching milestones to tasks.' },
      { slug: 'guide/io', title: 'I/O Dependencies', purpose: 'Linking tasks with input/output contracts to model dependencies.' },
      { slug: 'guide/flows', title: 'Flows', purpose: 'Defining and running multi-step flows with quality gates.' },
      { slug: 'guide/focus', title: 'Section Focus & Blueprint', purpose: 'Focus mode per section; Blueprint graph of task dependencies.' },
      { slug: 'guide/knowledge-base', title: 'Knowledge Base', purpose: 'Storing project context and AI instructions per project.' },
    ],
  },
]

export const PAGES_APP_V2 = {
  '': `# Welcome to Tasker

Tasker is a task management app built for AI-native builders — people who direct AI assistants to do most of the actual work. Instead of tracking tasks in a spreadsheet or a notes doc, Tasker gives your work structure: projects, sections, groups, and tasks that your AI can read, update, and act on directly.

The core idea is simple: you describe what needs doing, organize it into a hierarchy, and Tasker keeps everything in sync — whether you're working alone in Claude Code or collaborating across multiple AI clients.

**Key things Tasker does:**
- Organizes your work into projects → sections → groups → tasks
- Shows you today's most important tasks, ranked by priority and due date
- Lets you connect tasks with input/output contracts so dependencies are explicit
- Runs multi-step flows with quality gates that an AI validates step-by-step
- Surfaces a Blueprint graph of task dependencies so you can see how work flows

**Who it's for:** solo builders, indie hackers, and developers who use Claude Code, Cursor, Windsurf, or Roo Cline as their primary AI assistant.

*Example: A builder working on a mobile app creates a "Blog Redesign" project (prefix: BLG), connects Claude Code to it, and tells Claude "add a task to write the About page copy". Claude creates BLG-5 and it appears instantly on the board — no context-switching required.*

New here? Start with the [Quick Start](/docsV2/quick-start), then skim [Core Concepts](/docsV2/concepts).`,

  'quick-start': `# Quick Start

Get from zero to your first task in five minutes.

## Step 1 — Sign in

Go to [https://smarttasksxdd.netlify.app](https://smarttasksxdd.netlify.app) and sign in. Tasker supports:
- **Google** — one-click sign in with your Google account
- **GitHub** — one-click sign in with your GitHub account
- **Email + password** — create an account with an email address
- **Magic link** — enter your email and receive a one-click sign-in link

## Step 2 — Create a project

Click **New Project** in the sidebar. Give it a name (e.g., "My App") and a short prefix (e.g., \`APP\`). The prefix is used for short task IDs like \`APP-1\`, \`APP-2\`.

## Step 3 — Add a section

Inside your project, click **Add Section**. Sections group related work — for example: "Frontend", "Backend", "Design".

## Step 4 — Add a group

Inside a section, click **Add Group**. Groups organize tasks within a section — for example: "In Progress", "This Week".

## Step 5 — Create your first task

Inside a group, click **+ Task**. Type the task description and hit Enter. Your task now has a short ID (e.g., \`APP-1\`) and is ready to go.

*Example: In a project called "Blog Redesign" (prefix: BLG), you create a section "Content", a group "Drafts", and a task "Write the About page copy."*

---

Next: [Core Concepts](/docsV2/concepts) or [connect your AI](/docsV2/dev).`,

  'concepts': `# Core Concepts

Understanding Tasker's hierarchy makes everything else click.

## The hierarchy

\`\`\`
Project
  └── Section
        └── Group
              └── Task
                    └── Milestone
\`\`\`

**Project** — the top-level container. Everything belongs to a project. Each project has a name, a short prefix for task IDs, and optional context that your AI assistant can read.

**Section** — a named category within a project. Think of sections as swim lanes: "Frontend", "Backend", "Marketing". A project can have as many sections as you need.

**Group** — a named cluster of tasks within a section. Groups give you a second level of organization: "This Sprint", "Backlog", "Blocked". Tasks live inside groups.

**Task** — the basic unit of work. A task has a title, a status (pending / in progress / done), a priority (low / medium / high / rush), and optionally a due date, context notes, and milestones.

**Milestone** — a named sub-step inside a task. Use milestones when a single task has multiple checkpoints. Each milestone can be independently marked done.

## Task statuses

| Status | Meaning |
|---|---|
| Pending | Not started |
| In Progress | Being worked on |
| Done | Complete |

## Task priorities

| Priority | When to use |
|---|---|
| Low | Nice to have |
| Medium | Default — normal work |
| High | Important, do soon |
| Rush | Drop everything — highest urgency |`,

  'guide/projects': `# Projects

Projects are the top-level containers in Tasker. Everything — sections, groups, tasks, flows — belongs to a project.

## Creating a project

Click **New Project** in the left sidebar. You'll be asked for:
- **Name** — the full project name (e.g., "Tasker Development")
- **Prefix** — a 2–6 letter shorthand used in task IDs (e.g., \`TDE\`). Once set, the prefix is used in every task ID in the project: \`TDE-1\`, \`TDE-2\`, etc.

*Example: A project called "Landing Page Redesign" with prefix \`LPR\` will create tasks like \`LPR-1\`, \`LPR-2\`.*

## Editing a project

Click the project name or the settings icon to edit its name or add context. **Context** is a free-text field your AI assistant reads before acting on any task — use it to describe the project's goals, stack, or constraints.

## Switching projects

Click any project in the left sidebar to switch to it. All sections, groups, and tasks for that project load automatically.

## Deleting a project

Open project settings and choose **Delete Project**. This is permanent — all sections, groups, and tasks are deleted.`,

  'guide/sections': `# Sections

Sections divide a project into named categories. They appear as column headers or rows in the project board.

## Adding a section

Inside a project, click **Add Section** (usually at the bottom of the board or via the \`+\` icon). Type the section name and confirm.

*Example: In a "Mobile App" project, you might have sections: "Design", "Frontend", "Backend", "QA".*

## Section Focus Mode

Click the arrow icon next to a section header to **enter focus mode**. Focus mode shows only that section's tasks — everything else fades away. This is useful when you want to work deeply on one area without distraction.

In focus mode:
- A back arrow at the top exits focus mode and returns to the full board
- A section context sidebar is available for notes and analysis

## Reordering sections

Drag sections by their header to reorder them on the board.`,

  'guide/tasks': `# Groups & Tasks

Groups organize tasks within a section. Tasks are the core units of work.

## Creating a group

Inside a section, click **Add Group**. Name it whatever helps you organize — "This Week", "In Review", "Backlog".

## Creating a task

Inside a group, click **+ Task** (or the add button). Type the task title and press Enter. The task is immediately saved with a short ID.

## Task fields

| Field | Description |
|---|---|
| Title | What needs to be done |
| Status | Pending / In Progress / Done |
| Priority | Low / Medium / High / Rush |
| Due Date | Optional deadline |
| Context | Free-text notes visible to you and your AI |
| Milestones | Sub-steps (see [Milestones](/docsV2/guide/milestones)) |

## Updating a task

Click a task to open it. Edit the title, change the status, set a priority, or add context notes directly in the task panel.

*Example: Task \`APP-4 — Write API docs\` is set to High priority, due Friday, with a context note: "Cover all endpoints in the v2 namespace."*

## Changing task status

Click the status badge on a task card to cycle it: Pending → In Progress → Done. Or open the task and change it from the dropdown.

## Moving a task

Drag a task card to a different group, or open the task and use the **Move to Group** option.`,

  'guide/milestones': `# Milestones

Milestones are named checkpoints inside a task. Use them when a task has multiple distinct sub-steps that you want to track individually.

## Adding a milestone

Open a task, scroll to the **Milestones** section, and click **Add Milestone**. Type the milestone name and save.

*Example: Task \`BLG-7 — Launch the blog\` has milestones: "Set up domain", "Configure DNS", "Deploy to Netlify", "Test all links".*

## Completing a milestone

Click the checkbox next to a milestone to mark it done. The milestone shows a strikethrough and a completion timestamp.

## Reopening a milestone

Click the completed milestone's checkbox again to reopen it.

## Deleting a milestone

Hover over a milestone and click the trash icon.

**Note:** Milestones are ordered in the sequence you add them. They don't have their own priorities or due dates — those belong on the parent task.`,

  'guide/io': `# I/O Dependencies

The I/O system lets you connect tasks so that one task's output becomes another task's input. This makes dependencies explicit and visible.

## Why it matters

Without I/O connections, tasks are isolated. With them, Tasker knows that "Task B depends on what Task A produces" — and your AI can verify that the right content was produced before moving on.

## How it works

Each task can have:
- An **output** — a description of what the task produces (e.g., "A markdown draft of the About page")
- One or more **inputs** — connections to other tasks, stating what this task needs from each source

When tasks are connected, the **Blueprint view** draws a wire between them.

## Setting up a connection

The easiest way is to tell your AI assistant:

> *"The output of task BLG-3 is the approved color palette. Connect BLG-5 so it receives that palette as input."*

Your AI handles the connection automatically.

## Viewing connections

Open a task and look at the **Input / Output** section. It lists what this task needs and what it produces. You can also use Blueprint view to see the full dependency graph for a project.

*Example: In a "Blog Redesign" project — Task \`BLG-3 — Define color palette\` produces a hex palette. Task \`BLG-5 — Build the header component\` receives the palette as input. The Blueprint shows a wire from BLG-3 → BLG-5.*`,

  'guide/flows': `# Flows

A **flow** is a named sequence of tasks with quality gates between them. Each step must pass a validation check before the next step can start.

## What flows are for

Flows are for multi-step work where the output of one step is the input of the next, and where quality matters. Examples:
- "Draft → Review → Publish" for content
- "Research → Design → Build → QA" for features

Each step has an **output contract** — rules describing what the step must produce. Before the next step runs, an independent AI validator checks whether the contract was met.

## The flow lifecycle

1. **Build** — create the tasks, connect them with I/O, and name the flow
2. **Run** — tell your AI assistant to run the flow
3. **Execute step-by-step** — for each step, your AI produces output and triggers validation
4. **Validation** — an independent validator checks the output contract rules; if it passes, the next step unlocks
5. **Completion** — all steps done, all contracts met

## Viewing flows

The **Flows** page (accessible from the left nav) shows all named flows in your projects. Each flow displays its steps, their statuses, and overall progress.

## Flow statuses

| Status | Meaning |
|---|---|
| Pending | No steps started |
| In Progress | Some steps started or done |
| Done | All steps complete |

*Example: The flow "Define docs structure & information architecture" has 6 steps. Steps 1–2 are done. Steps 3–6 are pending. The flow is in_progress.*

## Contract rules

Each step's contract has rules of two kinds:
- **Judgment** — a validator reads the output and decides pass/fail
- **Check** — a verifiable fact (word count, link test, file exists)

Blockers must pass; warnings are informational.`,

  'guide/focus': `# Section Focus & Blueprint

## Blueprint View

The **Blueprint** button appears in the project toolbar (top of the project board). Click it to switch the entire project view into a dependency graph.

The Blueprint shows:
- Each task as a card node, across all sections
- Wires connecting tasks that have I/O relationships
- Task status shown by the node's border color (gray = pending, orange = in progress, green = done)
- Layout is automatic (left-to-right, dependencies flow left to right)

Use Blueprint to:
- Spot tasks that are blocking others
- Verify that your I/O connections are correct
- Get a visual overview of how all work in the project flows

*Example: In a "Blog Redesign" project — tasks "Define color palette", "Build header component", and "Launch blog" are chained with I/O. Blueprint shows the full dependency chain from left to right.*

Click **Blueprint** again to return to the normal board view.

## Section Focus Mode

Click the **arrow icon** next to any section header to enter focus mode. The board narrows to show only that section's tasks — useful when you want to work deeply on one area.

In focus mode:
- The section header shows a **back arrow** (exits focus mode)
- A context sidebar can be opened for section-level notes and analysis
- You can still add, edit, and complete tasks normally

Click the **back arrow** to exit focus mode and return to the full board.`,

  'guide/knowledge-base': `# Knowledge Base

The Knowledge Base is a per-project store for context, references, and important information that your AI assistant should be aware of.

## What to put in the KB

- Architecture decisions ("We use Supabase for the backend, Netlify for frontend")
- Important links ("Design system: figma.com/...")
- Conventions ("All new components go in src/components/")
- Glossary entries ("MCP = Model Context Protocol")
- Recurring constraints ("Never deploy on Fridays")

## Adding a KB entry

Open your project and navigate to the **Knowledge Base** tab. Click **Add Entry**, give it a title, and write the content.

*Example: Entry titled "Tech Stack" with content: "Frontend: React + Vite + Tailwind. Backend: Supabase (Postgres + Edge Functions). Deploy: Netlify (frontend), Supabase (MCP)."*

## How AI uses the KB

When your AI assistant starts a Tasker session, it reads the Knowledge Base and incorporates that context into its work. This means you don't have to repeat project background in every prompt.

## Editing and deleting entries

Click any KB entry to edit it. Use the trash icon to delete it. Changes take effect immediately for future AI sessions.`,
}
