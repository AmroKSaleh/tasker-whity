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
npm run host:up        # fetch pinned core, start Postgres + FrankenPHP
npm run host:migrate
npm run host:seed
npm run plugin:install # deploy-copy plugin into the host, then migrate
npm run dev            # Vite on :5174, proxying /api to :8010
```

Host API: <http://localhost:8010/api> · Health: <http://localhost:8010/api/health>

Seeded dev accounts come from `host/.env` (`INITIAL_ADMIN_PASSWORD`).

## Upgrading core

Edit `host/core.version`, then `npm run core:fetch && npm run host:up`.
