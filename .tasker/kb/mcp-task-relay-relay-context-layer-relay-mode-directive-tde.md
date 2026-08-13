# {mcp} Task relay — relay_context layer + RELAY MODE directive (TDE-324)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-324 shipped TASK relay (MCP-first). Lets a creator hand a task to someone (human or AI) with a curated rationale layer so the assignee acts without a follow-up round-trip.

## What was built
- **Column** `tasks.relay_context text` (nullable). Migration `V2/supabase/migrations/20260630120000_add_task_relay_context.sql`. Presence = relay task; text = the payload. ONE column is both flag and payload — no separate boolean.
- **create_task / update_task**: new optional `relay_context` param (insert/allowed-list + tool schema).
- **get_task**: renders a LOUD block right under the status line (before Context): `[Recording context for the task]` marker + "this was RELAYED to you, act on it without asking" framing + the notes.
- **ASSISTANT_DIRECTIVES**: new "RELAY MODE" entry — when user says relay/hand-off/share, announce `[Recording context for the task]`, then capture a CURATED layer (recipient free-text, decision+why, rejected approaches, intent, open Qs, watch-outs).

## Key design decisions (the WHY)
- **relay_context is DISTINCT from detail, not a replacement.** detail = distilled self-contained what/how (TDE-305 cold-reader contract); relay_context = the hand-off WHY layer (rejected approaches, intent, recipient). Curated, **NOT a transcript dump** — deliberately consistent with TDE-305 rather than reintroducing the dump it banned.
- **Recipient is FREE TEXT for now** (e.g. "to: Sara (backend)"). Real team-member refs + AI auto-routing are deferred (blocked on the multi-login/membership fork — see [[design_worlds_environments_multilogin]]). Free text is the forward-compatible stepping stone.
- **Scoped to TASK relay only.** Project-level relay (title said "task/project") deferred as a seed.

## Deferred (created as follow-ups)
- Seed: "Relay an entire project" (MCP & Integrations) — likely export-bundle + relay note; underspecified.
- Seed: "Team members in DB + AI relay auto-routing" (Research & Planning) — blocked on identity/membership foundation.
- Task: "Surface relay context in the web app task view" (Core App) — until done, only AI assignees via MCP see relay context; human teammates in the web app do NOT.

## Free wins
- export/import already carries `relay_context` with ZERO changes — exportProjectBundle uses `select('*')` and importProjectBundle spreads via `stripManaged` (only strips id/created_at/updated_at/user_id/project_id). Any new task column travels verbatim.

## Verified live
Smoke-tested on prod (mcp v156): create_task with relay_context → stored + new confirmation message; get_task → renders the marker block correctly.
