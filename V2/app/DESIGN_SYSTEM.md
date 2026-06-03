# Tasker — Visual Design System

A spec for generating UI that is unmistakably "Tasker." Read the **Invariants** as hard rules — never break them. Treat **Variables** as your playground — vary them freely to produce different iterations of the same design language.

---

## 0. The design language (invariant)

Five adjectives define Tasker. Every screen must satisfy all five:

- **Editorial** — type is the primary visual material, not images or illustration. Strong hierarchy, magazine-style "kicker" labels, confident whitespace, content-forward layouts.
- **Minimal** — few elements, deliberate emptiness, no ornament. Hairline borders over heavy dividers. Flat surfaces. Shadows only when functional (a sheet lifting off the page).
- **Warm-dark** — neutrals carry a subtle warm/brown undertone. Never pure black, never pure white, never cool gray. Dark mode reads like dim paper, not a terminal.
- **Sharp typography** — precise and high-contrast. Bold weights for emphasis, tight negative tracking on large text, monospace for data and labels. Nothing soft or default.
- **Restrained color** — color is signal, not decoration. The UI is near-monochrome (the ink→paper ladder). Color appears ONLY where it means something.

Lane check: this is the Linear / Things 3 / editorial-tool lane. NOT colorful-playful (Asana, Trello). NOT heavy-material (Google/M3). NOT skeuomorphic.

---

## 1. Color palette (invariant values, variable usage)

**The ladder** — a 9-step warm grayscale. This is the backbone; most of every screen is built from it.

Light mode:
```
paper    #FBFAF6   (page background — warm off-white)
surf-2   #F5F3ED   (raised surface, subtle)
surf     #F0EDE5   (raised surface)
line-2   #ECE9E1   (hairline divider, faint)
line     #D4D0C8   (hairline border)
mute-2   #9A9896   (faintest text — timestamps, disabled)
mute     #6B6867   (secondary text — labels, meta)
ink-2    #3D3B36   (body text)
ink      #1A1916   (primary text, near-black warm)
```

Dark mode (warm-tinted, NOT neutral gray):
```
paper    #16151B
surf-2   #1D1B22
surf     #232128
line-2   #2D2A33
line     #38353F
mute-2   #6B6867
mute     #9A9896
ink-2    #C7C4BD
ink      #F0EFEC   (warm off-white, never #FFFFFF)
```

**Accent — terracotta orange. The ONE brand color.** Reserve for the single most important action on a screen (primary CTA, focus action, AI features). Never use it decoratively.
```
accent       #D97757
accent-dark  #B85C35   (hover)
accent-2     #F5E6DE   (light) / rgba(217,119,87,0.18) (dark) — soft fill
accent-soft  rgba(217,119,87,0.10)   — faint hover wash
accent-edge  rgba(217,119,87,0.35)   — focus ring
```

**Star — pure yellow-gold.** Used ONLY for pinned / starred / favorite state, when toggled on or interacted with.
```
star       #FACC15
star-soft  rgba(250,204,21,0.14)
```

**Priority — semantic urgency only.** Never use these as decorative palette colors.
```
rush   #C0432D   (red)
high   #D97757   (= accent orange)
medium #8C8055   (olive)
low    #6B6867   (= mute gray)
done   #5C7A5F   (muted green)
```

**Usage rules (invariant):**
- A screen is ~90% ladder neutrals + ~10% signal color.
- One accent action per view. If two things are orange, one is wrong.
- Priority colors appear only as small dots/chips, never as fills covering large areas.
- Light and dark are co-equal first-class citizens — every iteration must work in both.

---

## 2. Typography (invariant)

**Families:**
- **Inter** (sans) — everything that is prose or UI. Weights 400/500/600/700/800.
- **JetBrains Mono** — labels, kickers, IDs, timestamps, counts, metadata. This is the editorial signature: small, uppercase, wide-tracked mono labels acting like magazine section headers.

**Scale:**
```
display   32px / 38 line / -0.8px track / 800 weight
h1        26px / 32 / -0.6px / 800
h2        22px / 28 / -0.5px / 800
h3        17px / 24 / -0.2px / 700
body      13px / 20 / 500          ← base body size
body-sm   11px / 16 / 500
meta      9.5px / 14 / +0.5px / 600
2xs       10px / +0.08em
3xs       9.5px / +0.1em
```

**Rules:**
- Base body is 13px — this is a dense, information-rich tool, not a marketing page.
- Large text gets NEGATIVE tracking (tight). Small mono labels get POSITIVE tracking (wide) and UPPERCASE.
- Hierarchy comes from weight + size jumps, not from color.

---

## 3. Spacing & shape (invariant scale, variable application)

**Border radius:**
```
xs 3 · sm 4 · md 6 · lg 8 · xl 10 · 2xl 14 · sheet 14 · pill 9999
```
Cards/sheets use 10–14. Buttons/inputs use 6. Chips/pills use pill or 4. Keep it consistent within a component family.

**Spacing:** standard 4px grid (4, 8, 12, 16, 20, 24…) plus 18 and 22. Tight density — components breathe with 8–16px internal padding, not 24–32.

---

## 4. Shadows (invariant — use sparingly)

Shadows are functional, never decorative. A flat surface stays flat unless it's *lifting*.
```
card   0 1px 3px rgba(26,25,22,0.06)    — barely-there card lift
sm     0 1px 2px rgba(26,25,22,0.05)
panel  -12px 0 32px rgba(26,25,22,0.08) — side panel sliding in
sheet  0 -8px 24px rgba(26,25,22,0.18)  — bottom sheet
fab    0 4px 16px rgba(26,25,22,0.25)   — floating action button
drag   0 18px 40px rgba(26,25,22,0.18) + 1.5px accent ring — dragging
```

---

## 5. Motion (invariant)

- **Signature easing:** `cubic-bezier(0.2, 0.7, 0.3, 1)` — used for nearly all transitions.
- **Durations:** 180ms (fades), 220–240ms (slides), 260–280ms (sheets/cards).
- **Named animations:** fade-in/out, slide-in/out-right (panels), sheet-up/down (bottom sheets), card-rise (centered→bottom modal entrance).
- Motion is quick and crisp, matching "sharp." No bouncy/playful spring physics.

---

## 6. Components (invariant patterns)

- **Buttons:** `btn` (neutral outline), `btn-primary` (ink fill), `btn-focus` (accent fill — the focus/primary action), `btn-ghost` (transparent). `btn-sm` for compact.
- **Icon buttons:** `icon-btn` (28px, mute→ink on hover), `icon-btn-focus` (accent-filled, paper icon — the prominent focus action).
- **Chips (priority):** rush = ink fill; high = ink-2 fill; medium = ink outline; low = dashed mute outline. Tiny, mono-ish.
- **Pills (filters):** rounded-full, hairline border, mono uppercase label, optional count badge. Active = ink fill.
- **Cards:** flat `paper`/`surf` with hairline border + `card` shadow, radius 10–14.
- **Sheets/modals:** bottom-anchored or centered, `sheet` shadow, lighter/heavier backdrop per context.
- **Kicker labels:** `font-mono ~9px uppercase tracking-widest text-mute` — the editorial section-header signature, used above groups of content everywhere.

---

## 7. Iconography (invariant)

- **lucide-react**, thin stroke, 14–16px in dense UI.
- Plus a few glyph icons used as text (★ star, ◎ focus, ✦ AI, ▶ in-progress). Keep glyph usage consistent with existing meaning.

---

## 8. Theming (invariant mechanic)

- `data-theme="dark"` on `<html>` swaps CSS variables. All color is referenced via tokens (`--color-x`), never hardcoded hex in components.
- FOUC prevented by a synchronous boot script reading `localStorage`.
- Every iteration must be designed in BOTH themes; neither is an afterthought.

---

## 9. Pages & their functions

For each page: route, purpose, key regions, and *why* it exists. When redesigning a page, the **function and information hierarchy below are invariant** — what the page is *for* doesn't change. The **composition is variable** — how you arrange it is open (see VARIABLES).

> Route-naming trip-hazard: `/home` renders **TodayPage**, `/projects` renders **HomePage**. The route names are inverted from the file names. Functional, but worth knowing.

### TodayPage — `/home`  (default landing, authenticated)
The daily cockpit. A cross-project "what should I do today" view.
- **Regions:** progress-glance line (done today · in progress); Today's Meetings strip (from Google Calendar); priority buckets with dedup — Overdue, Carried from yesterday, Due today, In progress, Pinned, Added to today; **Today's Focus** (ranked candidates, filterable by project); **Daily Briefing** (AI-generated, cross-project); **Calendar pane** (month grid + vertical week list); Activity (tasks completed today, collapsed by default); **task detail sheet** (bottom-anchored, opens on row click); **focus overlay**; **undo toast** on mark-done.
- **Why:** home base. Surfaces the highest-signal tasks across every project so the user immediately knows what to act on, without entering a board.

### DashboardPage — `/dashboard/*`  (the project board, authenticated)
Deep work inside one project.
- **Regions:** project header (rename, ✦ Context, KB, IS, Focus, export, GitHub repo + sync); filter bar (status + priority pills); horizontally-scrolling **columns = sections**; **swimlanes = groups**; task cards with inline add-task; in-progress sidebar/sheet; **task detail panel** (desktop) / **sheet** (mobile); focus overlay.
- **Why:** the workspace for organizing and executing a single project — the kanban-style surface where structure (sections/groups) and execution (status, priority, milestones) live.

### Focus mode — overlay (no route; summoned from Today, the board, and task detail)
The app's signature feature. A full-screen, immersive, single-task view that strips everything else away so the user works on one thing.
- **Regions:** top bar ("Focus · {project}" mono kicker + close); large task title (~34px / 800); **"Why this is your focus"** (AI-generated reason); **"What to do"** (AI-generated steps in a checkable accordion); primary actions ("Mark as done", "Skip — show me later", "Discuss this task further"); a **nudge interstitial** when opened on a non-top task ("Go to the top priority task instead" / "Continue anyway"); pin prompts (suggest-pin after 3 days as top, re-eval after 7 days pinned); a bottom **discussion sheet** (~75vh) for AI chat about the task.
- **Why:** the focus ritual — Tasker's answer to "what's the one thing, and how do I start it." The AI reason + steps turn a bare task into an actionable plan.
- **⚠ THEMING EXCEPTION (invariant):** Focus mode is **always dark**, regardless of the user's light/dark setting. Near-black immersive background (`#0a0a0a`), white/grey text, accent + star colors as the only color. Do NOT make Focus mode theme-aware — the always-dark immersion is the point. This is the one surface that escapes the token/both-themes rule.

### HomePage — `/projects`  (project list, authenticated)
Project switchboard.
- **Regions:** header with "+ New Project"; drag-reorderable grid of **ProjectCards** (name, progress %, default-project star); empty state; **New Project modal** (conversational creation).
- **Why:** choose, create, and reorder projects; the entry point into individual boards.

### SettingsPage — `/settings`  (authenticated)
Settings + MCP onboarding hub.
- **Regions:** **Appearance** (Light / Dark / System theme); **MCP connection setup** — API-key generation, per-platform setup steps (Claude Code, Cursor, Windsurf, Roo Code) with copyable code snippets and a test-connection action; auth choice (API key vs OAuth).
- **Why:** configure the app and connect external AI agents to the Tasker MCP server.

### LoginPage — `/login`  (public)
- **Regions:** brand mark, Google + GitHub OAuth sign-in.
- **Why:** authentication entry. Single-purpose, minimal.

### OAuthAuthorizePage — `/oauth/authorize`  (public)
- **Regions:** consent screen for an external client requesting access to a user's Tasker via the MCP.
- **Why:** the OAuth authorize handshake when an agent platform connects. Single-purpose, minimal.

---

## VARIABLES — what to explore per iteration

These are NOT fixed. Vary them freely to generate distinct iterations that still feel like Tasker:

- **Layout & composition** of any screen — column counts, sidebar vs top-nav, where panels live.
- **Surface choreography** — which ladder steps (paper vs surf vs surf-2) carry which regions; how depth is implied without heavy shadow.
- **Information density within the tight range** — denser tables vs slightly roomier cards (but never "airy marketing-page" spacing).
- **Card vs list vs grid** arrangements for the same content.
- **Whitespace rhythm** and how kicker labels segment a page.
- **Component grouping** — what's bundled into a card, what stands alone.
- **Empty states, hover treatments, micro-interactions** — within the motion rules.
- **Navigation model** — rail, tabs, breadcrumb, command-palette-forward, etc.

---

## Iteration prompts for Claude Design

Use prompts like these to get variations that all obey the language above:

- "Redesign the Today page three ways — all editorial/minimal/warm-dark/restrained-color per the system. One list-dense, one card-based, one calendar-forward."
- "Show 3 layouts for the project board that keep the tight density and mono kicker labels but rethink how columns and the detail panel coexist."
- "Give me 2 alternative task-detail sheet compositions. Same tokens, same motion, different information architecture."

Always tell Claude Design: *stay within the invariants, vary only the variables.*
