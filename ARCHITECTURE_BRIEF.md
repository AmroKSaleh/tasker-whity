# Tasker — Architecture Brief for Opus

This document describes the current state of **Tasker**, a personal AI-powered project and task management app. It is intended to give Opus full context to propose an improved or extended architecture.

---

## 1. What Is Tasker?

Tasker is a Trello-style kanban board app where each project is a board of columns (sections), each column can have swimlane groups, and each task can have milestones, AI-generated focus steps, AI chat, priority, due dates, and tags. A Focus Mode presents one task at a time in a distraction-free full-screen view.

**Live app:** https://smarttasksxdd.netlify.app  
**Version:** v0.3.2  
**Platform:** Web (React SPA), deployed on Netlify

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + Vite |
| Styling | Tailwind CSS v3 (custom design tokens, warm-neutral palette) |
| Routing | React Router v7 |
| State | Zustand v5 (`useProjectStore`, `useTaskStore`) |
| Backend / Auth / DB | Supabase v2 (Postgres + Realtime + Auth) |
| Drag and Drop | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |
| Icons | `lucide-react` |
| AI | Gemini 2.5 Flash (built-in key) + user-supplied Claude / GPT-4o / Grok |
| Exports | SheetJS (XLSX), Markdown |
| Deployment | Netlify (site ID: `860d7db8-a9ad-4077-a19c-33f8daa44b48`) |

---

## 3. Design System

### Color Tokens (Tailwind custom theme)
```
ink:     #1A1916   — primary text
ink-2:   #3D3B36   — secondary text
mute:    #6B6867   — muted text
mute-2:  #9A9896   — very muted
line:    #D4D0C8   — borders
line-2:  #ECE9E1   — subtle borders
surf:    #F0EDE5   — hover backgrounds
surf-2:  #F5F3ED   — input backgrounds
paper:   #FBFAF6   — card / panel background
accent:  #D97757   — orange accent (CTAs, highlights, active states)
```

### Priority Colors
```
rush:   #C0432D   — blocking / ASAP
high:   #D97757   — important
medium: #8C8055   — normal
low:    #6B6867   — nice-to-have
done:   #5C7A5F   — completed
```

### Fonts
- **Inter** — body / UI
- **JetBrains Mono** — labels, metadata, tags, timestamps

### Animations
- `slide-in-right` — task detail panel entrance
- `fade-in` — overlay backdrop
- `sheet-up` / reverse — mobile bottom sheet entrance/exit
- Progress fill: `transition: width 0.4s ease` on absolutely-positioned div

---

## 4. Database Schema (Supabase / Postgres)

### `projects`
```
id            uuid PK
user_id       uuid FK auth.users
name          text
slug          text (URL-safe, unique per user)
sort_order    int
context       jsonb   (goal, why, scope, constraints, definition_of_done, risks)
created_at    timestamptz
```

### `sections` (columns on the board)
```
id            uuid PK
project_id    uuid FK projects
name          text
sort_order    int
```

### `groups` (swimlane dividers within a section)
```
id            uuid PK
project_id    uuid FK projects
section_id    uuid FK sections
name          text
sort_order    int
```

### `tasks`
```
id            uuid PK
project_id    uuid FK projects
section_id    uuid FK sections
group_id      uuid FK groups (nullable — null = ungrouped)
user_id       uuid FK auth.users
text          text        (title)
detail        text        (notes)
status        enum        pending | in_progress | done
priority      text        rush | high | medium | low | null
due_date      date
tags          text[]      (e.g. ['reference', 'here', 'abed'])
sort_order    int
pinned        boolean     DEFAULT false — manually set top priority for Focus Mode
completed_at  timestamptz
created_at    timestamptz
```

**Special tag semantics:**
- `reference` — task is read-only (cannot be toggled done, hidden from scoring)
- `here` — renders as `#you-are-here`
- `abed` — renders as `#needs-abed`

### `task_discussions`
```
id              uuid PK
task_id         uuid FK tasks
user_id         uuid FK auth.users
messages        jsonb   [{role: 'user'|'assistant', content: string}]
steps           jsonb   [{summary: string, detail: string}]
checked_steps   jsonb   [boolean]
reason          text    (AI-generated "why this is your focus" sentence)
created_at      timestamptz
updated_at      timestamptz
```
One record per task. Created on first open. Stores AI chat history, milestone steps, and focus reason together.

### `user_settings`
```
id          uuid PK
user_id     uuid FK auth.users (unique)
provider    text    gemini | claude | openai | grok
api_key     text
model       text
```

---

## 5. Application Architecture

### Routing (`App.jsx`)
```
/               → redirect to /dashboard
/login          → LoginPage (email+password, Google OAuth button)
/dashboard/*    → DashboardPage (AuthGuard)
/today          → TodayPage (AuthGuard)
/settings       → SettingsPage (AuthGuard)
```

### State Management

**`useProjectStore` (Zustand)**
- Holds: `projects[]`
- Actions: `setProjects`, `addProject`, `updateProject`, `removeProject`

**`useTaskStore` (Zustand)**
- Holds: `tasks[]`, `sections[]`, `groups[]`, `activeProjectId`
- Actions: `setTasks`, `setSections`, `setGroups`, `updateTask`, `addTask`, `addSection`, `addGroup`, `updateGroup`, `moveTask`, `reorderTasksInStore`, `pinTaskInStore`, `removeTask`, `removeGroup`, `removeSection`

Both stores are global singletons. No context providers.

### Data Fetching Pattern
- `useTasks(projectId)` — fetches tasks/sections/groups for the active project, sets up a Supabase Realtime subscription for live updates, exposes all CRUD operations
- `useProjects()` — fetches all projects for the current user
- `useAllTasks()` — fetches tasks across all projects (used by TodayPage)
- `useTaskDiscussion(taskId)` — loads/saves per-task AI discussion record (messages, steps, checked_steps, reason)
- `useProjectMilestones(taskIds[])` — batch-loads task_discussions for all tasks in a project to compute milestone progress percentages (used for progress fill on cards)

All mutations are **optimistic** (store updated immediately) + **persisted** (Supabase update async).

---

## 6. Page Structure

### DashboardPage
- Layout: `NavigationRail` (left) + `ProjectBoard` (flex-1)
- URL-based project selection via slug: `/dashboard/:slug`
- Redirects to first project if no slug

### TodayPage
- Cross-project view of all tasks that have a `due_date`
- Bucketed into: Overdue / Today / This week / Upcoming / Done today
- No board — flat list rows with done checkbox + in-progress toggle

### SettingsPage
- AI provider selection (Gemini / Claude / OpenAI / Grok)
- API key input + model selector per provider
- "Test connection" button
- Saved to `user_settings` table

---

## 7. Component Tree

```
App
├── LoginPage
├── DashboardPage
│   ├── NavigationRail
│   │   └── NewProjectModal (AI-powered project creation with discussion flow)
│   └── ProjectBoard
│       ├── ProjectHeader (name edit, progress bar, export, briefing)
│       ├── FilterBar (all/pending/done/rush/high/medium/low pills + counts)
│       │   [Sidebar header: "IN PROGRESS · N" + collapse toggle — same row as FilterBar]
│       ├── [Board area — DndContext]
│       │   ├── BoardColumn (×N, horizontally scrollable)
│       │   │   ├── ColumnHeader (name, progress, drag handle, collapse)
│       │   │   ├── Swimlane (group divider ×M)
│       │   │   ├── TaskItem (×tasks per section)
│       │   │   │   └── EditTaskModal (hover action)
│       │   │   └── AddTaskInline (dashed + button → inline input)
│       │   └── NewSectionColumn (trailing dashed column)
│       ├── [In-progress sidebar — desktop right rail, w-72]
│       │   └── InProgressSidebar
│       ├── TaskDetailPanel (desktop slide-in, triggered by clicking task title)
│       │   ├── StatusSegmented / PrioritySegmented
│       │   ├── Due date input
│       │   ├── Notes textarea
│       │   ├── Milestones section (progress bar, step list, AI generate, manual add)
│       │   └── AI Agent chat
│       ├── TaskDetailSheet (mobile bottom sheet, same content as panel)
│       ├── FocusOverlay (full-screen focus mode)
│       │   ├── Task title + "why this task" reason
│       │   ├── StepAccordion (milestones with detail expand)
│       │   └── Discussion sheet (AI chat, regenerate plan)
│       ├── InProgressFab (mobile only)
│       └── InProgressSheet (mobile in-progress list)
├── TodayPage
│   ├── NavigationRail
│   └── Task buckets (Overdue / Today / This week / Upcoming)
└── SettingsPage
```

---

## 8. Key Feature Details

### Board (Kanban)
- Sections = columns, draggable horizontally via `@dnd-kit`
- Tasks draggable vertically within a section; cross-column drag moves via `handleDragOver`
- Columns can be collapsed to a narrow vertical strip showing name + progress
- `FilterBar` filters all columns simultaneously by status/priority with live counts
- `HorizontalScrollRail` shows scroll progress and `⇧+scroll` hint

### Task Cards
- Checkbox (done toggle), in-progress toggle (▶), title, priority chip, due date, tags
- Animated orange progress fill (`rgba(217,119,87,0.26)`) from left, driven by milestone completion %
- On hover: ★ (pin top priority), ◎ (focus mode), ✎ (edit), × (delete)
- ★ stays visible and accent-colored when task is pinned; pin persists in DB
- Text truncates at 3 lines with ellipsis
- Clicking title opens Task Detail Panel / Sheet

### Focus Mode (`FocusOverlay`)
- Full-screen dark overlay (`#0a0a0a`)
- Ranks tasks via `scoreTask()` in `lib/scoring.js`:
  - Pinned → score 9999 (always first)
  - Priority: rush=100, high=60, medium=30, low=10
  - Overdue: +80, due today: +50, due in ≤3 days: +20
- Shows: task title, AI-generated "why this is your focus" (1-2 sentences), step accordion
- Actions: Mark as done, Deprioritize (sets priority=null), Discuss further (opens chat sheet)
- "★ MANUALLY SET AS TOP PRIORITY" label shown when task is pinned
- Entering Focus Mode from a task card skips ranking and jumps directly to that task

### Task Detail Panel/Sheet
- **Status:** pending / in_progress / done segmented control
- **Priority:** rush / high / medium / low / none segmented control
- **Due date:** date input
- **Notes:** textarea (blur-to-save)
- **Milestones:** progress bar, step list with checkboxes, "Generate with AI" when empty, manual add
- **AI Agent:** persistent chat per task, preserves history in `task_discussions`
- Panel position adjusts dynamically when In-Progress sidebar is collapsed/expanded
- Panel refreshes automatically after Focus Mode closes (via `panelRefreshKey`)

### AI Project Creation (NewProjectModal)
- Two modes: "Describe it" (direct text → AI generates structure) and "Discuss it" (multi-turn coaching chat before generation)
- Coach has two personas: Focused (Socratic, pushes back) and Conversational (collaborative)
- Generates: sections, groups, and tasks with priorities in one JSON response
- After generation: editable structured review before saving

### AI Functions (`lib/gemini.js`)
| Function | Purpose |
|---|---|
| `discussProject(messages, mode)` | Multi-turn project coaching chat |
| `generateProjectSummary(messages)` | Extracts structured JSON summary from coaching chat |
| `generateProjectFromDiscussion(messages, summary)` | Generates full project structure from discussion |
| `generateProjectStructure(description)` | One-shot project generation from text description |
| `generateStageWithTasks(description, context)` | Generates a single group+tasks from description |
| `parseTaskWithAI(input)` | NLP → structured task (text, priority, due_date, tags) |
| `chatAboutTask(messages, task, steps, checkedSteps, context, allTasks)` | Per-task AI execution coach |
| `generateFocusReason(task, allTasks, messages)` | "Why this is your focus" sentence |
| `generateFocusSteps(task, allTasks, messages)` | 4-6 action steps for a task |
| `generateDailyBriefing(tasks)` | 3-5 sentence daily briefing paragraph |
| `testAIConnection(config)` | Validates user's API key/provider/model |

All AI calls go through a single `post()` function that supports both OpenAI-compatible (`/chat/completions`) and Anthropic (`/messages`) wire formats. A fallback to the built-in Gemini key is attempted on auth failure.

---

## 9. Navigation Rail

- **Desktop:** fixed left sidebar (icons + labels), collapsible
- **Mobile:** bottom tab bar
- Items: Today, Projects list (scrollable), Settings
- Project items: long-press on mobile → reorder sheet
- "+ New Project" button opens `NewProjectModal`
- Active project highlighted in accent color

---

## 10. Known Limitations / Design Debt

1. **Horizontal scroll on board** — wheel event capture works in most browsers but was reported unreliable; `⇧+scroll` is the documented workaround
2. **No real-time collaboration** — Supabase Realtime subscription per project exists but is single-user; no conflict resolution
3. **Single AI discussion record per task** — chat, steps, and focus reason all in one `task_discussions` row; no history versioning
4. **No offline support** — all reads/writes go directly to Supabase; no local caching or service worker
5. **No search** — no global or per-project task search
6. **AI calls from browser** — API keys are stored in `user_settings` and sent from the client; no server-side proxy
7. **No notifications / reminders** — due dates are displayed but no push/email reminders
8. **Single user per account** — no team/sharing features
9. **Export only** — no import (e.g. CSV, Notion, Jira)

---

## 11. Backlog (User-Confirmed, Not Yet Built)

1. **Global search** — find tasks across all projects by keyword
2. **Voice notes** — attach voice recordings to tasks
3. **Task discussions (comments)** — threaded comments per task (distinct from AI chat; `task_discussions` table already exists but is used for AI context)
4. **Google OAuth** — code is already written (button exists on login page), needs Google Cloud Console app + Supabase OAuth provider config

---

## 12. File Map

```
V2/app/src/
├── App.jsx
├── pages/
│   ├── LoginPage.jsx
│   ├── DashboardPage.jsx
│   ├── TodayPage.jsx
│   └── SettingsPage.jsx
├── components/
│   ├── board/
│   │   ├── ProjectBoard.jsx       ← main board orchestrator
│   │   ├── BoardColumn.jsx        ← one section column
│   │   ├── ColumnHeader.jsx
│   │   ├── TaskDetailPanel.jsx    ← desktop slide-in panel (exports StatusSegmented, PrioritySegmented)
│   │   ├── TaskDetailSheet.jsx    ← mobile bottom sheet
│   │   ├── FilterBar.jsx
│   │   ├── ProjectHeader.jsx
│   │   ├── InProgressFab.jsx      ← mobile floating button
│   │   ├── InProgressSheet.jsx    ← mobile in-progress bottom sheet
│   │   ├── NewSectionColumn.jsx
│   │   ├── Swimlane.jsx
│   │   ├── AddTaskInline.jsx
│   │   ├── HorizontalScrollRail.jsx
│   │   └── hooks/
│   │       ├── useHorizontalWheelScroll.js
│   │       ├── useMediaQuery.js
│   │       ├── useTaskPanelState.js   ← URL-based panel state (?task=id)
│   │       └── useSheetDrag.js
│   ├── tasks/
│   │   ├── TaskItem.jsx           ← card with progress fill, pin, focus, edit
│   │   ├── EditTaskModal.jsx
│   │   ├── AddTaskInput.jsx
│   │   ├── AIInput.jsx            ← NLP task input (parse with AI)
│   │   └── InProgressSidebar.jsx  ← desktop right rail content
│   ├── focus/
│   │   ├── FocusOverlay.jsx       ← full-screen focus mode
│   │   ├── DailyBriefing.jsx
│   │   ├── FocusCard.jsx          ← (legacy/unused)
│   │   └── FocusPanel.jsx         ← (legacy/unused)
│   ├── projects/
│   │   ├── ProjectPanel.jsx       ← (legacy vertical view, kept but not shown)
│   │   ├── ProjectSummary.jsx
│   │   └── ProgressBar.jsx
│   ├── layout/
│   │   ├── NavigationRail.jsx
│   │   ├── NewProjectModal.jsx    ← AI project creation flow
│   │   └── AuthGuard.jsx
│   └── ui/
│       ├── Button.jsx
│       ├── Card.jsx
│       ├── Chip.jsx               ← priority badge
│       ├── Input.jsx
│       └── FAB.jsx
├── hooks/
│   ├── useTasks.js                ← task/section/group CRUD + realtime
│   ├── useProjects.js
│   ├── useAllTasks.js
│   ├── useTaskDiscussion.js       ← per-task AI discussion persistence
│   └── useProjectMilestones.js   ← batch milestone progress for card fills
├── store/
│   ├── useTaskStore.js
│   └── useProjectStore.js
└── lib/
    ├── gemini.js                  ← all AI functions (multi-provider)
    ├── aiSettings.js              ← provider config + key resolution
    ├── supabase.js                ← Supabase client
    ├── scoring.js                 ← task ranking for Focus Mode
    └── exportUtils.js             ← XLSX + Markdown export
```

---

## 13. Request for Opus

Please review this architecture and propose improvements or extensions. Areas of particular interest:

- **State architecture** — is Zustand without context the right call as the app grows? Should we move to React Query / TanStack Query for server state + Zustand only for UI state?
- **AI layer** — the current approach calls AI directly from the browser with user keys. What would a proper server-side AI proxy look like, and is it worth it for a single-user personal app?
- **Data model** — `task_discussions` conflates AI chat, milestones, and focus reason into one row. Should these be split?
- **Performance** — all tasks for a project are loaded into Zustand at once. What pagination/virtualization approach makes sense for very large projects?
- **Offline / resilience** — what's the minimum viable offline story for a kanban app?
- **Feature architecture** — how should global search, notifications, and team sharing be layered in without a full rewrite?
