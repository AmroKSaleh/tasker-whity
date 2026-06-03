# Task Manager App — Claude Code Build Brief
*A complete strategic and technical document for building an AI-powered task management app.*
*Last updated: May 2026*

---

## 1. What We're Building

A full-stack, AI-powered task management web app for personal use first, with a path toward multi-user/team support. The app is designed around a single core value proposition: **eliminating the "what should I work on?" decision**. The user opens the app and instantly knows what to do — no thinking required.

The app name is **TBD**. Do not name it anything without explicit instruction.

The company this is being built at is called **Waqtak**. That is not the app name.

---

## 2. Strategic Direction

The emotional core of the product is the **Focus tab** — an AI-prioritized view that tells the user exactly what to work on, with a primary "Do This Now" card and an "Up Next" queue. Every other feature exists to feed the Focus tab with enough signal to make its recommendation trustworthy.

Competitors include Todoist, Notion, Linear, TickTick, and Asana. The gap: none of them have a truly opinionated AI focus layer. They've bolted AI on as a feature, not built around it as the foundation.

---

## 3. UX Reference

The existing `project-dashboard.html` file (a personal single-file HTML dashboard) is the UX and data model reference. When making design decisions, refer to it. Do not replicate it exactly — improve upon it.

It contains:
- Tabbed project structure (e.g. Master, Website, Content, Get Listed, etc.)
- Priority tag system: **Rush**, **High**, **Medium**, **Low**
- A Focus view concept — most important task + up-next queue
- In Progress sidebar tracking pattern
- Task data structure: `id`, `text`, `detail`, `tags`, `done`, `sections`

---

## 4. Tech Stack

### Frontend
- **React** (via Vite) — component-based UI
- **Tailwind CSS** — utility-first styling
- **React Router** — tab/page navigation
- **Zustand** — lightweight client state management

### Design System
- **Material Design 3 (MD3)** — the full design system, not just inspiration
- Use the `tailwind-material-colors` plugin to generate the MD3 color system from a source color
- **Source color: to be decided** — the theme is black and white / neutral. Use a near-neutral or desaturated source color. Do NOT use `#6750A4` or any default MD3 purple
- Expose MD3 color roles as Tailwind classes: `bg-primary`, `bg-surface-container`, `text-on-surface`, etc.
- Define the MD3 type scale in Tailwind config: `display-large`, `headline-medium`, `title-large`, `body-large`, `label-medium`, etc.
- **Never use raw Tailwind color classes** (`bg-purple-500`, `text-gray-700`) anywhere in the app — only semantic MD3 role names
- Build a `components/ui/` library first: Button, Chip, Card, Input, FAB — before any feature code
- The app must look intentionally designed, not AI-generated. MD3 component behaviors (tonal elevation, navigation rail, chips, cards) must be implemented correctly

### Backend
- **Supabase** — PostgreSQL database, authentication, real-time subscriptions, row-level security (RLS)

### AI
- **Anthropic Claude API** (`claude-sonnet-4-20250514`) — for:
  - Natural language task parsing
  - Focus tab prioritization
  - Stale task detection
  - Daily briefing generation

### Hosting
- **Vercel** — frontend deployment
- **Supabase** — managed backend (no separate server needed)

---

## 5. Database Schema

Run the following SQL in the Supabase SQL Editor.

### Projects Table
```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#000000',
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Sections Table
```sql
CREATE TABLE sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER DEFAULT 0
);
```

### Tasks Table
```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users NOT NULL,
  project_id UUID REFERENCES projects ON DELETE CASCADE,
  section_id UUID REFERENCES sections ON DELETE SET NULL,
  text TEXT NOT NULL,
  detail TEXT,
  priority TEXT CHECK (priority IN ('rush','high','medium','low')),
  tags TEXT[] DEFAULT '{}',
  done BOOLEAN DEFAULT FALSE,
  in_progress BOOLEAN DEFAULT FALSE,
  due_date DATE,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

### Row-Level Security (RLS)
```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_projects" ON projects FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_tasks" ON tasks FOR ALL USING (auth.uid() = user_id);

-- Sections RLS via project ownership
CREATE POLICY "users_own_sections" ON sections FOR ALL
  USING (project_id IN (
    SELECT id FROM projects WHERE user_id = auth.uid()
  ));
```

> ⚠️ Note: `updated_at` has been added to the tasks table. Use a Supabase trigger or update it manually on every task mutation — it is required for stale task detection.

---

## 6. Project File Structure

```
app/
├── src/
│   ├── components/
│   │   ├── layout/       (Sidebar, Header, TabNav, NavigationRail)
│   │   ├── tasks/        (TaskItem, TaskList, AddTaskInput, TaskDetail)
│   │   ├── projects/     (ProjectPanel, ProjectSummary, ProgressBar)
│   │   ├── focus/        (FocusPanel, FocusPrimaryCard, FocusQueue)
│   │   ├── ai/           (AIInput, DailyBriefing)
│   │   └── ui/           (Tag, Chip, Checkbox, Button, Modal, Card, FAB)
│   ├── pages/            (LoginPage, DashboardPage, SettingsPage)
│   ├── store/            (useTaskStore, useProjectStore)
│   ├── lib/              (supabase.js, claude.js)
│   ├── hooks/            (useTasks, useProjects)
│   └── App.jsx / main.jsx
├── .env.local
├── vite.config.js
└── tailwind.config.js
```

---

## 7. Build Phases

**Follow these phases in order. Complete and verify each phase before moving to the next.**

---

### Phase 1 — Project Setup & Auth
**Goal: Working app with login/logout and empty dashboard.**

- Scaffold: `npm create vite@latest app -- --template react`
- Install: `react-router-dom`, `@supabase/supabase-js`, `zustand`, `tailwindcss`, `@anthropic-ai/sdk`, `tailwind-material-colors`
- Configure Tailwind with MD3 color tokens using a neutral/near-black source color
- Define MD3 type scale in Tailwind config
- Build `components/ui/` library: Button, Card, Chip, Input, FAB
- Set up Supabase project and run the schema SQL above (including RLS for sections)
- Build `LoginPage.jsx` with email/password and magic link auth
- Build authenticated route guard
- Set up `.env.local`:
  ```
  VITE_SUPABASE_URL=your_supabase_project_url
  VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
  VITE_ANTHROPIC_API_KEY=your_anthropic_api_key
  ```

✓ **Done when:** User can sign up, log in, log out, and reach an empty dashboard that looks and feels like a real MD3 app.

---

### Phase 2 — Core Task Management
**Goal: Full CRUD for projects, sections, and tasks.**

- Build `useProjects` and `useTasks` hooks with Supabase real-time subscriptions
- Build `ProjectPanel` — renders sections and tasks, matches the HTML file structure
- Build `TaskItem` with checkbox, priority chip, in-progress toggle, expandable detail
- Build `AddTaskInput` — simple text field that creates a task in the current section
- Build `ProgressBar` and `ProjectSummary` (Rush / High / Medium / Low / Done counts)
- Persist all state (in-progress, done) to Supabase — never localStorage for task data
- Write a one-time Node.js seed script (not a UI feature) to import tasks from the HTML file into Supabase

✓ **Done when:** All tasks are visible, checkable, and persist across page refreshes.

---

### Phase 3 — Focus Panel
**Goal: Replace the static ► Now concept with a live, score-driven Focus tab.**

Priority scoring function:
| Signal | Points |
|--------|--------|
| Rush priority | 100 |
| High priority | 75 |
| Medium priority | 50 |
| Low priority | 25 |
| Overdue | +80 |
| Due today | +50 |
| In progress | +30 |

- Build `FocusPanel` with "Do This Now" primary card and "Up Next" queue (top 6 tasks)
- Build `FocusPrimaryCard` — elevated card with task detail, checkbox, priority chip
- Add In Progress sub-tab showing all in-progress tasks across all projects
- Add sticky in-progress sidebar visible from every project tab
- The scoring must be deterministic and fast — no AI call in this phase

✓ **Done when:** The Focus tab always surfaces the highest-priority undone task dynamically, updating in real time as tasks are completed or modified.

---

### Phase 4 — AI Features
**Goal: Integrate Claude API for smart task entry, prioritization, and briefings.**

#### 4a. Natural Language Task Entry
Build `AIInput.jsx` — a text field that sends input to the Claude API and returns a structured task object.

System prompt:
```
You are a task parser for a project management app.
Parse the user's natural language input into a structured task.
Return ONLY valid JSON: { "text", "detail", "priority", "due_date", "tags" }
Priority must be one of: rush, high, medium, low.
Do not include any explanation or markdown. Only return the JSON object.
```

#### 4b. Daily Briefing
Build `DailyBriefing.jsx` — a collapsible card shown on login. Sends the user's current task list to Claude and returns a 3–5 sentence briefing: the most important thing to do today, any blockers, and one encouraging observation.

#### 4c. Stale Task Detection
On login, flag any task where `updated_at` is 14+ days ago with a "stale?" indicator. Send flagged tasks to Claude with a prompt asking whether to keep, reschedule, or delete each one. Surface suggestions as dismissible chips on the task.

#### 4d. AI-Enhanced Focus Scoring (optional upgrade to Phase 3)
After deterministic scoring is working, optionally pass the top 10 scored tasks to Claude for a final rerank with context. Claude's output *adjusts* the score — it does not replace it. The Focus tab must never feel non-deterministic.

> ⚠️ API Key security: For personal use, `dangerouslyAllowBrowser: true` is acceptable. When moving to multi-user, route all AI calls through a Supabase Edge Function to keep the key server-side.

✓ **Done when:** Natural language input creates a fully structured task automatically, and daily briefing appears on login.

---

### Phase 5 — UX Polish
**Goal: Elevate from functional to polished.**

- Drag-and-drop reordering within sections (`@dnd-kit/core`)
- Keyboard shortcuts: `N` = new task, `F` = focus tab, `/` = search
- Global search across all tasks (Supabase full-text search)
- Dark mode toggle — CSS variable swap using MD3 dark color roles, persisted to localStorage (UI preference only, not task data)
- Due date picker on task detail expand
- Collapsible sections with animated open/close
- Toast notifications for task completion and AI parsing results
- Mobile-responsive layout: Navigation Bar on mobile, Navigation Rail on desktop (MD3 pattern)

---

### Phase 6 — Data & Export
**Goal: Give the user full ownership of their data.**

- Export all tasks to CSV
- Export a project as a PDF summary
- Activity log: last 50 completed tasks with timestamps
- Archive: completed tasks older than 30 days move to an archive tab

---

### Phase 7 — Gamification (Light Touch)
**Goal: Motivation without infantilizing the experience.**

- Weekly wrap-up summary: "You cleared 12 tasks this week, 3 were Rush priority"
- Delivered as a dismissible card on Monday morning login
- No streaks, no points, no badges — those undermine the trusted-advisor tone of the Focus tab
- Optional: completion velocity chart (tasks completed per week over time) in a Stats or Insights tab

---

### Phase 8 — Multi-User (Optional, Later)
**Goal: Only build this if extending beyond personal use.**

- Invite team members to a workspace
- Assign tasks to specific users
- @mention in task detail triggers email notification (Supabase Edge Functions + Resend)
- Role-based permissions: Owner, Editor, Viewer
- Move AI calls to Supabase Edge Functions (required at this stage)

---

## 8. Key Implementation Rules

### State Management
- **Server state** (tasks, projects) — Supabase + Zustand with real-time sync
- **UI state** (active tab, filters, open sections) — Zustand only
- **Never use localStorage for task data** — everything persists to Supabase
- localStorage is only acceptable for UI preferences (dark mode, collapsed sections)

### Real-Time Sync Pattern
```javascript
const subscription = supabase
  .channel('tasks')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'tasks'
  }, handleChange)
  .subscribe();
```

### MD3 Design Rules
- Build MD3 components from scratch using MD3 role-based Tailwind classes — do not use `@material-tailwind` or other pre-built component libraries that approximate MD3
- Correct MD3 component behaviors to implement:
  - **Cards**: Use tonal elevation (surface-container-low, surface-container, surface-container-high) to show hierarchy — not drop shadows alone
  - **Chips**: Assist chips, Filter chips, Input chips — each has a distinct behavior
  - **Buttons**: Filled, Tonal, Outlined, Text — use the right variant for the context
  - **Navigation**: Navigation Rail on desktop (left side), Navigation Bar on mobile (bottom)
  - **FAB**: Primary FAB for the most important action (add task)
- The type scale must be used consistently: Display for hero text, Headline for section headers, Title for card headers, Body for task text, Label for chips and metadata

### Priority Tag Colors
Since the base theme is neutral (black/white), priority tags need color to be scannable. Use these consistently:
| Priority | Color direction |
|----------|----------------|
| Rush | Red |
| High | Orange |
| Medium | Blue |
| Low | Neutral/Grey |

These can be hardcoded as fixed colors (not MD3 role-based) since they carry semantic meaning independent of the theme.

### AI API Pattern
```javascript
// lib/claude.js
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    system: systemPrompt
  })
});
```

---

## 9. Definition of Done

The app is complete when all of the following are true:

- [ ] User can log in and see their dashboard
- [ ] All project tabs are present and functional
- [ ] Tasks can be added, completed, reordered, and deleted
- [ ] Focus tab always shows the right task to work on
- [ ] Typing a task in plain English creates a structured task via AI
- [ ] Daily briefing summarizes the day's priorities on login
- [ ] App works on mobile devices
- [ ] All data persists to Supabase and syncs across devices
- [ ] User can export their tasks to CSV
- [ ] App looks and feels like a real MD3 product, not an AI-generated prototype

---

## 10. How to Work With This Document

- Start with Phase 1. Ask for clarification before writing code if anything is ambiguous.
- After each phase is working, confirm before moving to the next.
- Do not skip ahead. Verify each phase before proceeding.
- If something breaks, fix it before continuing.
- Reference `project-dashboard.html` when matching specific UX behaviors.
- The Focus tab is the product. When in doubt about a design decision, ask: *does this make the Focus tab more trustworthy and faster to act on?*

---

*Confidential — Personal Use*
