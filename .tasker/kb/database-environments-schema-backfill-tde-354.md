# Database: Environments schema + backfill (TDE-354)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Environments (single-user context partition above projects) shipped to the live DB 2026-07-04. Migration: `V2/supabase/migrations/20260704120000_add_environments.sql`. Hierarchy is now Tasker → Environments → Projects → Sections → Tasks.

**Schema**
- `environments` — `id uuid pk, user_id uuid (FK auth.users ON DELETE CASCADE), name text, sort_order int default 0, created_at`. RLS "own all" policy (`auth.uid() = user_id`), index on user_id. MCP (service role) bypasses RLS; web app (user JWT) relies on it.
- `projects.environment_id` — nullable FK → environments, **ON DELETE SET NULL** (deliberate: deleting an Environment must NEVER cascade-delete projects; the app/MCP reassigns to the user's Default first per TDE-358, and a null environment_id is treated as "Default/unassigned"). Indexed.
- `user_settings.active_environment_id` — nullable FK, the server-owned active-Environment pointer. Sits next to the existing `default_project_id` (read at functions/mcp/index.ts:105). Web owns the UI state; MCP takes environment_id explicitly and reports this as a default.

**Backfill result (live)**: 7 users with projects → 7 "Default" environments; 24/24 projects assigned, 0 orphaned. Only 5 of the 7 users had a `user_settings` row, so 2 have a null active pointer — EXPECTED. Consumers must fall back to the user's Default env when `active_environment_id` is null (a user_settings row is created lazily).

**Deploy gotcha**: applied via `npx supabase db query --linked --file <migration>` (NOT `db push`) because the migration tracker is drifted (see "remote migration history drifts" KB). The migration is fully idempotent (all `if not exists` / guarded backfill with `not exists`), so a later `db push` re-run is safe.

Next: TDE-355 (MCP: create_project takes environment_id, list_projects/init_tasker_session filter+report active env), TDE-356/357/358 (web).
