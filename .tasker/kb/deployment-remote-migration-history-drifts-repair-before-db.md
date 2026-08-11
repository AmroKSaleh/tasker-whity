# Deployment: remote migration history drifts — repair before db push

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

GOTCHA (hit 2026-06-19 deploying TDE-287): `supabase migration list` showed the remote 11 migrations behind, but those features had already SHIPPED (custom statuses, multi-badge TDE-249, KB source/archive/category, task review/TDE-261 P2). Their schema was applied out-of-band, so the remote `supabase_migrations.schema_migrations` table drifted out of sync with reality.

WHY IT MATTERS: a plain `supabase db push` would have re-run all 11 + the new one. Most are idempotent (`add column if not exists`), but two are NOT safe to re-run: `seed_baseline_instruction_set` (data seed → duplicate rows) and `schedule_kb_archive_sweep` (cron → error/double-schedule).

SAFE PATTERN when the tracker is behind but the schema is already live:
1. `supabase migration repair --status applied <v1> <v2> ...` — marks the already-live migrations applied WITHOUT re-running them (accepts multiple versions in one call).
2. `supabase db push` — now applies ONLY the genuinely-new migration.
3. `supabase functions deploy mcp --no-verify-jwt`.

CAVEAT: repair is only correct if those schemas truly are live on remote (verify via shipped commits / the live app using the feature). If a migration was committed but never applied, repair would wrongly skip it. Run `supabase db push --dry-run` first to see exactly what WOULD be pushed before deciding.

Also: this MCP function (index.ts) has ~24 pre-existing TS type errors that `deno check` flags; Supabase bundles with esbuild and ignores type-only errors at deploy, so they are non-fatal. Don't be alarmed by them — but new code should still type-check clean (extract pure logic to a side module like contract_gate.ts to unit-test it, since index.ts runs Deno.serve at import).
