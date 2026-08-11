# Webhooks: cron→edge-function auth via DB-generated Vault secret (TDE-377)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Pattern for letting a pg_cron job authenticate to a Supabase Edge Function with NO secret committed to the repo and NO manual `supabase secrets set` step (used by the webhook-dispatch drain):

1. A migration generates a random secret IN-DB and stores it in Vault: `vault.create_secret(<random>, 'webhook_dispatch_secret', ...)`, guarded by `if not exists (select 1 from vault.secrets where name=...)` so re-runs are idempotent.
2. **cron** reads it in SQL: `net.http_post(..., headers := jsonb_build_object('x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name='webhook_dispatch_secret')))`.
3. **The edge function** reads the SAME secret via a `security definer` RPC `public.get_webhook_dispatch_secret()` with EXECUTE revoked from public/anon/authenticated and granted ONLY to `service_role`. The function (service-role client) calls `sb.rpc('get_webhook_dispatch_secret')` and compares to the incoming header. Deploy the function with `--no-verify-jwt`.

Why the RPC: `supabase-js .from()` goes through PostgREST, which does NOT expose the `vault` schema — so the function can't read `vault.decrypted_secrets` directly. A locked-down RPC is the bridge.

GOTCHA: `gen_random_bytes()` (pgcrypto) lives in the `extensions` schema on Supabase and is NOT on a `do $$` block's default search_path → `function gen_random_bytes(integer) does not exist`. `gen_random_uuid()` IS on the path. Build random hex from two UUIDs instead: `replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')` (64 hex chars). Requires extensions `pg_net` + `supabase_vault`.

Reusable for any "cron pings my edge function" job that needs a shared secret.
