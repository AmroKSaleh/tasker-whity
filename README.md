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

Host API: <http://localhost:8010/api> · Health: <http://localhost:8010/api/health>

Seeded dev accounts come from `host/.env` (`INITIAL_ADMIN_PASSWORD`).

## Upgrading core

Edit `host/core.version`, then `npm run core:fetch && npm run host:up`.
