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

### Enabling MCP (one-time per environment)

whity-core derives MCP tools automatically from schema-bearing routes, but
`POST /mcp` is gated TWICE, and both gates default to off:

1. **Infrastructure gate** — `McpTransportHandler`'s `$enabled` flag, read
   from the `MCP_ENABLED` env var in `public/index.php`. When unset/false,
   `POST /mcp` returns a bare 503 for every caller, before auth is even
   checked. `host/.env.example` (and `host/.env`) now set `MCP_ENABLED=true`,
   so this is already handled for any clone that copies the example file —
   just make sure `host/.env` has it (re-copy from `.env.example` if your
   `.env` predates this change), then recreate the `frankenphp` container so
   it picks up the new env var (`npm run host:up`, or
   `docker compose --env-file host/.env -f host/docker-compose.yml up -d --force-recreate frankenphp`).

2. **Per-tenant opt-in** — the `mcp.enabled` setting (`SettingsRegistry::MCP_ENABLED`),
   default `'false'`, checked by the `tenantMcpEnabled` closure in
   `public/index.php`. This is a database row in `tenant_settings`, not a
   file, so it does **not** come back on a fresh database/clean clone — there
   is no migration or seeder for it (a plugin migration setting a *core*
   settings row would be the wrong layer; this is host-level, not Tasker's
   concern). Enable it once per tenant, via the same settings API a tenant
   admin would use from the Settings UI:

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
   toggle from `/admin/settings` (General tab). Either way it is a one-time
   step per database — repeat it after any fresh `host:up` against a new
   Postgres volume.

Once both gates are open, `npm run mcp:tools` mints a short-lived MCP token
and dumps Tasker's derived tools (`tools/list`, filtered to `*ping*`) as JSON.
`npm run mcp:check` compares that live output against the committed
`docs/mcp-tool-surface.json` snapshot and fails loudly on drift — e.g. if a
route's `operationId` is renamed without updating the snapshot. Regenerate
the snapshot deliberately with `powershell -File host/scripts/mcp-tools.ps1 -Write`
after an intentional tool-surface change.

**Troubleshooting a cold-boot crash loop:** on a Docker host with very few
CPUs allocated (`docker info` reporting `NCPU: 1`), recreating `frankenphp`
right after `bootstrap` reruns `composer install` can crash-loop with
`Fatal error: Maximum execution time of 30 seconds exceeded` inside random
`vendor/` files, because `composer install` rewrites the autoloader (busting
opcache's per-file validation) and `FRANKENPHP_WORKERS` concurrent workers
then contend for the one CPU while cold-recompiling the entire vendor tree,
never finishing inside the 30s cap. If you hit this, temporarily set
`FRANKENPHP_WORKERS=1` in `host/.env` and recreate `frankenphp` again — one
worker gets the whole CPU and clears the cold-compile hump; you can raise the
worker count back up afterwards once the container is healthy.

## Upgrading core

Edit `host/core.version`, then `npm run core:fetch && npm run host:up`.
`host:up`'s `--build` flag (see above) means this always rebuilds both
images against the newly checked-out ref — no separate rebuild step needed.
