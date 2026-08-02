# Tasker on whity-core

Tasker's board, re-founded on [whity-core](https://github.com/AmroKSaleh/whity-core).
A separate product from KeyHub: its own host, its own database, its own tenants.

## Layout

- `app/` — Vite React SPA
- `plugin/` — `whity/plugin-tasker`, an SDK-only composer package
- `host/` — Tasker's own whity-core deployment (core fetched at a pinned ref into `.core/`, never committed)
- `docs/` — specs and plans

## Dev loop

```powershell
npm run host:up        # fetch pinned core, start Postgres, bootstrap (composer
                        # install + migrate + seed against the mounted core
                        # checkout), then start FrankenPHP
npm run plugin:install # deploy-copy plugin into the host, then migrate
npm run dev            # Vite on :5174, proxying /api to :8010
```

`npm run host:up` alone is enough on a clean clone: `host/docker-compose.yml`
runs a one-shot `bootstrap` service (composer install, then migrate, then
seed) against the same bind-mounted `host/.core` checkout the FrankenPHP
worker uses, and FrankenPHP only starts once `bootstrap` exits 0. This exists
because the `./.core:/app` bind mount hides whatever `vendor/` the image
build produced, and because FrankenPHP's persistent worker queries the
database on boot — it must find installed dependencies and migrated tables
before it can ever reach its first request.

`npm run host:migrate` / `npm run host:seed` still work standalone (e.g. to
re-run after adding a migration without tearing the stack down) — both are
idempotent, matching whity-core's own migrate/seed semantics.

`host:up` always passes `--build`, so both the `bootstrap` and `frankenphp`
images are rebuilt (from `host/.core`'s current `Dockerfile`) on every run —
Docker's layer cache makes an unchanged Dockerfile a fast no-op, but a real
Dockerfile change (new package, new PHP extension) in a freshly fetched core
ref is never silently skipped the way a bare `docker compose up -d` (no
`--build`) would skip it by reusing whatever image already sits under that
tag.

Host API: <http://localhost:8010/api> · Health: <http://localhost:8010/api/health>

Seeded dev accounts come from `host/.env` (`INITIAL_ADMIN_PASSWORD`).

### Troubleshooting: the stack crash-loops on first boot

This can happen on **any** `npm run host:up` (or any bare `docker compose up`
that recreates `bootstrap` — e.g. after editing `host/.env`), not just around
MCP, so it lives here rather than buried under a feature-specific section.

`bootstrap` unconditionally reruns `composer install` against the
bind-mounted `host/.core` checkout every time it starts, which rewrites the
autoloader files — this busts PHP opcache's per-file mtime validation for the
*entire* `vendor/` tree. On a Docker host with very few CPUs allocated
(`docker info` reporting `NCPU: 1` is the tell), the `FRANKENPHP_WORKERS`
concurrent workers then contend for that one CPU while cold-recompiling the
whole tree, and none of them finish inside PHP's 30-second
`max_execution_time` default. `tasker_frankenphp` crash-loops with

```
Fatal error: Maximum execution time of 30 seconds exceeded
```

inside a different random `vendor/` file each attempt, then Caddy gives up
("too many consecutive failures") and the container exits.

**Fix (local-only, gitignored — do not change the committed default):**
temporarily set `FRANKENPHP_WORKERS=1` in your own `host/.env` and recreate
`frankenphp` again — one worker gets the whole CPU and clears the cold-compile
hump. `host/.env.example` correctly keeps shipping `FRANKENPHP_WORKERS=4` as
the default for normal (multi-core) dev machines and CI runners; only bump
your own `host/.env` down if you actually hit this crash loop, and feel free
to raise it back up once the container is healthy.

### Enabling MCP (one-time per environment)

whity-core derives MCP tools automatically from schema-bearing routes, but
`POST /mcp` is gated TWICE, and both gates default to off:

1. **Infrastructure gate** — `McpTransportHandler`'s `$enabled` flag, read
   from the `MCP_ENABLED` env var in `public/index.php`. When unset/false,
   `POST /mcp` returns a bare 503 for every caller, before auth is even
   checked. `host/.env.example` (and `host/.env`) set `MCP_ENABLED=true`, so
   this is already handled for any clone that copies the example file — just
   make sure `host/.env` has it (re-copy from `.env.example` if your `.env`
   predates this change), then recreate the `frankenphp` container so it
   picks up the new env var (`npm run host:up`, or
   `docker compose --env-file host/.env -f host/docker-compose.yml up -d --force-recreate frankenphp`).
   (If this crash-loops, see the troubleshooting section above — it is the
   same `composer install`/opcache/CPU-contention issue, unrelated to MCP
   itself.)

2. **Per-tenant opt-in** — the `mcp.enabled` setting (`SettingsRegistry::MCP_ENABLED`),
   default `'false'`, checked by the `tenantMcpEnabled` closure in
   `public/index.php`. This is a database row in `tenant_settings`, not a
   file, so it does **not** come back on a fresh database on its own — there
   is no core migration/seeder for it (a *plugin* migration writing to a
   *core* settings table would cross a layering boundary, and this is
   host-level governance, not Tasker's concern).

   **This is now automated for a clean clone**: `host/scripts/enable-tenant-mcp.php`
   runs as the last step of the `bootstrap` compose service (after `seed`,
   in `host/docker-compose.yml` — Tasker's own file, not vendored core), and
   sets `mcp.enabled = 'true'` for the seeded "Default Tenant" by calling
   `SettingsService::setTenant()` directly against the same Postgres
   connection `migrate`/`seed` use. It runs **in-process, not over HTTP**,
   because `frankenphp` (the only thing that ever serves `/api`) is not
   started until `bootstrap` exits 0 — the documented `PATCH /api/v1/settings`
   call has nothing to reach yet at that point in the container lifecycle.
   The step is non-fatal: if it fails for any reason, `bootstrap` still
   completes and `frankenphp` still starts, just with MCP off for the tenant
   until the fallback below is run.

   **Manual fallback** (a tenant that predates this automation, a different
   seeded tenant name, or the automated step failed) — the same settings API
   a tenant admin would use from the Settings UI:

   ```powershell
   $base = 'http://localhost:8010'
   $csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
   $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
   Invoke-RestMethod -Uri "$base/api/v1/login" -Method Post -ContentType 'application/json' `
       -Headers $csrf -Body (@{ email = 'admin@example.com'; password = 'admin123' } | ConvertTo-Json) `
       -WebSession $session | Out-Null
   Invoke-RestMethod -Uri "$base/api/v1/settings" -Method Patch -ContentType 'application/json' `
       -Headers $csrf -Body (@{ settings = @{ 'mcp.enabled' = 'true' } } | ConvertTo-Json) `
       -WebSession $session | Out-Null
   ```

   Equivalently: log in to the app as `admin@example.com` and flip the MCP
   toggle from `/admin/settings` (General tab).

Once both gates are open, `npm run mcp:tools` mints a short-lived MCP token
and dumps Tasker's derived tools (`tools/list`, filtered to `*ping*`) as JSON.
`npm run mcp:check` compares that live output against the committed
`docs/mcp-tool-surface.json` snapshot and fails loudly on drift — e.g. if a
route's `operationId` is renamed without updating the snapshot — with a
distinct exit code (`1`) from an infrastructure/setup problem that kept the
check from running at all (`2`; e.g. host down, either MCP gate still off,
or a bad/expired token). Regenerate the snapshot deliberately with
`powershell -File host/scripts/mcp-tools.ps1 -Write` after an intentional
tool-surface change.

## Upgrading core

Edit `host/core.version`, then `npm run core:fetch && npm run host:up`.
`host:up`'s `--build` flag (see above) means this always rebuilds both
images against the newly checked-out ref — no separate rebuild step needed.
