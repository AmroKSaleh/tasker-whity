# Architecture Overview

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Architecture Overview

Updated 2026-08-07. The original three-layer spine below is still accurate; everything under "What grew on top" is V2 structure the earlier version of this entry predated.

## Frontend
React + Vite SPA hosted on Netlify. State via Zustand. Tailwind for all styling. Talks to Supabase directly through the JS client. JSX only — no TSX, functional components only.

Shared layout is `AppShell` (hover-expanding left icon rail). Routing is flat in `App.jsx`: `/home` is Today, `/projects` is the project list, `/dashboard/:slug` is a project board, plus `/flows`, `/environments`, `/organizations`, `/settings`, `/connectors/*`, `/recycle-bin`, `/new`, `/docs/*`. **Sections are not routes** — section focus is state inside `ProjectBoard`.

## Backend
Supabase — Postgres + Auth + Storage + Edge Functions (Deno). All data in Postgres with RLS scoped to the authenticated user. Two long-lived functions: `mcp` (the MCP server) and `rest-api`, plus connector/OAuth functions.

## MCP Layer
A single Edge Function (`/functions/v1/mcp`) implementing the Model Context Protocol over HTTP/JSON-RPC 2.0. Auth by `tsk_…` API key (hashed in `user_api_keys`) or OAuth2 access token. Deployed with `--no-verify-jwt`. This is the primary interface, not a secondary feature — AI clients are first-class users.

---

# What grew on top (V2)

## Flows and the quality gate — the moat
A flow is one operation too big for a sitting, cut into steps. Membership is `tasks.flow_id`; **order is derived from I/O edges** in `tasks.input`/`tasks.output`, not stored as a sequence. Contracts on those edges are OPTIONAL — a flow with no gates anywhere is still a flow. Validation is deliberately two-agent: the executor stores an artifact, an independent validator grades it. Flow steps leave the board entirely (TDE-320), which is a real and under-named cost.

Task-level review (the judge) is the standalone-task equivalent: a frozen `review_bar` on a task, graded via `submit_task_review`, where a blocker failure reopens the task.

## Environments and the org/RBAC layer
Project ownership is nested: Organization → Environment → Project. Environments are dual-owned via `org_id` (null = personal). Access is per-environment grants; grant = full access in v1.

**Status: built and live in the web app, dormant from the MCP.** The MCP exposes no org tooling, so org-owned projects are currently unreachable from it. Phase 2 — do not mistake shipped infrastructure for shipped product.

## Local Mode
Projects can opt into being mirrored to `.tasker/` files in a repo checkout. Files are the hot path, not per-edit MCP calls: pull → work the files → flush. Conflict resolution is last-write-wins on `updated_at`, with tombstones for deletes and ID leases so offline creation cannot collide. An optional watcher flushes edits within ~1s. A read-only Electron viewer exists (`V2/desktop/`).

Still hub-only: flows, group/section rename-delete-reorder, contract/KB authoring.

## Phases
Condition-bounded project stages ("Phase 1 ends when we launch") — bounded by an exit condition, not a date. Orthogonal to sections: **sections are categorical, phases are temporal.** Nullable; unphased is a legitimate permanent state.

## Connectors
Scoped, Tasker-relevant panels — never full app clients. Google (Gmail, Calendar, Tasks, Drive) on a shared refresh-token flow, plus GitHub. Each connector gets a docked Conductor intake panel with lifecycle tabs, scoped by source. Items land as `intake_jobs` with provenance.

## Agent-native surface
Typed agent session ledger, agent identity/provenance on every MCP write (the human stays owner), durable guidance a human leaves on a task, the prepare→confirm→execute proposal queue, outbound webhooks, and `get_my_attention` as the cross-task triage pull.

## Context economy
Token cost is a first-class architectural concern. `get_task` sends full project context only on first touch per session, then a compact pointer (`mcp_context_primed`). `get_project` omits task detail by default. Known remaining cost: `__init_tasker_session` ships its full directive playbook unconditionally (~6,000-token session floor) — measured and specced, not yet built.

## In-app AI
Intentionally present in V2 (`gemini.js`, NewProjectModal AI builder, TaskDetailPanel, section chat). It is the only AI available to non-MCP web users. The Option-1 removal was retired — do not re-remove.

## Soft delete
`tasks`, `projects`, `flows` carry `is_deleted` + `deleted_at`, purged by pg_cron after 7 days. Every tally must filter it; see the KB entry on soft delete + unfiltered tallies.

