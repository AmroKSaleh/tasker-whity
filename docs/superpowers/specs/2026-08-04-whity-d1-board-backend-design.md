# D1 — Board Backend Design

**Date:** 2026-08-04
**Status:** Approved design, ready for implementation planning
**Predecessors:** [2026-08-02-whity-core-port-design.md](2026-08-02-whity-core-port-design.md) (Plan A, complete), [2026-08-03-whity-full-parity-roadmap-design.md](2026-08-03-whity-full-parity-roadmap-design.md) (roadmap, §5 revised below P1)

---

## 1. Goal

Build Tasker's real board backend on whity-core: projects, sections, groups, tasks, milestones, and per-task AI-discussion storage, tenant-isolated and OU-scoped, with agent-facing MCP tools deriving automatically from the same route declarations. This is the first Tasker *domain* built on Plan A's proven foundation and P1's identity layer.

D1 also absorbs the roadmap's former P2 (Cross-cutting) as its opening work: proving `entity_tags` and `audit_log` — whity's tagging and audit infrastructure — against Plan A's existing `tasker_pings` entity, before the real board tables exist to get that integration wrong on.

**Out of scope, explicitly:** the SPA still reads Supabase after D1 ships. Swapping the frontend is D2. Data migration from the live app is D3, via the existing `export_project`/`import_project` feature — whity-core is never integrated with or read from directly; there is no customer base requiring continuity, so this is a deliberate, later, manual step, not a dependency of D1.

---

## 2. How this diverges from the original roadmap, and why

Three findings surfaced while scoping this that change what was originally planned. Each is recorded here because the documents that predate them (the roadmap, Plan A's own spec) said something different and have already been corrected in place — this section is the connective explanation, not new information.

**P2 folded into D1; P3 and P4 are not D1 prerequisites.** The roadmap originally scheduled P2 (Cross-cutting), P3 (Agent platform), and P4 (AI platform) all before any domain work. Checked against what D1 actually needs: `entity_tags.entity_type` is an opaque, unvalidated string requiring no core changes, and `audit_log` has a single sanctioned writer (`Whity\Core\Audit\AuditLogger::record()`) called directly from a handler — both are consumable with near-zero plugin-side work, so a standalone P2 cycle for two integration calls was disproportionate ceremony. `jobs`, theme/branding, and notifications/storage are not consumed by D1 at all, and `jobs` currently has no plugin-registration seam in the SDK. P3 (AI principals, MCP tokens, rate limits) is not an MCP prerequisite — `AiPrincipal` appears nowhere in the MCP transport, and Plan A already proved tool derivation works with a plainly-minted bearer token. P4 was already scoped to D2, unchanged.

**There is no live-database dependency, ever.** Plan A's original sequencing said to "introspect the live Supabase database" to recover the schema. That instruction predates the decision that data migration happens later, manually, via the app's own export/import feature — whity-core will never connect to or read from Supabase. The schema below was recovered entirely from the frontend's data-access code, the MCP tool implementations, and the migrations' `ALTER`s, all of which already exist in this repository.

**The real schema is far larger than "seven simple tables."** The original slice-one spec imagined a plain kanban board. Code-based recovery (§3) found `tasks` alone carries workflow I/O contracts, seeds, review/quality-gate state, agent-execution fields, local-mode sync revisions, and intake provenance — Tasker has grown into a lightweight agent-orchestration system wearing a kanban skin. D1 deliberately does not port all of it (§4).

---

## 3. Schema recovery method

No `CREATE TABLE` for `projects`, `sections`, `groups`, `tasks`, or `task_discussions` exists anywhere in the original repository — the base schema was created directly in the Supabase dashboard, and the 65 migrations are `ALTER`s on top of it. Ground truth was recovered by reading:

- `V2/app/src/hooks/*.js` and `V2/app/src/lib/*.js` — what the running frontend actually reads and writes
- `V2/supabase/functions/mcp/index.ts` — every board-related MCP tool's declared input schema
- `V2/supabase/migrations/*.sql` — every `ALTER` naming a board-relevant column
- `V2/app/src/lib/projectTransfer.js` — the exact `export_project`/`import_project` contract, load-bearing for D3

Several fields are evidenced by usage only, with no creating migration (marked below). One field (`tasks.skip_count`) is read in three places with no writer found anywhere in the files checked — deliberately dropped rather than guessed at; if Focus-mode ranking needs skip-decay, it returns with a real, understood trigger in D2.

---

## 4. The five tables

Dual-key pattern throughout, per the roadmap (§4.1): `id BIGSERIAL PRIMARY KEY` internal, `public_id UUID NOT NULL UNIQUE` external — the identifier the API, MCP tools, and future `.tasker/` files use. Every table carries `tenant_id INTEGER NOT NULL`, bound explicitly in every query, per the SDK's conformance kit.

### `tasker_projects`

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id` | dual key | |
| `tenant_id` | integer | |
| `ou_id` | integer, nullable | the environment mapping; null = tenant-root |
| `name` | text | |
| `slug` | text | frozen |
| `context` | jsonb, default `{}` | kept as a flexible blob — the recovered schema found two possibly-conflicting field names inside it (`done_looks_like` vs `definition_of_done`); not worth freezing into schema now |
| `prefix` | varchar(5), nullable | short-id namespace, app-validated `^[A-Z]{2,5}$` |
| `sort_order` | int | |
| `created_by` | integer | attribution only, never an access decision (§6) |
| `created_at` | timestamptz | |

**Dropped:** `description` — written on every project, zero read sites found anywhere in the app. Porting a write-only column forward would carry debt for no reason.

### `tasker_sections`

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id`, `tenant_id` | | |
| `project_id` | bigint FK | |
| `name` | text | |
| `slug` | text | frozen from day one — Plan A's own note not to repeat that retrofit |
| `description` | text, nullable | kept — real read site, the inline-editable subtitle in `ColumnHeader.jsx` |
| `sort_order` | int | |
| `view_prefs` | jsonb, nullable | `{sort, dir, status}` — cheap, genuinely current board functionality |
| `created_at` | timestamptz | |

### `tasker_groups`

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id`, `tenant_id` | | |
| `section_id` | bigint FK | |
| `name` | text | |
| `slug` | text | frozen |
| `sort_order` | int | |
| `created_at` | timestamptz | |

**Deliberate cleanup:** the original schema denormalizes `project_id` onto groups alongside `section_id` ("every insert path sets both"). Dropped — `project_id` derives via the `section_id` join. One extra join; removes a column pair that can silently drift out of sync.

### `tasker_tasks`

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id`, `tenant_id` | | |
| `project_id` | bigint FK | |
| `section_id` | bigint FK, **NOT NULL** | see below |
| `group_id` | bigint FK, nullable | |
| `text` | text | title |
| `detail` | text, nullable | |
| `status` | text, no CHECK constraint | free text deliberately — mirrors the original slice-one D14 reasoning: deferred custom statuses stay purely additive |
| `priority` | text, **CHECK constrained** to `rush\|high\|medium\|low\|NULL` | unlike `status`, this value set isn't on a roadmap to grow — constraining it now is safety, not premature narrowing |
| `due_date` | date, nullable | |
| `pinned` | boolean, default false | |
| `pinned_at` | timestamptz, nullable | |
| `sort_order` | int | |
| `completed_at` | timestamptz, nullable | |
| `short_id` | int, nullable | per-project atomic counter, `SELECT … FOR UPDATE`, Plan A's established pattern |
| `created_by` | integer | attribution only |
| `created_at`, `updated_at` | timestamptz | `updated_at` trigger-maintained, matching current behavior |

**Schema-level fix:** `section_id` is nullable in the original schema specifically because of an app-level workaround — the current code's own comment states a null section breaks board rendering. Made `NOT NULL` here. To resolve precisely rather than leave to a plan's guess: a default **"Backlog"** section is created automatically as part of every project's creation, in the same transaction — not lazily on first orphaned task. Every project therefore always has at least one section from the moment it exists, and no task creation path ever needs to handle a missing default.

**Tags are not a column.** `POST /api/entity-tags {entity_type: 'tasker_task', ...}` replaces `tags text[]` entirely — this is the entire point of folding the former P2 into D1 (§6).

**Dropped outright:** `pin_snoozed` (always written `false`, zero read sites anywhere) and `skip_count` (§3).

**Deferred to the slice that actually adds it**, via an ordinary `ALTER TABLE ADD COLUMN` when that slice lands — not a structural rework, since these are all new nullable columns, unlike the `tags` case:

| Field(s) | Owning slice |
|---|---|
| `flow_id`, `flow_step`, `input`, `output` | D5 (Flows & gates) |
| `kind`, `seed_target`, `spawned_from_seed_id`, `duplicate_of`, `intake_source`, `intake_job_id`, `executor`, `human_guidance`, `relay_context`, `agent_ready`, `agent_ready_at`, `agent_proposal`, `agent_proposal_at`, `agent_proposal_confirmed` | D7 (Intake & agent ops) |
| `review_enabled`, `review_bar`, `review_verdict` | D5 or D6 |
| `custom_status_id` | deferred entirely, per this design's own decision (§5) |
| `local_rev` | D4 (Local mode) |
| `github_issue_number` | D9 (Integrations) |

### `tasker_milestones` (new real table)

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id`, `tenant_id` | | |
| `task_id` | bigint FK | |
| `summary` | text | |
| `detail` | text, nullable | |
| `checked` | boolean, default false | |
| `sort_order` | int | |
| `created_at` | timestamptz | |

Retires `task_discussions.steps` (jsonb array) + `checked_steps` (parallel boolean array) + the four row-locking plpgsql functions that exist solely to stop concurrent writes from clobbering each other. `kind` (`question`|`prerequisite`, used for seed checklists) is excluded — seed territory, deferred to D7 with seeds themselves.

### `tasker_task_discussions`

| Column | Type | Notes |
|---|---|---|
| `id`, `public_id`, `tenant_id` | | |
| `task_id` | bigint FK, unique | 1:1 |
| `messages` | jsonb, default `[]` | |
| `reason` | text, nullable | |
| `created_at`, `updated_at` | timestamptz | |

AI chat and focus reason only, now that milestones are extracted. D1 lays down the data model only — nothing populates this table until D2 wires the AI chat UI to it.

---

## 5. Custom statuses — deferred

The recovered schema shows both `tasks.custom_status_id` (single FK) and a `task_statuses` many-to-many junction table coexisting live, with the single-column form described in the app's own code as conceptually superseded. Rather than port that duplication forward, **both forms are deferred entirely** — D1 ships with plain `pending`/`in_progress`/`done` only, matching the original slice-one D14 decision. Custom statuses become their own later slice, designed once rather than inherited as-is.

---

## 6. Cross-cutting integration (the former P2)

### Entity tags

`entity_tags.entity_type` is opaque and unvalidated at the core level — no core changes needed. D1's first task attaches a tag to the *existing* `tasker_pings` row from Plan A via `POST /api/entity-tags {entity_type: 'tasker_ping', entity_id, tag_id}`, proving two things before real tables depend on them: the naming convention (`tasker_<entity>`, matching the plugin's existing `tasker_` table prefix) and that a plugin-owned `BIGSERIAL` id satisfies `entity_tags.entity_id BIGINT` with no friction. Once proven, task/project tagging in D1's later work is calling the same endpoint with `entity_type: 'tasker_task'` — no new plugin code, because tagging is whity's feature now, not Tasker's.

### Audit log

`Whity\Core\Audit\AuditLogger` is the single sanctioned writer for `audit_log`, but it is **not automatic** for plugin actions — it only self-subscribes to core's own `role.*`/`user.*`/`tenant.*`/`ou.*` hooks. For Tasker's mutations to appear in the audit trail, handlers call `AuditLogger::record()` directly, the same way they already resolve `Database` from the container. D1's first task proves this against a ping mutation, establishing the action-key convention before real handlers multiply it: **`tasker_<entity>.<verb>`**, dot-separated after the `tasker_` prefix — e.g. `tasker_task.created`, `tasker_task.completed` — mirroring core's own `role.created` shape but namespaced so Tasker's actions never collide with core's or another plugin's in the shared table.

---

## 7. The OU descendant scope resolver

### Visibility rule

A user in OU *X* sees projects whose `ou_id` is *X* or any descendant of *X*, plus every project with `ou_id IS NULL` (tenant-root, visible to all). This is the **descendant** direction — opposite to `RoleChecker`'s own ancestor-walk for permission inheritance, so there is no existing whity function to reuse; the traversal is new plugin code.

### Null-OU semantics

`memberships.ou_id` is nullable (confirmed: no `NOT NULL` constraint, `ON DELETE SET NULL`). whity's own seeder gives its bootstrap admin and user accounts an explicit, hardcoded `ou_id = NULL` — not a placeholder, a literal `NULL` in the seed INSERT. **A null OU therefore means tenant-root: sees every project in the tenant regardless of `ou_id`.** The alternative (null OU sees only `ou_id IS NULL` projects) would leave whity's own bootstrap admin unable to see anything once real OUs and projects exist under it — fighting the platform's own intended semantics rather than following them. Still tenant-scoped; never crosses tenants.

### Query shape

The traversal is a recursive CTE walking **down** via `parent_id`, with a depth counter and a hard bound — whity's own docs note a node can be made its own parent, and the API layer is documented as responsible for guarding it; this mirrors the bound discipline `RoleChecker`'s own ancestor walk already holds itself to.

Every consuming query uses **one static SQL template**, never a runtime-branched one — this is the concrete answer to the risk Plan A's final review flagged (the SDK's tenant-predicate scanner watches for conditionally-assembled `WHERE` fragments, since that shape is exactly how a tenant check goes missing by accident):

```sql
WHERE tenant_id = :tenant_id
  AND (:unrestricted = TRUE OR ou_id IS NULL OR ou_id = ANY(:scope))
```

`tenant_id = :tenant_id` is unconditional text, present in every call. Only parameter *values* differ: a null-OU caller binds `:unrestricted = true` (with `:scope` ignored by short-circuit); an OU'd caller binds `:unrestricted = false` and `:scope` = their computed subtree (including their own OU).

### Where it lives

`plugin/Access/OuScopeResolver.php` — a real class in a directory the SDK's tenant-predicate scanner covers automatically (confirmed: the scanner discovers new plugin-root subdirectories with no test-file edit needed, per P1's final-review fix). Not inlined into `TaskerPlugin.php`, closing the carried-forward item from Plan A's final review about the tenant seam sitting in an unscanned loose file.

Every list query and every single-resource lookup in D1 applies it. A resource outside the caller's scope reports **404**, matching the cross-tenant-id-probing discipline Plan A's ping handler already established (never a 403 that would leak existence).

---

## 8. Routes, permissions, MCP naming

### Permissions

Carried forward from the original slice-one design (already in the corrected one-colon form): `tasker_project:view`, `tasker_project:manage`, `tasker_task:view`, `tasker_task:edit`, `tasker_task:complete`, `tasker_task:delete`, `tasker_structure:manage` (sections/groups), `tasker_milestone:edit`.

### Routes

The board endpoint is the headline decision, unchanged from the original design: `GET /api/tasker/projects/{id}/board` returns sections, groups, tasks, and milestone progress in one call — replacing four-to-five separate round trips the current Supabase app makes. Every list route and every single-resource route runs through the OU scope resolver (§7). Standard CRUD for projects/sections/groups/tasks/milestones, plus `move`/`reorder`, `complete`/`uncomplete`/`pin` for tasks, and `GET`/`PUT` for the per-task discussion.

Per the verified host contract (established in P1): routes are **declared** without `/v1` and **served** at `/api/v1/…`; mutating routes require `X-Requested-With: XMLHttpRequest`.

### MCP naming

Every route declares an explicit `operationId` preserving the names agents already know: `list_tasks`, `create_task`, `update_task`, `complete_task`, `move_task`, `delete_task`, `list_sections`, `create_section`, `create_group`, `add_milestone`, `complete_milestone`, `list_projects`, `create_project`, `get_ready_work`. This is a **deliberate subset** of the eventual ~180-tool surface — tools touching flow/seed/review/agent-workflow fields have no D1 equivalent, since those fields don't exist until their owning slice lands. The tool-surface snapshot test (Plan A) extends to cover this set.

---

## 9. Testing

- **Tenant-isolation conformance** on all five new tables, via the SDK's kit — extends automatically, no test-file edit required (confirmed fixed in P1's final review).
- **OU descendant-scope tests — four cases, not the usual two**, because of the null-OU decision:
  1. A user in a *parent* OU sees a project in a *child* OU (visibility flows down).
  2. A user in a *child* OU does **not** see a project in the *parent* OU (never flows up).
  3. A user in one branch does not see a *sibling* branch's project.
  4. A **null-OU** user sees every project in the tenant regardless of `ou_id`.
- The recursive CTE's depth bound gets its own test, matching `RoleChecker`'s own tested discipline.
- **Board endpoint** — proves sections/groups/tasks/milestones compose correctly for a visible project, and 404s for one outside scope.
- **MCP tool-surface snapshot**, extended to the full D1 tool list.
- **Entity-tags/audit-log proof** — the ping-tagging and ping-mutation-audit tests from §6, run before the real table tests, matching Plan A's own "trivial entity proves the pattern first" sequencing.

---

## 10. Definition of done

1. Real board CRUD works end-to-end against whity-core with no Supabase involvement in any wired backend path.
2. All four OU-visibility cases and the depth bound are proven by test, not asserted.
3. `entity_tags` and `audit_log` are genuinely exercised by real mutations — not merely present in the schema.
4. Every standing Plan A / P1 invariant still holds: tenant-isolation conformance, the MCP tool-surface snapshot, `host/.core/` untouched, permission slugs single-colon, CI green.

**Not delivered by D1:** a working SPA (D2), data migration (D3), local mode (D4), flows, custom statuses, review gates, agent-workflow fields, or any of the tables/columns explicitly deferred above.
