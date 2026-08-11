# ⚖ Instruction Set — governs every task in Tasker Development (project-wide)

_READ THIS ONCE at session start. It governs all work in this project. Read-only snapshot, regenerated on every pull — never synced up (edit the IS via the web app / MCP)._

## Code Style

All new frontend code is JSX (not TSX). Use functional components only. No class components. Tailwind for all styling - no inline styles except dynamic values (e.g. width percentages). No comments unless the WHY is non-obvious. Keep components focused - if a component exceeds ~150 lines, consider splitting.

## Deployment Rules

Frontend deploys to Netlify only: 
px netlify-cli deploy --prod --dir=dist. MCP deploys to Supabase Edge Functions: always include --no-verify-jwt. Never deploy an APK or mobile build unless explicitly requested. Always confirm before pushing to any remote.

## Task Format

When describing or listing tasks, always use the short ID format (e.g. TDE-52), never UUIDs. Group tasks by section when listing multiple. Do not number tasks - the app does not use numbering.

## Positioning: Durable, quality-gated state

Tasker is durable, human-shared, quality-gated state that persists across sessions, agents, and people. This is not a feature description — it is the core design principle that should inform every decision made in this project.

**What it means:**
- The AI (Claude Code, Cursor, etc.) is a first-class user of Tasker, not an add-on.
- The MCP integration is the primary interface, not a secondary feature.
- Tasks, flows, contracts, and context are designed to be consumed and acted on by AI agents, not just read by humans.
- Every feature should be evaluated through this lens: does it make the AI workflow tighter, faster, or higher quality?

**The competitive wedge:**
Others (like Linear, ClickUp, Asana) let agents work IN the tool as colleagues, but they treat them like regular team members. Tasker is different: we GATE what agents ship. Tasker provides durable structure (contracts, validation loops, independent review) so the agent's work doesn't merge into shared memory until it passes the human's bar. We don't compete on being a faster ephemeral scratchpad (native tools win there); we win on durability and enforced quality.

**When designing or evaluating a feature, ask:**
- Does this make the AI-native workflow meaningfully better?
- Does this reduce friction between what the AI knows and what the task manager knows?
- Would a solo dev building with AI find this indispensable?

## Dynamic KB: Write learnings on task completion

## Dynamic KB Rule

Before calling `complete_task` on any task, ask: **did this work surface anything non-obvious that a future agent or session should know?**

If yes — call `create_kb_entry` first, then complete the task.

**What qualifies as a KB-worthy learning:**
- A decision made (and why — the why is the part that would otherwise be lost)
- A constraint or gotcha discovered during the work (e.g. "Supabase db push doesn't apply migrations if remote is ahead")
- An architectural choice with a non-obvious rationale
- A resolved ambiguity that took effort to settle
- A pattern that should be reused (with enough context to actually reuse it)

**What does NOT qualify:**
- Things already in the code (the code is the record)
- Things already in git history or commit messages
- Things already in the task's own context/notes
- Ephemeral state ("I tried X next") — only persist the conclusion

**Title format:** `[Area]: [what was learned]` — e.g. "MCP: resolveProject accepts slug, UUID, or prefix"

The goal is a KB that grows automatically as work happens, so future sessions start with accumulated project knowledge instead of reconstructing it from scratch.

## Test 1

write "connected to IS1"

## Test 2

Write "connected to T2"

## Dynamic Seed Creation

Whenever you identify a new body of work but lack the context or alignment to define the exact execution steps, DO NOT create a normal task. Instead, dynamically create a Context Seed (kind: "seed", seed_target: "task") and populate its checklist with the open questions and prerequisites that must be resolved first.
