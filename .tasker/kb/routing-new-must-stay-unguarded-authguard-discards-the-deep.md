# Routing: /new must stay UNGUARDED — AuthGuard discards the deep-link prefill

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Fixed in TDE-862 / TDE-863 (2026-08-06). Two things worth keeping.

**1. `/new` is mounted without `AuthGuard`, on purpose.**

`AuthGuard` (app/src/components/layout/AuthGuard.jsx) redirects with a bare `navigate('/login', { replace: true })` — no `next` param. `NewTaskPage` runs its own session check and redirects to `/login?next=<pathname+search>`, and `LoginPage` reads `next`. So wrapping `/new` in `AuthGuard` compiles, looks correct, and silently destroys the whole point of the tasker.new deep link: a logged-out visitor loses `?title=…&detail=…&project=…&priority=…`.

Rule: any public deep-link entry point that carries state in the query string must self-guard, not use `AuthGuard`, until `AuthGuard` itself learns to preserve `next`. (Teaching `AuthGuard` to pass `next` is the real fix and would let every route deep-link correctly — not done yet.)

**2. A missing route was indistinguishable from a crash.**

`App.jsx` had 15 routes and no `<Route path="*">`. Netlify's SPA fallback (`/* /index.html 200` in app/public/_redirects) is present and correct, so a miss served the shell fine — React Router then matched nothing and mounted nothing, giving a 0-character body. That is why the `/new` regression read as a white screen rather than a 404. `NotFoundPage.jsx` now backstops it; its "Go to Tasker" link points at `/home`, which is guarded, so a signed-out visitor is carried on to login rather than the 404 leaking auth state.

Diagnostic consequence: from now on, a blank page in this app means a real render crash, not a routing miss. Check the console, not the router.

