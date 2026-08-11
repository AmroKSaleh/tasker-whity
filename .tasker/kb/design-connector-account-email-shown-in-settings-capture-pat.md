# {design} Connector account email shown in Settings — capture paths + reconsent caveat (TDE-311)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-311: Settings → Connectors now shows the connected account.** Three different capture paths because the connectors authenticate three different ways:

1. **GitHub** — fetched LIVE from the stored PAT via `GET /user` (`fetchGitHubAccount` in lib/github.js), exposed as `account` from useGitHub, shown as `@login`. No storage, no reconsent — works for existing connections immediately.

2. **Google shared grant (Drive/Gmail/Tasks)** — auth-code flow. Added `openid email` to the scope in **google-connect** (NOT echoed into the signed state, so per-service connection tracking is unaffected). **google-callback** decodes the `id_token` JWT's email claim → stores `user_settings.google_email`. loadGoogleConnection returns it.

3. **Google Calendar** — SEPARATE client-side GIS token flow (lib/googleCalendar.js), not the auth-code flow. Added `openid email` to its SCOPE, then after getting the access token it calls the **userinfo** endpoint (`oauth2/v3/userinfo`) and stores `user_settings.gcal_email`.

## Reconsent caveat
Google email/Calendar email backfill ONLY on the next reconnect — existing tokens predate the identity scope, so google_email/gcal_email start null. GitHub shows immediately (live fetch). This was the accepted tradeoff (user chose the full version).

## Deploy gotcha
google-connect deploys WITH JWT verification (default — no --no-verify-jwt); google-callback deploys WITH --no-verify-jwt (Google's redirect carries no Supabase JWT). Deploy them separately so the flag doesn't cross-contaminate. Migration: 20260625150000_add_connector_emails.sql (google_email, gcal_email on user_settings).
