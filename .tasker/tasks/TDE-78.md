---
id: TDE-78
title: Local vs live storage
status: done
priority: low
section: research-planning
order: 2
updated_at: 2026-07-14T23:09:51.590Z
---

Captured 2026-05-26 from a discussion about MCP call cost vs local memory cost. Open question: where should each kind of data live, and is there a layer between "MCP only" and "agent local memory" that's worth building?

## The cost asymmetry we discovered

**Wall time:** Local file read is ~ms. MCP call is browser → Anthropic → Claude Code → Supabase Edge Function → Postgres → back, so ~200–500ms per call. 10–100x slower per round-trip. This is what you feel as "slow."

**Token cost in context:** Roughly equivalent, often MCP wins. MCP responses are pre-formatted server-side (e.g. "TDE-3 — Today page redesign [medium]" is ~10 tokens). A raw local file Read can be 1000+ tokens. So per-call tokens are usually equal or cheaper via MCP — the perceived cost is mostly latency, not token bloat.

## The right rule per data type

- **Stable info** (user preferences, role, design decisions, project architecture) → local memory. Cheap, stable, pre-curated, fast.
- **Live mutable state** (task list, statuses, milestones, KB contents) → MCP. Source of truth. Caching it locally goes stale the moment a write happens.
- **Already in this conversation's context** → don't re-fetch. Re-read existing turn instead.

## Things to think about for this task

- Is there value in a local cache *with* invalidation hooks (e.g. realtime subscription invalidates a local Tasker snapshot stored in agent memory)? Probably not — the staleness window is small but the failure mode (acting on stale data) is high-cost.
- Could MCP responses be made even more compact? E.g. `list_tasks` could have a "minimal" mode that returns just `id + text` for cases where the agent doesn't need priorities/statuses.
- Should tools that already exist in this session's context be auto-skipped? Currently the agent decides; could be a heuristic / tool-level guidance.
- For bulk creation flows like the Education curriculum (35 tasks), a `create_tasks_bulk` tool that takes a list of {task, milestones[]} in one call would collapse most of the cost — see [[why-creating-tasks-takes-a-long-time]] (TDE-77).

## When to revisit

This is dormant until something specific motivates it — e.g. a workflow that calls MCP enough times to feel painful, or a feature that genuinely needs local-first reads. Don't build a cache speculatively.
