# Handoff: Tasker — Mobile-First Task Management App

## Overview

Tasker is a productivity tool for individuals managing multiple projects. The design covers the core surfaces of the app: a mobile **Focus** tab (AI-ranked "Do This Now" card + queue), a mobile **Project view** (sections + stages + tasks), a **Desktop** three-pane layout (sidebar nav + project panel + in-progress rail), and the supporting **component vocabulary** (task item, priority chip, section card, stage group, bottom nav).

The design language is **strictly greyscale** — pure black, pure white, and shades of grey only. No colors whatsoever. Think editorial black-and-white design: clean, minimal, typographic. Notion meets Linear in monochrome.

## About the Design Files

The HTML files in this bundle are **design references**, not production code. They are wireframe prototypes built in React + inline JSX rendered on a pan/zoom design canvas. They communicate **layout, hierarchy, structure, flow, and the visual system** — not final pixel values.

Your task is to **recreate these designs in the target codebase's existing environment** (React Native, SwiftUI, Flutter, web React, etc.) using its established patterns, component library, typography, and spacing tokens. If no codebase exists yet, choose the most appropriate framework for the project (e.g. React Native + Expo for cross-platform, or Next.js for a web-first launch) and implement there.

Do **not** lift the wireframe styles directly. The wireframes deliberately use a low-fidelity, sketchy aesthetic (dashed borders, handwritten Caveat annotations, placeholder stripes) — that aesthetic is for *exploring* the design and is not the production look. The production look is clean, minimal, typographic black-and-white.

## Fidelity

**Low-fidelity (lofi) wireframes.**

These wireframes establish:
- Information hierarchy (what shows where)
- Layout structure (grid, flex, regions, sidebars, stacking order)
- Component anatomy (what fields a task row carries, what lives in a section header, etc.)
- Interaction model (Focus → Project → Task drill-down, in-progress rail, briefing)
- The greyscale-only constraint

They do **not** establish final:
- Exact pixel spacing or type scale
- Final font choice (Inter is a placeholder; pick whatever the target app's brand uses, or a clean neutral sans like Inter, Söhne, or system fonts)
- Final iconography (the wireframes use unicode glyphs and dashed boxes — replace with a real icon set like Lucide, Phosphor, or SF Symbols)
- Animation timing / micro-interactions (described qualitatively below)

Use the codebase's existing design system for the production look. If there is none, build a minimal greyscale token set up front.

## Screens / Views

### 1. Mobile · Focus tab (home screen)

**Three layout approaches were explored. Pick one — recommended starting point: Variant A.**

#### Variant A — Hero card + queue (recommended default)
- **Purpose:** Single-screen "what should I do right now" answer.
- **Layout (top → bottom):**
  1. Status bar (system, 28px tall)
  2. Header — date label ("thursday · may 8") + page title ("Focus") + circular profile/menu button on the right. ~60px tall, 18px horizontal padding.
  3. **Hero "Do This Now" card** — full-bleed-ish (16px side padding), ~14px radius, **inverted** (black background, white text). Contains:
     - Top row: "do this now →" label (left) + priority chip on the right (e.g. white chip with black "RUSH" text)
     - Task title (~17px, semibold, line-height ~1.25)
     - Breadcrumb: "Website Redesign › Marketing › Launch" (~11px, muted)
     - Meta row: "◷ DUE 4:00 PM" + "~25 MIN" (mono, ~9.5px, dim)
     - Two buttons: primary "Start" (white fill, black text) + secondary "Skip" (transparent, grey border)
  4. **Queue section** — section header "Up Next · Queue" + count, then a card containing 3–5 task rows.
  5. Bottom nav (5 tabs, fixed).

#### Variant B — Day timeline
- Vertical timeline with a "NOW" marker, the active hero card pinned to NOW, and upcoming tasks listed below at their scheduled times. Good if scheduling/time-blocking is core to the product.

#### Variant C — Swipe deck
- Stack of cards; user swipes ↑ to mark done, ↓ to skip. Shows one task at a time. Good for a "deep focus mode" — could be a sub-mode within Variant A's hero card.

#### Components on this screen
- **Hero card** — black bg, white text, inverted priority chip, two CTAs. Border radius 14px. 4px soft shadow.
- **Queue task row** — checkbox, title, priority chip, due, tags. See "Task item" below.
- **Bottom nav** — see "Bottom nav bar" below.

### 2. Mobile · Project view

**Three approaches explored. Pick one — recommended: Variant A (most expressive of the Project → Section → Stage → Task hierarchy).**

#### Variant A — Stacked sections (recommended)
- **Purpose:** Show all work in one project, grouped by Section, then Stage, then Task.
- **Layout:**
  1. Status bar
  2. Header: back arrow + breadcrumb ("‹ projects"), then large project title ("Website Redesign", ~22px, 800 weight, -0.5 letter-spacing).
  3. Stat strip (mono, small): "32 TASKS · 11 DONE · 3 STAGES"
  4. Thin progress bar (4px tall, black fill on grey track).
  5. Stack of **Section cards**, each containing collapsible **Stage groups**, each containing **Task rows**.
  6. Bottom nav.
- Sections are the top-level groupings inside a project (e.g. "Marketing", "Engineering", "Design"). Stages are sub-groupings (e.g. "Drafting", "Review", "Shipping"). Both collapse independently.

#### Variant B — Stage filter chips
- Same content but with a horizontal chip row at the top to filter by Stage across all sections (All / Drafting / Review / Shipping / Backlog). Good if users tend to work *across* sections at the same stage.

#### Variant C — Outline mode
- Dense indented list (Section → Stage → Task) with no card chrome. Power-user view. Could be a per-project view-mode toggle.

### 3. Desktop · Three-pane layout

**Two approaches explored.**

#### Variant A — Roomy sidebar (recommended default for project work)
- **Grid:** `220px | 1fr | 280px`
- **Left sidebar (220px):**
  - App title "Tasker" + workspace label
  - Top-level nav: Focus, Today briefing, Inbox, All tasks
  - "PROJECTS" section: list of projects with task counts; active project has white fill, 1px border, dot indicator
  - "+ New project" at the bottom
  - Background: very light grey (`#fafafa`); border-right divider.
- **Center pane:** project view — header with project title, view-mode tabs (List / Board / Outline), search, then the same Section → Stage → Task structure as mobile but with more breathing room and longer task titles.
- **Right rail (280px) — In-Progress sidebar:**
  - "IN PROGRESS · 3" label
  - **Featured "Doing now"** card (black bg, white text, progress bar showing focus session timer e.g. "15 / 25 MIN")
  - 2–3 secondary in-progress task cards (white bg, dashed border, progress bar)
  - "QUEUE · NEXT 3" mini-list
  - **Daily Briefing** card (white bg, dashed border) with AI-generated summary text + "Read full briefing →" link

#### Variant B — Skinny rail (recommended for Focus tab)
- **Grid:** `64px | 1fr | 320px`
- Skinny black left rail with icons + small workspace switcher chips at the bottom.
- Center pane is the **Focus** tab (greeting + hero card + queue).
- Right rail has the briefing summary (in handwritten/serif voice for warmth) + in-progress list with progress bars.
- Use this layout when the user is in Focus mode; switch to Variant A when they enter a Project.

## Components

### Task item
- **Anatomy:** checkbox (16×16, 1.25px solid black border, 3px radius) · title (13px, weight 500) · meta row beneath (priority chip + due date + tags).
- **States:**
  - **Default:** white fill checkbox.
  - **In progress:** checkbox filled with a 45° black/white stripe pattern (`repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px)`).
  - **Done:** checkbox filled solid black; title gets line-through; whole row at 50% opacity.
- **Row separator:** 1px dashed light-grey between rows.
- **Trailing affordance:** "⋯" overflow on the right (reveal on hover/long-press).

### Priority chip
Encoded by **fill density**, not color (greyscale constraint):
- **RUSH** — solid black bg, white text
- **HIGH** — dark grey (`#444`) bg, white text
- **MED** — white bg, black text, 1px solid black border
- **LOW** — white bg, grey text, 1px **dashed** black border
- Typography: monospace, 9–10px, weight 600, letter-spacing 0.6, all-caps. Padding: 2px 6px. Radius: 3px.

### Section card
- White card, 10px radius, 1px solid light-grey border (`#e6e6e6`).
- Header: collapse chevron · section title (13px, weight 700) · count (mono, 10px, muted) · "+" add button on the right. Header has a subtle off-white fill (`#fafafa`).
- Body: stack of Stage groups.
- Collapsed state: header only, no body, no border-bottom on header.

### Stage group
- Lives inside a Section card.
- Header row: "▸" chevron · stage label (mono, 9.5px, bold, all-caps, 1px letter-spacing) · dashed horizontal rule fill · count on the right.
- Body: stack of Task rows.
- Stages are separated by 1px solid light-grey within the same Section card.

### Bottom nav bar (mobile)
- 5 tabs: **Focus** (◉) · **Projects** (◰) · **Briefing** (☷) · **Inbox** (✉) · **Me** (○).
- Fixed to bottom, 1px top border, white background, ~14px bottom padding for iOS home indicator.
- Each tab: icon (16px) above label (mono, 8.5px, all-caps, 0.6 letter-spacing). Active tab: black icon + black label + 2px solid black top rule (replaces the 1px border on that tab); inactive: muted grey (`#9a9a9a`).
- Replace the unicode glyphs with proper icons in production.

### Briefing card (AI-generated)
- White bg, 1px dashed border, 10px radius.
- Header: small mono "✦ DAILY BRIEFING" label.
- Body: 1–2 sentences in a slightly more humanized voice (the wireframes use Caveat to signal "this is the AI talking"; in production, use the regular UI font but in a slightly larger size or italic to differentiate from chrome).
- Footer: "Read full briefing →" link.

## Interactions & Behavior

- **Tap a queue task** → opens task detail (not designed yet — see "Open questions" below).
- **Tap "Start" on the hero card** → enters a focus session (timer state); the card stays in the In-Progress rail with a live progress bar.
- **Tap "Skip"** → demotes the current task; the next-ranked task animates into the hero slot. Brief slide-up transition (~200ms ease-out).
- **Swipe left on a task row** → reveals "Done" / "Snooze" / "Delete" actions.
- **Long-press a task row** → enters multi-select mode.
- **Tap a section header** → toggles collapse with a height auto-animation (~180ms).
- **Drag a task row** → reorder within a stage; drag across stages to reassign.
- **Bottom nav tap** → switch tabs; preserve scroll position per tab.
- **Daily Briefing** is generated server-side daily; tapping the card opens a full-screen summary view (not designed yet).

## State Management

Recommended top-level state shape:
```ts
type Priority = 'RUSH' | 'HIGH' | 'MED' | 'LOW';
type Task = {
  id: string;
  title: string;
  notes?: string;
  priority: Priority;
  dueAt?: string;       // ISO
  tags: string[];
  inProgress: boolean;
  done: boolean;
  sectionId: string;
  stageId?: string;     // optional — task may live directly in a section
};
type Stage   = { id: string; sectionId: string; label: string; collapsed: boolean };
type Section = { id: string; projectId: string; title: string; collapsed: boolean };
type Project = { id: string; title: string };

type AIRanking = { taskIds: string[]; reasoning: Record<string, string> };
type FocusSession = { taskId: string; startedAt: string; durationMin: number } | null;
type Briefing = { date: string; summary: string; mustDoIds: string[] };
```

Persistence: server-backed (CRDT or last-write-wins with vector clocks if multi-device). AI ranking and briefing refresh on a schedule + on-demand.

## Design Tokens (greyscale)

```
--ink:        #111;   /* primary text, dark surfaces */
--ink-2:      #333;   /* secondary text */
--mute:       #6b6b6b;/* tertiary text, meta */
--mute-2:     #9a9a9a;/* disabled, very tertiary */
--line:       #cfcfcf;/* default border */
--line-2:     #e6e6e6;/* light divider */
--surface:    #f5f5f5;/* subtle fill */
--surface-2:  #fafafa;/* off-white surface */
--paper:      #ffffff;/* card / page bg */
--inverse-bg: #000000;/* hero card bg */
--inverse-fg: #ffffff;/* hero card text */
```

**No other hues.** Gradients allowed only between greys.

### Type scale (suggested starting point)
- Display: 32 / 800 / -0.8
- H1: 26 / 800 / -0.6
- H2: 22 / 800 / -0.5
- H3: 17 / 700 / -0.2
- Body: 13 / 500
- Body-sm: 11 / 500
- Meta (mono): 9.5–10 / 600 / +0.5 letter-spacing
- Use **Inter** or the codebase's neutral sans. Use **JetBrains Mono** or system mono for meta/timestamps/IDs.
- Do **not** use Caveat — that was a wireframe annotation device only.

### Spacing scale
4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 22 · 28 · 36 · 48

### Radius
3 (chips) · 6 (buttons) · 8 (small cards) · 10 (cards) · 14 (hero) · pill (filter chips)

### Shadows
Cards live mostly without shadows — rely on borders. The hero "Do This Now" card uses a single soft shadow to lift it: `0 4px 16px rgba(0,0,0,0.08)`.

## Assets

- **Icons:** the wireframes use unicode glyphs (◉ ◰ ☷ ✉ ○ ▾ ▸ ◷). Replace with a real icon set — recommend **Lucide** or **Phosphor** for web/React Native, **SF Symbols** for native iOS, **Material Symbols** for Android.
- **No imagery** is required for the core flows. The briefing card and project headers stay typographic.

## Open Questions for the Implementer

These are surfaces the wireframes did not cover and that should be designed before launch:

- **Task detail view** — full-screen drawer or modal? What fields are editable inline vs. behind an "Edit" button?
- **Create task flow** — quick-add bar at the bottom of a section/stage? Floating + button?
- **Project create/edit** — settings, members, archive.
- **Empty states** — empty Focus tab, empty Project, empty Inbox.
- **Notifications / inbox** — the Inbox tab is in the nav but not designed.
- **Settings, account, theme** — no dark-mode-specific design (the system is already monochrome; dark mode is a straightforward inversion).

## Files in this bundle

- `Tasker Wireframes.html` — entry point. Open in a browser.
- `wireframes.jsx` — all artboard contents (Focus variants, Project variants, Desktop variants, component sheet).
- `design-canvas.jsx` — the pan/zoom canvas wrapper. Not part of the product — purely a presentation tool.
- `README.md` — this file.

To view: open `Tasker Wireframes.html` in a modern browser. Use scroll to zoom, drag to pan, and click any artboard's expand icon to focus on a single board.
