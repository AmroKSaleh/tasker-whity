# Self-host: what Tasker is coupled to in Supabase + why we bundle rather than rewrite

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Self-host: the Supabase coupling inventory, and the bundle-not-rewrite decision

Written 2026-07-27 while scoping TG-77 (self-host bundle). Tasker is going open source under AGPL-3.0, which makes a working self-host the demand engine rather than a nicety.

## The correction that drives everything

**Supabase is itself open source and self-hostable.** It is not a proprietary cloud API — it is a composition of open-source servers: Postgres, GoTrue (auth), PostgREST (the auto-generated REST API), the Realtime websocket server, Kong (gateway), Studio (admin UI), and a Deno edge-runtime. Apache-2.0 / PostgreSQL licensed, so bundling it inside an AGPL project is clean.

Therefore "self-hostable Tasker" does **not** require removing Supabase. That reframing is the difference between weeks and quarters.

## What is actually coupled (verified in the code, 2026-07-27)

- **The security model is the database.** The browser talks *directly* to Postgres through PostgREST; **58 RLS policies** (76 uses of `auth.uid()`, 23 references to `auth.users`) across 65 migrations are what stop user A reading user B's tasks. There is no API server in between.
- **Auth:** GoTrue — email/password, magic link, password reset, Google + GitHub OAuth. 47 `auth.getUser()` calls.
- **Realtime:** 7 `postgres_changes` subscriptions (tasks, sections, groups, projects, intake_jobs) — the live board.
- **Edge Functions:** 11 Deno functions, all on the service-role key, including the MCP server (`V2/supabase/functions/mcp/index.ts`, ~513KB) plus the Google connectors, OAuth endpoints, REST API and webhook dispatch.
- **Postgres extensions doing real work:** `pg_cron` (2 scheduled jobs — KB archive sweep, webhook dispatch drain), `pg_net` (HTTP from inside Postgres), `supabase_vault` (webhook secret), `pgcrypto` (invitation tokens).
- **8 stored procedures** called from the client (`append_milestone`, `set_milestone_checked`, `accept_org_invitation`, …).
- **No Storage usage at all** — files go to Google Drive. One less subsystem to solve.
- 55 files import the Supabase client.

## Decision: Path A — bundle self-hosted Supabase (docker compose)

Ship a compose file standing up the open-source Supabase stack next to the app; the app points at `localhost` instead of the cloud project. **Code changes near zero.** The work is packaging: migrations on first boot, edge functions served by the self-hosted edge-runtime, `.env.example` with secret generation, extension availability checks with graceful degradation of the two cron jobs, configurable OAuth redirect URLs, a clean-machine smoke test, install docs.

Accepted downsides, to be documented for self-hosters: ~8–10 containers and a couple of GB of RAM; self-hosted Supabase is fiddly and not production-hardened by default; self-hoster upgrades are awkward.

**Decisive advantage: one codebase serves both cloud and self-host.** For a solo founder that is the difference between sustainable and not.

## Path B — actually removing Supabase — rejected, and why

Postgres + our own API server + our own auth + our own realtime. The blocker is the security model: remove PostgREST and every one of the 55 client-importing files needs an API endpoint behind it, and all 58 RLS policies must be re-expressed as application code — a rewrite of the data-access layer *and* a re-derivation of authorization from scratch, with a real risk of leaking one user's board to another. Plus replacing GoTrue (and re-pointing 23 FKs off `auth.users`), replacing 7 realtime subscriptions, moving 11 edge functions onto a normal server, and replacing 2 `pg_cron` jobs with an app scheduler.

Estimate 3–6 months with no shipped product features and a live security-regression risk. **No strategic gain** — the traction curve does not care which path produced a working `docker compose up`. Revisit only if self-hosters demand it.

## The friction that actually matters is NOT Supabase

Google Drive, Gmail, Tasks and Calendar each require the self-hoster to register their **own** Google Cloud OAuth app and supply a client ID and secret; GitHub OAuth likewise. Connectors are a large part of Tasker's appeal, so a self-hoster who cannot get Drive working files an issue rather than leaving a star. A zero-connector install must be fully usable and must *signpost* what each connector unlocks rather than erroring. Tracked as TG-79 — treat it as equal in weight to the bundle itself.

Second: the MCP endpoint URL and API-key issuance must work against a local instance (TG-78). A self-hosted Tasker whose MCP does not work has lost the thing Tasker is.

