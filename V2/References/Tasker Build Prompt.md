# Tasker — Build Prompt

> **For:** Claude Code (or any agentic coding tool)
> **Goal:** Implement Tasker, a single-user AI-powered task management web app, from this spec.

---

## 1 · Mission & Philosophy

Tasker is a single-user, AI-powered productivity tool focused on **deep work and intentional task execution** — not just task listing.

**Core philosophy:** Your focus should be *decided for you*, not chosen from a list. AI is used at every stage — from planning a project, to breaking down tasks, to coaching the user through execution in a distraction-free Focus Mode.

The product is **single-user** (no teams, no sharing) and **web-based**.

---

## 2 · Tech Stack

Implement with the following stack unless the user instructs otherwise.

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | SSR, server actions, route-based layouts, sensible defaults |
| Language | **TypeScript (strict)** | Required |
| Styling | **Tailwind CSS v4** | Utility-first, fast iteration |
| Auth + DB | **Supabase** | Built-in email auth, magic links, row-level security, Postgres |
| AI | **Anthropic SDK** (`@anthropic-ai/sdk`) with `claude-sonnet-4-5` | Streaming for chat & plan generation |
| State (client) | **React Server Components + minimal Zustand** | Server-first; Zustand only for ephemeral UI like the Focus overlay |
| Mutations | **Next.js Server Actions** | Type-safe, no API layer to maintain |
| Component primitives | **shadcn/ui + Radix** | Modal, popover, sheet, tabs — accessible by default |
| Icons | **Lucide React** | |
| Animations | **Framer Motion** | For the Focus overlay entry, sheet slide-ups |
| Deployment | **Vercel** | Native Next.js host, edge runtime for AI streaming |

Environment variables required:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
```

---

## 3 · Data Model

All tables are owned by a single `user_id` (Supabase auth user). Enable RLS on every table — users can only see their own rows.

### `projects`
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk auth.users | |
| name | text | unique per user |
| slug | text | url-safe, unique per user |
| description | text nullable | original AI-input or manual |
| ai_summary | jsonb nullable | the structured summary from Path A |
| ai_chat_log | jsonb nullable | array of `{role, content}` for context-aware regeneration |
| daily_briefing | text nullable | cached AI briefing, regenerable |
| daily_briefing_at | timestamptz nullable | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `sections`
The top-level groupers inside a project. (User-facing label: "task list" or "section".)
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | |
| name | text | |
| sort_order | int | |
| collapsed | bool default false | |

### `groups`
Mid-level groupers ("stages") inside a section.
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | |
| section_id | uuid fk nullable | nullable = ungrouped tasks belong directly to section |
| name | text | |
| sort_order | int | |
| collapsed | bool default false | |

### `tasks`
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | |
| section_id | uuid fk nullable | |
| group_id | uuid fk nullable | |
| text | text | the task title |
| detail | text nullable | expandable notes |
| priority | enum('rush','high','medium','low') | |
| status | enum('pending','in_progress','done') default 'pending' | |
| due_date | date nullable | |
| tags | text[] | includes `reference` as a special tag |
| sort_order | int | |
| completed_at | timestamptz nullable | |
| created_at | timestamptz | |

**Computed/derived (do not store):**
- `is_reference` = `'reference' = ANY(tags)`
- `is_overdue` = `due_date < today AND status = 'pending'`
- `focus_score` (see §6 ranking algorithm)

### `user_prefs` (single row per user)
| col | type | notes |
|---|---|---|
| user_id | uuid pk | |
| example_tab_hidden | bool default false | replaces the `tasker_example_hidden` localStorage flag — server-persisted |

---

## 4 · Routes

| Path | Purpose |
|---|---|
| `/` | Root. Redirects to `/login` or `/dashboard` based on session. |
| `/login` | Three tabs: Sign in · Sign up · Magic link. |
| `/dashboard` | Router. If 0 projects → empty state. If ≥1 → `redirect()` to most-recently-updated project. |
| `/dashboard/[slug]` | The Project View. Main hub. |

**No URL** for the New Project modal, Focus overlay, Edit Task modal, or Discussion sheet — these are overlays on top of the current route. State lives in client component + (for focus mode) a URL search param `?focus=1` so the back button closes it.

---

## 5 · AI Integration Points

All AI calls happen via server actions (`'use server'`). Stream where the UI shows partial output.

| Surface | Model | Input | Output | Stream? |
|---|---|---|---|---|
| Project discuss chat | sonnet-4-5 | full chat history + system prompt about Tasker | next assistant message; one question at a time | yes |
| Summarize chat | sonnet-4-5 | chat history | JSON `{name, description, goals[], constraints[]}` | no |
| Generate tasks | sonnet-4-5 | summary JSON | JSON: tree of sections → groups → tasks (with priority, due_date, tags) | no |
| Generate direct (Path B) | sonnet-4-5 | raw description | same task tree JSON | no |
| Daily briefing | sonnet-4-5 | project + open tasks summary | 2–3 sentence narrative | yes |
| Add stage (AI) | sonnet-4-5 | description + project context | one group + its tasks JSON | no |
| Batch-generate group tasks | sonnet-4-5 | description + section context | array of tasks JSON | no |
| AI add task (natural language) | sonnet-4-5 | one sentence + project tag list | single task JSON | no |
| Focus "why this matters" | sonnet-4-5 | focused task + project context | 1–2 sentence reason | yes |
| Focus action steps | sonnet-4-5 | focused task + project + chat context | 4–6 imperative steps | yes |
| Focus discussion | sonnet-4-5 | multi-turn over task + plan | assistant message | yes |

**System prompt for project-creation flows** must instruct the model to: ask ONE question at a time, stop asking when it has enough info, and on Generate produce a hierarchy where every leaf is a concrete actionable task (verb-led, <12 words).

**Shortcut detection** runs *before* any AI call: if the user's description (case-insensitive) contains `example`, `demo`, `sample`, `test`, or `placeholder`, skip AI entirely and load a hardcoded example project.

---

## 6 · Focus Ranking Algorithm

When the user hits the Focus button, the app selects the single highest-ranked rankable task from the current project.

**Eligible tasks:** `status = 'pending'` AND `'reference' != ANY(tags)` AND `status != 'in_progress'`.

**Score:**
```
score = 0
score += {rush: 100, high: 60, medium: 30, low: 10}[priority]
if overdue:    score += 80
if due_today:  score += 50
if due_within_3_days: score += 20
```

Highest score wins; ties broken by oldest `created_at`. If no eligible tasks, show **All Clear** state.

---

## 7 · Screen-by-Screen Spec

The full visual flow lives in `Tasker User Flow.html` (open it side-by-side while building). What follows is the implementation contract.

### Zone 1 — Authentication

**`/login` — Login page**
- One card, three tabs: Sign In · Sign Up · Magic Link.
- Sign In: email + password → Supabase `signInWithPassword` → `/dashboard`.
- Sign Up: email + password → `signUp` → show "check your email" inline message → on verification click → `/dashboard`.
- Magic Link: email only → `signInWithOtp` → show "check your inbox" inline message → on click → `/dashboard`.
- Form validation: standard email regex, password min 8.
- Errors render inline below the relevant field.
- A signed-in user hitting `/login` is redirected to `/dashboard`.

**Global behavior**
- Sign out (in any header menu) → `/login`.
- Expired session (server action returns 401) → soft redirect to `/login` with toast "Session expired".

### Zone 2 — Dashboard entry

**`/dashboard`**
- Server component. Reads `projects` count for the current user.
- If 0 → renders the Empty State client component (just a centered "No projects yet" with a `+ New project` button that opens the New Project Modal).
- If ≥1 → `redirect()` to `/dashboard/[slug]` of the most-recently-updated project. The route `/dashboard` never actually renders a project list — this is intentional.

### Zone 3 — New Project Modal

A single modal with three tabs: **Manual**, **Example**, **AI** (default).
The Example tab is hidden if `user_prefs.example_tab_hidden = true`.

#### Manual mode
- One field (name) → "Create" → server action `createProject({name, mode: 'manual'})` → returns `slug` → `router.push('/dashboard/' + slug)`.

#### Example mode
- Preview thumbnails of the sample project.
- Two buttons: "Create Example" and "Don't show this again".
- "Don't show" → server action sets `example_tab_hidden = true` → tab disappears in subsequent renders.
- "Create" → seeds the sample project (hardcoded JSON fixture) → navigate.

#### AI mode

Two paths via two buttons on the same screen: **Discuss** (preferred, slow) and **Generate** (fast, direct).

**SHORTCUT (runs before either path)**: if the textarea contains any of `example`, `demo`, `sample`, `test`, `placeholder` → both buttons short-circuit into the Example flow with a "Loaded example project — your description was a sample keyword" notice. Don't waste an AI call.

**Path A — Discuss:**
1. User types initial description → clicks "Discuss".
2. Modal transitions to a chat UI. AI asks one question at a time. User answers. Repeat.
3. AI eventually offers (or user clicks) "Generate". Modal shows "Summarizing…" spinner.
4. Modal transitions to **Summary Review**: editable fields populated from the AI's structured summary. User can edit any field.
5. User clicks "Generate Tasks" → loading spinner → modal transitions to **Preview**.
6. **Preview**: full editable tree of the generated project. User can rename the project, regenerate (re-runs AI with the chat context preserved — important!), or click "Create Project".
7. "Create Project" → server action persists everything → navigate to project.

**Path B — Generate Direct:**
1. User types description → clicks "Generate".
2. **Confirmation Popup** appears: "Generate from this description without discussing first?" with Go back / Confirm.
3. Confirm → loading → **Preview** (same component as Path A's preview).
4. Create Project → navigate.

The chat log, the summary, and the preview tree are all kept in modal state so the user can navigate backwards through the steps without losing work.

### Zone 4 — Project View `/dashboard/[slug]`

The main hub. Layout (desktop):
```
+----------------------------------+----------------+
| Header (sticky)                  |                |
+----------------------------------+                |
| Filter bar                       |  In-Progress   |
+----------------------------------+   Sidebar      |
| Content                          |                |
|   Section                        |                |
|     Group / Stage                |                |
|       Task                       |                |
|       Task                       |                |
|     + Add stage                  |                |
|   + New task list                |                |
+----------------------------------+----------------+
```

**Header contains:**
- Project name (h1, inline-editable on click).
- Live progress bar (done / total non-reference tasks).
- Priority summary cards: counts of rush / high / medium / low pending tasks.
- "Daily Briefing" expandable panel. Collapsed by default. Expand → if no cached briefing or cache > 24h, regenerate via streamed AI. Has a "Regenerate" button.
- "Delete project" button (icon, in an overflow menu). Opens confirmation. On confirm → if there are other projects, navigate to the next most-recent one; if not, `/dashboard` (which renders the empty state).
- **Focus button** (prominent, accent-colored): opens the Focus Mode overlay.

**Filter bar contains:**
- Status pills: All · Pending · Done.
- Priority pills: Rush · High · Medium · Low.
- "Collapse All" / "Expand All" buttons toggle every section and group at once.
- Selecting a filter pill filters the entire visible tree.

**Content — Section:**
- Rename inline (click title).
- Collapse/expand caret.
- Delete (overflow menu) → confirmation → removes section and all its groups + tasks.

**Content — Group (stage):**
- Rename inline.
- Collapse/expand.
- Delete with confirmation.
- "✦ AI batch-generate tasks" button: opens a small prompt → "Describe what tasks should be in this stage" → streams generated tasks into the group.

**Add stage:**
- Click "+ Add stage" → small inline form with two tabs: Manual (name only) and AI (description → generates the stage + its tasks).

**Add task list (section):**
- "+ New task list" at the bottom → inline name input → creates a section.

### Zone 5 — Task Item

The atomic unit. Each row has these interactive zones (left to right):

| Zone | Action |
|---|---|
| Checkbox | Toggle `status` between `pending` and `done`. Reference tasks have no checkbox (cannot be completed). |
| ▶ button | Toggle `in_progress`. If task is not in progress → set status to `in_progress`, task disappears from main list, appears in sidebar. If already in progress → revert to `pending`, task returns to list. |
| Task text | If `detail` exists: click toggles expanded notes panel beneath the row. If no detail: no-op (or opens edit modal — your call, lean toward no-op). |
| Priority chip | Visual only on row; editable in Edit Task Modal. |
| Tags | Visual only on row; editable in Edit Task Modal. |
| ✎ (hover-revealed) | Opens Edit Task Modal. |
| × (hover-revealed) | Delete with confirmation. |

**Add task row** (at the bottom of every group): single-line natural-language input. On submit → calls AI to parse → shows a small preview popover with parsed fields → user confirms → task is created.

Example parse:
> "call mom tomorrow #personal"
→ `{text: "Call mom", due_date: tomorrow, tags: ["personal"], priority: "medium"}`

**Edit Task Modal:** standard form with text, detail (textarea), priority radio, due date picker, tags input. Save / Cancel.

### Zone 6 — In-Progress Sidebar (desktop only, ≥1024px)

- Fixed sidebar on the right side of the Project View.
- Hidden on mobile/tablet; in-progress tasks instead appear pinned at the top of the main list. (You can build the mobile alternative as a placeholder TODO.)
- **Featured "Doing Now" card** at top: the highest-priority in-progress task, large, with "Mark done" and "×" (un-in-progress).
- Below: secondary in-progress tasks as smaller cards, each with "×".
- Tasks here are **excluded from Focus ranking** and **hidden from the main list**.

### Zone 7 — Focus Mode Overlay

Triggered by the Focus button in the project header. Full-screen overlay over the Project View.

**On entry:**
1. Compute the highest-ranked rankable task (see §6).
2. If none → render **All Clear** state ("All clear ✓ — no rankable tasks") with a Close button.
3. Otherwise:
   - Display task text large at the top.
   - Stream two AI sections in parallel:
     - **"✦ Why this matters"** — 1–2 sentences.
     - **"✦ Plan"** — 4–6 imperative action steps.
   - Steps render as a checklist; each step can be expanded for detail, or checked off.

**Action buttons:**
- **Mark as done** — completes the task. Next-highest-ranked task is loaded into the same overlay (or All Clear).
- **Deprioritize** — sets `priority = 'low'`. Next task loaded.
- **Regenerate plan** — re-runs the AI with any discussion-sheet context preserved.

**✦ Discuss button** opens the **Discussion Sheet** — a bottom sheet sliding up over the overlay:
- Multi-turn chat with the AI, scoped to this task.
- Quick action: "Discuss this step" on any plan step → pre-fills "Tell me more about: <step text>" into the input.
- "Update plan" button (visible only after at least one AI response) → regenerates Plan + Why with the discussion as added context.
- ESC or close button → sheet hidden, overlay stays.

**ESC** when sheet is closed → closes overlay → returns to Project View.

---

## 8 · Key Conditions (cheat sheet)

| Condition | Outcome |
|---|---|
| Not authenticated | Redirect to `/login` (except `/login` itself) |
| 0 projects on `/dashboard` | Render empty state, don't redirect |
| ≥1 project on `/dashboard` | Redirect to most-recent project |
| AI description contains `example`/`demo`/`sample`/`test`/`placeholder` | Skip AI entirely, load fixture |
| `user_prefs.example_tab_hidden = true` | Hide Example tab |
| Task `status = 'in_progress'` | Hidden from main list, shown in sidebar, excluded from Focus |
| Task tagged `reference` | No checkbox, excluded from progress %, excluded from Focus |
| Task overdue | +80 to Focus score |
| Task due today | +50 to Focus score |
| "Collapse All" pressed | Every section and group collapses |
| No rankable tasks in Focus | Show All Clear state |
| Daily briefing cache > 24h | Auto-regenerate on expand |

---

## 9 · Visual / Interaction Direction

Open `Tasker User Flow.html` in a browser side-by-side. It shows:
- Every screen as a wireframe at correct relative density.
- The exact transitions between screens.
- Which surfaces are AI-touched (orange accents — implement these with a consistent AI accent color in your Tailwind config).
- Six "Future" placeholder cards — **do not build these in v1**, but leave the data model and routing extensible for them: OAuth providers, templates gallery, calendar view, recurring tasks, mobile in-progress drawer, focus timer.

**Aesthetic guidance:**
- Warm-neutral palette. Off-white background (`#FBFAF6`), deep charcoal foreground (`#1A1916`).
- One accent color (warm orange, `oklch(0.62 0.16 50)` or `#D97757`) reserved for AI surfaces and the Focus button. Use it sparingly — its job is to draw the eye to AI affordances.
- Type: a clean sans (Geist, Inter, or system) + a mono for technical labels and timestamps.
- Subtle borders + small radii (4–8px). No heavy shadows. The product should feel like a tool, not an entertainment app.
- Density: comfortable, not cramped. Tasks are 36–44px tall.

---

## 10 · Suggested Build Order

1. **Foundation:** Next.js project, Supabase setup, auth flow (Zone 1). Verify magic link works end-to-end.
2. **Data layer:** Tables, RLS policies, server actions for CRUD on projects/sections/groups/tasks. No AI yet.
3. **Project View (Zone 4) — manual flows:** Header, filter bar, sections/groups/tasks tree with all interactions (rename, delete, reorder, collapse). Manual project creation only.
4. **Task Item (Zone 5):** Edit modal, all hover interactions, in-progress toggle. Build the In-Progress Sidebar (Zone 6) in the same step — the toggle is meaningless without it.
5. **AI add task** (Zone 5): first AI surface. Validates your AI pipeline.
6. **New Project Modal — Manual + Example tabs** (Zone 3 partial). Confirms the modal scaffold.
7. **AI project creation — Path B (Generate Direct)** then **Path A (Discuss)**. Path B is simpler and lets you test the task-generation prompt before adding the chat layer.
8. **Daily Briefing + AI batch-generate group** (Zone 4 AI surfaces).
9. **Focus Mode (Zone 7):** ranking algorithm first (pure function, unit-test it), then the overlay UI, then Why + Plan streaming, then Discussion sheet.
10. **Polish:** animations, empty states, error states, mobile layout for sidebar.

Ship Zones 1–6 manual-only as a usable product before adding any AI. The AI layers cleanly on top once the data shapes are solid.

---

## 11 · What's deliberately not in v1

These are marked as "Future" in the flow diagram. Leave them as TODOs:
- OAuth providers (Google / GitHub / Apple) — Zone 1.
- Templates gallery — Zone 3 (would be a fourth tab alongside Manual/Example/AI).
- Calendar / timeline view — Zone 4 (a second view of the same task data, toggleable).
- Recurring tasks — Zone 5 (repeat rule on the task model).
- Mobile in-progress drawer — Zone 6 (the sidebar is desktop only).
- Focus timer / pomodoro — Zone 7 (time-bounded sessions layered on the overlay).

---

## 12 · How to use this document

Hand this file to Claude Code as your spec. Suggested kickoff prompt:

> Read `Tasker Build Prompt.md`. Set up the Next.js project per §2, run the Supabase schema in §3, and build Zone 1 (Authentication) end-to-end. Stop after I can sign in via all three methods and land on a stub `/dashboard` page. Don't start Zone 2 until I review.

Then iterate zone by zone, reviewing each milestone before letting Claude continue. The build order in §10 is structured so each milestone is independently testable.
