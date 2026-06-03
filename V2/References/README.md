# Tasker — Handoff Package

Hand this folder to Claude Code (or any agentic coding tool) to build the Tasker app.

## What's in here

| File | What it is |
|---|---|
| **`Tasker Build Prompt.md`** | The single spec document. Hand this to Claude Code as your starting prompt. Contains tech stack, data model, routes, every screen's contract, AI integration points, build order. |
| **`Tasker User Flow (standalone).html`** | The interactive flow diagram, bundled into one self-contained file. Drop it into your repo's `/docs` folder. Open it side-by-side with Claude Code so the model can reference exact screens and transitions. |

## How to use

### Option A — Drop into a fresh Claude Code project

1. Create a new directory for your Tasker codebase.
2. Copy both files in this folder into a `/docs` subdirectory.
3. Open Claude Code in the project root.
4. Paste this kickoff prompt:

```
Read docs/Tasker Build Prompt.md end-to-end. You'll also find an interactive
flow diagram at docs/Tasker User Flow (standalone).html — open it in a
browser to see every screen and transition.

Start by:
1. Setting up the Next.js 15 + Supabase project per section 2 of the spec.
2. Running the schema in section 3 against a fresh Supabase project.
3. Building Zone 1 (Authentication) end-to-end — all three sign-in modes.

Stop after I can sign in via email/password, magic link, and sign-up email
verification, and land on a stub /dashboard page. Don't start Zone 2 until
I review.
```

5. Review each zone before letting Claude continue to the next. The build order in §10 of the spec is structured so each milestone is independently testable.

### Option B — If you already have a codebase

Hand Claude the spec and tell it which sections apply. E.g.:

```
I have an existing Next.js + Supabase app. Read docs/Tasker Build Prompt.md.
Skip section 2 (tech stack) and section 1 (mission). Implement section 7,
Zone 4 (Project View) first, against the data model in section 3.
```

## Sanity-check before you start

- You have a Supabase project (or be ready to create one).
- You have an Anthropic API key.
- You have a Vercel account (or your own host).
- You can install `pnpm` or `npm`.

If any of those are missing, ask Claude Code to walk you through getting them set up — it can.

## What's deliberately deferred

§11 of the spec lists six "Future" features visible as dashed placeholders in the flow diagram. These are **out of scope for v1**. Don't let Claude build them on the first pass:

- OAuth providers
- Templates gallery
- Calendar / timeline view
- Recurring tasks
- Mobile in-progress drawer
- Focus timer / pomodoro

After v1 ships, you can revisit any of them and the data model + routing in the spec is already designed to accept them cleanly.

## Iteration loop

After Claude finishes a zone:

1. Run the app locally, walk through every interaction in that zone manually.
2. Cross-reference against the flow diagram — every transition should work.
3. Note anything off. Hand the notes back to Claude with the relevant zone number.
4. Once the zone is solid, ask Claude to start the next one.

Don't try to build everything in one pass. The flow has ~25 distinct screens — incremental review will keep quality high.
