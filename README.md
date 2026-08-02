# Tasker on whity-core

Tasker's board, re-founded on [whity-core](https://github.com/AmroKSaleh/whity-core).
A separate product from KeyHub: its own host, its own database, its own tenants.

## Layout

- `app/` — Vite React SPA
- `plugin/` — `whity/plugin-tasker`, an SDK-only composer package
- `host/` — Tasker's own whity-core deployment (core fetched at a pinned ref into `.core/`, never committed)
- `docs/` — `mcp-tool-surface.json`, the committed MCP tool-surface snapshot (see "Enabling MCP" below)

The design spec, the implementation plan, and the execution ledger for this
port live in the OTHER repo, `tasker` (`docs/superpowers/specs/` and
`docs/superpowers/plans/`) — not in this one.

## Prerequisites

- **Windows, with PowerShell 5.1+.** Every npm script in `package.json`
  either shells out to `powershell.exe` directly or relies on cmd.exe-style
  batch syntax, and `host/scripts/install-plugin.ps1` uses `robocopy`. This
  repo's tooling is Windows-only today — porting it to work cross-platform
  (macOS/Linux, or npm scripts runnable under a POSIX shell) is future work,
  not something this repo currently supports. Do not assume `npm run dev` /
  `host:up` / etc. work as documented on another OS.
- **Docker Desktop**, for the host stack (`host:up`) and for running the
  plugin's PHPUnit/PHPStan checks in containers (`plugin:test`, `plugin:stan`,
  `plugin:deps`) without installing PHP or Composer natively.
- **Node 20+** and **npm**, for the SPA (`app/`) and for every `npm run ...`
  entry point in this README.
- **Git**, to fetch the pinned `whity-core` ref into `host/.core`.

## Setup

One-time, from a fresh clone:

```powershell
npm run setup
```

This runs three steps in order (the order matters — `plugin:deps`'s
Composer install needs `host/.core` to already exist, since the plugin's
`composer.json` declares a path repository at `../host/.core/sdk`):

1. `core:fetch` — clones `whity-core` at the pinned ref (`host/core.version`) into `host/.core` (gitignored).
2. `plugin:deps` — `composer install` for `plugin/`, run inside a `php:8.4-cli`
   container (no host PHP/Composer needed) that mounts the REPO ROOT rather
   than just `plugin/`, because the SDK path-repository symlink
   (`plugin/vendor/whity/plugin-sdk` → `../host/.core/sdk`) only resolves
   when `host/.core` is visible in the same container.
3. `app:deps` — `npm ci --prefix app`, installing `app/node_modules` from the
   committed `app/package-lock.json`.

Each step can also be run on its own (`npm run core:fetch`, `npm run
plugin:deps`, `npm run app:deps`) — e.g. to re-run just `app:deps` after
pulling a lockfile change — as long as the ordering constraint above is
respected.

`plugin/vendor/` and `app/node_modules/` are both gitignored; nothing else in
this repo creates them, so a clean clone that skips this section will see
`plugin:test`, `plugin:stan`, `app:test`, and `npm run dev` all fail.

## Dev loop

Run `npm run setup` first (see above) if you have not already — the three
commands below assume `host/.core`, `plugin/vendor`, and `app/node_modules`
all already exist.

```powershell
npm run host:up        # fetch pinned core, start Postgres, bootstrap (composer
                        # install + migrate + seed against the mounted core
                        # checkout), then start FrankenPHP
npm run plugin:install # deploy-copy plugin into the host, then migrate
npm run dev            # Vite on :5174, proxying /api to :8010
```

`npm run host:up` alone is enough to bring up a working host stack on a clean
clone (once Setup has run — see above): `host/docker-compose.yml` runs a
one-shot `bootstrap` service (composer install, then migrate, then seed)
against the same bind-mounted `host/.core` checkout the FrankenPHP worker
uses, and FrankenPHP only starts once `bootstrap` exits 0. This exists
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

Before `npm run dev` / `npm run app:build`: copy `app/.env.example` to
`app/.env.local` (gitignored). The copied SPA still imports
`@supabase/supabase-js` directly in 57 files, and `src/lib/supabase.js`
calls `createClient()` eagerly at module load — without
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set, the whole app fails to
boot, including routes unrelated to Supabase. `app/.env.example`'s
placeholder values are temporary Task 6 scaffolding, removed once Plan C
de-Supabases the app.

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

## Verified against

- whity-core: pinned in `host/core.version`
- whity/plugin-sdk: ^1.9
- PHP 8.4 · PostgreSQL 15 · Node 20

## Foundation checks

- `npm run plugin:test` — PHPUnit incl. tenant-isolation conformance
- `npm run plugin:stan` — PHPStan level 6
- `npm run app:test` — Vitest over the API client
- `npm run mcp:check` — derived MCP tool surface matches `docs/mcp-tool-surface.json` (needs a running host)
- <http://localhost:5174/dev/ping> — full round trip through the dev proxy
- <http://localhost:8010/dev/ping> — same round trip through Caddy, production topology

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request, in two independent jobs:

- **plugin** — runs inside a `php:8.4-cli` container. Clones whity-core at
  the SHA pinned in `host/core.version` into `host/.core` (so the plugin's
  `../host/.core/sdk` path repository resolves and `plugin/vendor/whity/plugin-sdk`
  symlinks correctly), installs Composer by hand, runs `composer install`
  (no lockfile is committed — `plugin/composer.lock` is gitignored on
  purpose), then `phpunit` and `phpstan analyse`. This mirrors
  `npm run plugin:test` / `npm run plugin:stan` exactly, without needing
  Docker inside CI: the job itself runs in a container, not a container it launches.
- **app** — plain `ubuntu-latest`, Node 20, `npm ci` against the committed
  `app/package-lock.json`, then `npm test` (Vitest) and `npm run build`.

Both jobs run against in-memory SQLite / pure Vitest and need neither Docker,
a running host, nor a database — deliberately, so CI has no infrastructure
to keep alive. **Out of scope for this CI**, because they need a live stack:
`npm run mcp:check` (MCP tool-surface drift) and the browser round trips at
`/dev/ping` on `:5174` and `:8010`. Those remain manual/local checks until a
later plan wires up a CI-hosted stack for them.

**This workflow has not yet run on GitHub Actions.** This repo currently has
no git remote configured, so nothing has ever been pushed and no run has
ever started; what is actually verified is a local reproduction of the
plugin job's commands inside a `php:8.4-cli` container. The first real push
may surface issues that only appear on GitHub's runners — in particular,
that local reproduction copied an already-cloned `host/.core` rather than
performing the literal network `git clone` `ci.yml` does, and relies on
`actions/checkout@v4`'s documented no-git REST-API fallback for running
before `git` is apt-installed in the container, both assumed equivalent
here rather than proven.
