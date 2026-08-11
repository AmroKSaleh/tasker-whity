# KB: staleness, archiving & pg_cron sweep

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

KB archiving model (TDE-184 milestones 5-6):

**Staleness signal:** `coalesce(reviewed_at, updated_at)` older than 60 days. NOT a real "reference" count — agents read the whole KB in one `get_knowledge_base` call, so per-entry reference tracking would mark everything read at once. "Last touched" is the honest proxy. A "Keep" action sets `reviewed_at = now()` to reset the clock without faking a content edit.

**Columns on project_knowledge:** `archived_at` (null = active, recoverable — NEVER auto-deleted), `reviewed_at`.

**Archive vs delete:** archived entries are excluded from all default reads (MCP `get_knowledge_base`/`list_kb_entries` add `.is('archived_at', null)`; frontend filters `!archived_at`). Restore = set archived_at null. Only explicit `delete_kb_entry` removes data.

**Auto-archive of AGENT entries — two layers:**
1. pg_cron daily job `kb-archive-stale-agent-entries` (03:00 UTC, jobid 1). pg_cron 1.6.4 is now enabled on this project (was NOT before — enabled via `create extension if not exists pg_cron`). Migration: 20260614131000_schedule_kb_archive_sweep.sql.
2. MCP `kb_health` tool also archives stale agent entries on call (immediate, belt-and-suspenders to the cron).

**USER entries are never auto-archived** — `kb_health` only reports them for manual confirm; frontend KB Health panel gives per-entry Keep/Archive. Agent entries get a bulk "Archive all".

**New MCP tools:** `kb_health` (report + sweep agent), `archive_kb_entry` (entry_id, restore?:bool). NOTE: tools added to the MCP are NOT callable in an already-running Claude Code session — the deferred-tool registry is fixed at session start. Verify new tools by hitting the deployed edge function over HTTP (JSON-RPC tools/call) instead.
