# Tasker → whity-core Port — Design

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning
**Scope of this document:** Slice one only (board core + board-level MCP parity). Later slices are named but not designed here.

---

## 1. Goal

Fork Tasker and re-found it on [whity-core](https://github.com/AmroKSaleh/whity-core), a multi-tenant PHP/FrankenPHP platform framework, in order to gain four things Tasker cannot get incrementally on its current stack:

1. **Multi-tenancy and RBAC** — teams, roles, organizational-unit inheritance.
2. **Backend ownership** — self-hosted Postgres and FrankenPHP instead of Supabase.
3. **Server-side AI and real MCP infrastructure** — keys off the client, tools with auth, rate limiting, and audit.
4. **Engineering discipline** — migrations, PHPStan, PHPUnit, tenant-isolation conformance, OpenAPI generation, Playwright E2E, CI.

Tasker's visual design and interaction model are the asset being preserved. The backend is the thing being replaced.

**Tasker is a separate product from KeyHub.** It gets its own whity-core deployment, its own database, and its own tenants. The whity-core checkout currently living under `C:\Projects\KeyHub\` is the framework repository; `plugins/KeyHub` is merely how that one product is installed into that one checkout. Nothing in this design touches it.

---

## 2. Starting-state findings

These shaped the design and are recorded because they are not obvious from the repository:

- **The real app is `V2/`**, not the root `app/`. `V2/app` is ~142 files / ~19k lines.
- **There is no authoritative schema for the core tables.** The 65 Supabase migrations contain only `ALTER`s and the *newer* tables (flows, environments, orgs, webhooks, local mode). `create table projects | sections | groups | tasks` appears nowhere in the repository — the base schema was created directly in the Supabase dashboard. Ground truth exists only in the live database and in the code that queries it.
- **`V2/supabase/functions/mcp/index.ts` is a single 501 KB file** holding the ~180-tool MCP server.
- **57 frontend files import Supabase directly** — not only hooks, but components such as `TaskDetailSheet`, `EditTaskModal`, `NewProjectModal`, `CustomStatusField`, `GlobalSearch`, and `AgentQueuePanel`. There is no data-access seam to swap; part of this port is creating one.
- **Tasker already has an org/sharing layer**: `organizations`, `organization_members`, `organization_invitations`, `environments`, `environment_grants` (viewer/editor/admin). The real hierarchy is Organization → Environment → Project → Section → Group → Task → Milestone.
- **Milestones are not a table.** They are `task_discussions.steps` (jsonb) plus `checked_steps` (`boolean[]`), mutated by four row-locking plpgsql functions added to stop concurrent clobbering.
- **whity derives MCP tools automatically from schema-bearing routes** (`src/Mcp/Tools/ToolDeriver.php`), including plugin routes, with names kept in sync with OpenAPI and access enforced through a permission map. This makes MCP parity nearly free — but see §7 on tool naming, which is *not* automatic.
- **whity OUs use `SERIAL` integer primary keys**; Tasker uses uuid throughout.
- **whity auth supports both** httpOnly cookies (`SameSite=Lax`) and a token-body/Bearer mode intended for native clients.

### Host contract confirmed during Plan A implementation

Recorded here because §7 and §8 depend on it and earlier drafts of this document guessed wrong in places:

- **Routes are versioned.** The router is `new Router('/v1')`; `register()` injects `/v1` after `/api`. A plugin route declared `/api/tasker/pings` is served at `/api/v1/tasker/pings`. Declare without `/v1`, call with it. Only `GET /api/health`, `GET /api/version`, `GET /api/openapi.json` and `POST|GET /mcp` are unversioned.
- **Mutating requests are CSRF-guarded.** Without `X-Requested-With: XMLHttpRequest` the host returns 403 `{"error":"Cross-site request rejected"}` before the handler runs. The SPA's `client.js` must send it on every request, login included.
- **MCP is a per-tenant opt-in**, gated by a `tenantMcpEnabled` closure that raises `McpFeatureDisabledException`. Enabling it is a deployment step, not a default.
- **Permission slugs carry exactly one colon** — see §7.

---

## 3. Decisions

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Target artifact | Fork keeps Tasker's own repo; backend swaps to whity-core; Tasker ships as a whity plugin |
| D2 | Advantages sought | All four in §1 |
| D3 | First slice | Board core **plus** board-level MCP parity |
| D4 | Tenant model | Organization → whity tenant |
| D5 | Environment model | Environment → whity organizational unit (OU) |
| D6 | Existing data | Start fresh; the Supabase app keeps running in parallel, untouched |
| D7 | Live updates | Optimistic local updates + refetch on focus. No polling, no SSE |
| D8 | Origin and auth | Same-origin behind Caddy; httpOnly cookie JWT |
| D9 | AI in slice one | Stays browser-side temporarily; only its settings storage moves |
| D10 | Repo layout | New clean fork, monorepo (`app/`, `plugin/`, `host/`, `docs/`) |
| D11 | Execution approach | Schema-first, contract-driven |
| D12 | OU visibility direction | **Descendant** rule — a user in OU *X* sees projects in *X* and everything below it |
| D13 | One OU per user | Accepted. Cross-environment access is expressed by sitting higher in the tree, not by per-user grants |
| D14 | Custom statuses | Deferred. Slice one reverts to `pending / in_progress / done` |

---

## 4. Scope

### In scope (slice one)

Projects, sections, groups, tasks, milestones, per-task AI discussion persistence, auth, OU-scoped visibility, and the board-level MCP tools. Wired pages: **Login, Board (Dashboard), Today, Settings → AI keys**.

### Out of scope (later slices, in no committed order)

Flows and contracts, knowledge base, information store, custom statuses, webhooks, local mode and `.tasker/` files, GitHub sync, Google Drive/Tasks/Gmail, intake jobs, agent sessions and queue, task seeds, project drafts, task guidance, phases, server-side AI, Electron and Capacitor shells.

`FlowsPage`, `OrganizationsPage`, `GmailPanelPage`, `GoogleTasksPage`, `InvitePage`, `OAuthAuthorizePage`, and the webhooks/connectors settings sections remain in the repository but are **route-guarded off**. The running app will visibly have fewer doors than the app being forked from; this is intended, not an oversight.

---

## 5. Topology and repo layout

New clean repository (proposed `tasker-whity`). The existing `c:\Projects\tasker` is untouched and keeps serving the live app.

```text
tasker-whity/
├── app/          Vite SPA, promoted out of V2/app
├── plugin/       whity/plugin-tasker — composer package, depends on whity/plugin-sdk ONLY
│   ├── TaskerPlugin.php          PluginInterface + Frontend + Roles + Mcp
│   ├── Api/
│   ├── Migrations/
│   ├── tests/ stubs/ phpunit.xml phpstan.neon    (export-ignored, never deployed)
│   └── composer.json
├── host/         Tasker's own whity-core deployment
│   ├── docker-compose.yml        frankenphp + postgres; own project name, volumes, ports
│   ├── Caddyfile                 /  → app/dist        /api → FrankenPHP
│   ├── core.version              pinned whity-core ref
│   ├── .env.example
│   └── scripts/                  fetch-core · install-plugin · migrate · seed
└── docs/         specs and ADRs
```

**Isolation from KeyHub is physical:** separate compose project name, separate Postgres volume, separate ports (`8010` API, `5433` Postgres), separate tenants.

**Core acquisition.** whity-core is cloned at a pinned ref into `host/.core/`, which is gitignored and never committed. The plugin is deploy-copied into `host/.core/plugins/Tasker/` by `install-plugin`, honouring whity's rule that real plugins are never committed to core. The plugin declares `getSdkConstraint()` and `getCoreConstraint()`, so the host refuses to load it against a contract it was not built for. A pinned clone is preferred over a git submodule because whity's model treats the host as a deployment target you copy *into*, not a library you vendor; core upgrades stay an explicit, reviewable version bump.

**Same-origin in development as well as production.** Vite's dev proxy forwards `/api` to `:8010`, so the `SameSite=Lax` cookie behaves identically in both environments. There is no CORS configuration and no auth-mode divergence between dev and prod. Production is `vite build` with Caddy serving `dist` at `/`.

---

## 6. Data model and tenancy

### Rules

Every plugin table carries `tenant_id INTEGER NOT NULL REFERENCES tenants(id)`. Every query binds an explicit `tenant_id` predicate from `TenantContext` — never an implicit filter. Each table is covered by the SDK's `TenantIsolationConformanceTestCase`.

### Identifiers

Mixed, deliberately. Tasker entities keep **uuid** primary keys, because the SPA, the MCP tools, `.tasker/` local-mode files, and short-id allocation all assume uuid; converting to serial would ripple everywhere for no benefit. Foreign keys into whity — `tenant_id`, `ou_id`, `created_by` — are **integers**, matching core. Tables are prefixed `tasker_`, matching the `keyhub_config` precedent.

### Tables (slice one)

| Table | Notes |
| --- | --- |
| `tasker_projects` | `ou_id` nullable (null = tenant-root, visible tenant-wide), frozen `slug`, `short_id`, `context` jsonb, `created_by` |
| `tasker_sections` | stored frozen `slug` from day one |
| `tasker_groups` | stored frozen `slug` from day one |
| `tasker_tasks` | `status` (free text), `priority`, `due_date`, `tags text[]`, `sort_order`, `pinned`, `completed_at`, `short_id`, `created_by` |
| `tasker_milestones` | **new real table** — retires `steps` jsonb, `checked_steps boolean[]`, and the four row-locking plpgsql functions |
| `tasker_task_discussions` | AI chat messages and focus reason only, now that milestones are extracted |
| `tasker_user_ai_settings` | provider, model, api_key — temporary home for browser-side AI keys; see §11 |

`status` stays free text so the deferred custom-status tables are purely additive.

### Environments as OUs

Environments become whity organizational units. Core already ships the `organizational_units` table, CRUD endpoints, and an admin UI, so `create_environment` / `list_environments` become thin aliases over existing core routes rather than new tables. `plugins/KeyHub` already seeds departments as OUs, establishing the pattern.

### Visibility

whity's OU inheritance walks *upward*: a user belongs to one OU and inherits roles from that OU and its ancestors. That is permission inheritance, not resource visibility, so the plugin defines its own resource rule:

> **A user in OU *X* can see projects whose `ou_id` is *X* or any descendant of *X*, plus all projects with `ou_id IS NULL`.**

A plugin-side scope resolver computes the descendant set for the caller's OU; every list query gains `(ou_id IS NULL OR ou_id = ANY(:scope))` alongside the tenant predicate. Subtree traversal has precedent in core's `DelegatedPermissionResolver`. The ancestor rule was rejected: it would mean seeing your parent department's boards, which reads wrong for task management.

Consequence of one-OU-per-user (D13): a person who today holds grants on three environments must instead sit above them in the tree. This trades ad-hoc sharing for structural clarity, and is accepted.

`created_by` is **attribution only**. It records who made a row and never participates in an access decision; visibility is determined solely by `tenant_id` and the OU rule above. This is the deliberate replacement for today's `user_id`-as-owner model.

### Ordering and short ids

`sort_order` stays an integer with a transactional server-side renumber. `short_id` keeps per-project atomic allocation via a counter row read with `SELECT … FOR UPDATE`, mirroring current behaviour.

---

## 7. API and MCP contract

### Routes

All routes are schema-bearing so that OpenAPI and MCP tools derive from one source.

#### Read

- `GET /api/v1/tasker/projects` — OU-scoped list
- `GET /api/v1/tasker/projects/{id}/board` — sections + groups + tasks + milestone progress in **one** response
- `GET /api/v1/tasker/tasks?due_before=…` — cross-project, for Today
- `GET /api/v1/tasker/ready-work`

#### Write

- projects: `POST`, `PATCH`, `DELETE`
- sections, groups: `POST`, `PATCH`, `DELETE`, reorder
- tasks: `POST`, `PATCH`, `DELETE`, `move` (section/group + position), `complete`, `uncomplete`, `pin`
- milestones: `POST`, `PATCH`, `DELETE`, toggle
- discussions: `GET`, `PUT` per task

The board endpoint replaces four-to-five Supabase round trips and eliminates the N+1 that `useProjectMilestones` currently batches around.

### Permissions

Registered by the plugin and attached to roles by a grant migration:

`tasker_project:view`, `tasker_project:manage`, `tasker_task:view`, `tasker_task:edit`, `tasker_task:complete`, `tasker_task:delete`, `tasker_structure:manage`, `tasker_milestone:edit`.

**Slugs carry exactly one colon.** The host validates every permission against `PluginLoader::PERMISSION_PATTERN`, which is `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/` — so the three-segment form this document originally used (`tasker:project:view`) is rejected. The resource half therefore uses an underscore: `tasker_project`, not `tasker:project`. Discovered during Plan A implementation, where the invalid form was the cause of a real failure.

**The failure mode is silent.** An invalid slug does not raise an error — the loader fails closed and drops the route with only a logged warning, so the endpoint simply does not exist. Any permission rename must be applied consistently across route `requiredPermission` values, `getPermissions()`, and the grant migration's `up()` and `down()`, or routes disappear without an obvious cause.

Declaring `requiredPermission` on a route yields enforcement in `RbacMiddleware` **and** in the MCP access map simultaneously.

### MCP tool naming

`ToolDeriver` names tools from `operationId`. Left to derive, agents would receive names like `getApiV1TaskerProjectsIdBoard`. Therefore **every route declares an explicit `operationId`** preserving the names agents already know: `list_tasks`, `create_task`, `update_task`, `complete_task`, `move_task`, `delete_task`, `list_sections`, `create_section`, `create_group`, `add_milestone`, `complete_milestone`, `get_ready_work`, and so on.

A **tool-surface snapshot test** locks tool names, input schemas, and required permissions, so a later route refactor cannot silently rename a tool underneath a running agent.

---

## 8. Frontend seam

### New layer

`app/src/api/`:

- `client.js` — fetch wrapper: same-origin, `credentials: 'include'`, error-envelope decoding to typed errors, 401 → refresh once → retry → otherwise redirect to login.
- One module per resource: `projects.js`, `board.js`, `tasks.js`, `milestones.js`, `discussions.js`.

### Swap strategy

`useTasks`, `useProjects`, `useAllTasks` keep their **exact public shape**; only their internals change. The component tree therefore never learns the backend changed, which is what keeps the UI visually identical.

The inline Supabase queries in `TaskDetailSheet`, `EditTaskModal`, `NewProjectModal`, `AddTaskModal`, `DaySummaryModal`, `GlobalSearch`, `CustomStatusField` and the other slice-one components are **lifted into those hooks or into `api/`**. That lift is the structural cleanup, and it is what makes later slices cheap.

`useProjectMilestones` largely disappears, since the board endpoint returns progress inline.

### Other frontend changes

- The Supabase Realtime subscription is deleted and replaced by `useRefetchOnFocus` (`visibilitychange`, window `focus`, and project switch).
- Zustand stores keep their shape; mutations gain rollback (§9).
- `LoginPage` posts to `/api/v1/auth/login`; `AuthGuard` calls `/api/v1/me`; tenant selection appears when a user belongs to more than one tenant.
- `lib/gemini.js` is not touched. `lib/aiSettings.js` repoints from Supabase `user_settings` to `tasker_user_ai_settings`.

---

## 9. Error handling

**Optimistic rollback is a deliberate behaviour change.** Today, mutations are fire-and-forget: the store updates, the Supabase call goes out, and failures are silently lost. Across a network boundary, with other people editing the same board, that is not acceptable. Every mutation now snapshots the affected entity, applies optimistically, and restores the snapshot with a toast on failure.

| Condition | Behaviour |
| --- | --- |
| 400 validation | Inline field errors |
| 401 | Refresh once, retry, otherwise redirect to login |
| 403 | Permission-denied surface; rare, because nav is permission-filtered from `/me/capabilities` |
| 404 | Treated as stale local state — refetch |
| 409 on reorder | Refetch and retry once |
| 5xx / network | Toast plus rollback |
| `/api/health` 503 | Single degraded banner, not a cascade of toasts |

Server-side, driver and SQL errors are never leaked to clients. whity's plugin error boundary and lifecycle state machine mean a faulty Tasker deploy degrades to `plugin disabled` rather than taking the platform down.

---

## 10. Testing and CI

- **Tenant-isolation conformance** on all seven tables via the SDK's `TenantIsolationConformanceTestCase`. Cross-tenant rejection is proven per table, not assumed.
- **OU descendant-scoping tests** — a user in a child OU must not see a project in a sibling OU; must see one in a descendant OU; must see `ou_id IS NULL` projects.
- **Contract tests** — OpenAPI drift, plus the MCP tool-surface snapshot (names, input schemas, required permissions).
- **PHPUnit** unit and integration for handlers and the scope resolver; **PHPStan** clean.
- **Vitest** over `app/src/api/` and the swapped hooks. The SPA has no tests today; this establishes the baseline. Happy paths only.
- **Playwright E2E** against the real stack: login → board loads → create task → drag across sections → complete → milestone toggle.
- **CI** — PHPUnit, PHPStan, and Vitest on every pull request; Playwright on merge.

---

## 11. Known debt introduced by slice one

| Item | Why | Removal trigger |
| --- | --- | --- |
| `tasker_user_ai_settings` stores provider API keys retrievable by the client | D9 keeps AI browser-side so slice one stays board-sized | Deleted when the server-side AI slice lands and keys stop leaving the server |
| Custom statuses absent | D14 | The custom-status slice; `status` is free text so the change is additive |
| No cross-client freshness | D7 | Revisited once real multi-user usage shows it matters |
| Dead pages present but route-guarded | Their slices are not built yet | Each page's own slice |
| Pre-existing vulnerabilities inherited with the SPA copy | The fork copies the app verbatim; fixing them is not slice one's job | Plan C, when each page is de-Supabased and rewired |

**Inherited security findings.** A background scan of the SPA copy flagged issues in files that came across byte-identical from the original app — an authorization-bypass and a UI-spoofing risk in `OAuthAuthorizePage.jsx`, and credentials at rest in `SettingsPage.jsx`. They are inherited, not introduced. The `SettingsPage` finding is the same debt already recorded above for `tasker_user_ai_settings`: keys the client can retrieve, which the server-side AI slice removes. `OAuthAuthorizePage` is one of the route-guarded pages and is unreachable in slice one. Plan C must treat these as fix-on-touch rather than carrying them forward silently.

---

## 12. Sequencing

Dependency order, not a schedule.

1. **Scaffold and host.** Repo skeleton, pinned core fetch, empty plugin loading, health green. Ends by driving one trivial entity end to end — migration → route → derived MCP tool → SPA fetch → cookie auth — so the scaffold proves itself before real schema work begins.
2. **Schema recovery.** Introspect the live Supabase database, produce authoritative DDL for the board subset, review it, then author whity migrations. Everything downstream depends on this being correct.
3. **Plugin foundation.** Migrations, permission registration and grant migration, OU scope resolver, tenant-isolation conformance tests.
4. **Contract.** Routes with explicit operationIds and schemas → OpenAPI → derived MCP tools → snapshot test.
5. **Frontend seam.** `app/src/api/`, auth wiring, hook swap, component Supabase lift.
6. **Board behaviour.** Board endpoint consumption, refetch on focus, optimistic rollback.
7. **Hardening.** E2E, CI, documentation.

---

## 13. Definition of done — slice one

1. A clean clone runs `make dev` and brings up host, plugin, and SPA, migrated and seeded.
2. A user can log in, create a project in an OU, build sections, groups, tasks, and milestones, drag tasks across sections, complete them, and use focus mode — entirely against whity, with no Supabase import remaining in any wired code path.
3. An MCP client connects to Tasker's whity host and drives that same board using the familiar tool names.
4. Tenant-isolation conformance passes on all seven tables, and OU descendant scoping is proven by test.
5. The old Supabase app is still running and untouched.
