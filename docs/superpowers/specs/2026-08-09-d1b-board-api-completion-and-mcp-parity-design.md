# D1b — Board API completion and MCP contract parity

**Date:** 2026-08-09
**Status:** Approved design, ready for implementation planning
**Predecessors:** [2026-08-04-whity-d1-board-backend-design.md](2026-08-04-whity-d1-board-backend-design.md) (D1, complete), [2026-08-09-d1-carryover-and-open-questions.md](2026-08-09-d1-carryover-and-open-questions.md) (carry-over), [2026-08-03-whity-full-parity-roadmap-design.md](2026-08-03-whity-full-parity-roadmap-design.md) (roadmap §6, the tool-surface continuity contract)

---

## 1. Goal

Make the board API complete and its MCP surface genuinely usable by the agents that use Tasker today. Two halves:

- **Complete the board surface** — the reads and verbs D1 left out, prioritization queries, environment→OU aliases, and the carry-over items D1 deferred.
- **Contract parity** — every tool invocable with the argument names, identifier forms, and optionality the original app's agents already send.

After this slice, an existing agent workflow that calls `create_task {project_id: "TDE", section_id: "<uuid>", text: "…"}` or `complete_task {task_id: "TDE-31"}` works unchanged against whity-core.

---

## 2. Why this slice exists

D1's acceptance criteria were met literally — 34 tools derive, the drift check provably bites — while the roadmap's actual goal was not. Roadmap §6 makes preserving each tool's **name and argument shape** a binding constraint on every slice ("agent workflows survive a total backend replacement"). Measured against the original's real contracts, D1 diverges in three ways, in increasing order of severity:

**Missing request schemas.** Only **2 of the 34 tools** — `create_ping` and `tag_ping`, both Plan A scaffolding — declare a `request` block. The other 32 expose path parameters and nothing else. `create_task` exposes `sectionId` alone, so an agent cannot pass the task's text. `create_project` exposes no properties whatsoever.

**Renamed tools.** D1 shipped `update_section`/`update_group`; the original has `rename_section`/`rename_group`.

**Incompatible identifier and argument shape — the real problem.** The original does not take integer ids in path hierarchies. It takes flat body arguments carrying flexible strings, verified against `V2/supabase/functions/mcp/index.ts`:

| Tool | Original contract |
|---|---|
| `complete_task` | `{task_id}` — "Task UUID **or short ID** (e.g. TDE-31)" |
| `get_project` | `{project_id}` — "Project **prefix** (e.g. TDE), **slug**, or UUID" |
| `list_tasks` | `{project_id?, section_id?, status?}` — project_id optional, "falls back to **default project** if set" |
| `create_task` | `{project_id, section_id?, text, detail?, …}` — all flat, section optional |
| `uncomplete_milestone` | `{task_id, index}` — **positional**, because milestones were a jsonb array |

D1 exposes `POST /api/tasker/sections/{sectionId}/tasks` with integer ids. That is not a missing schema; it is a different shape. No amount of schema declaration reconciles it.

`short_id` compounds this. The original treats `TDE-31` as a primary way to name a task. D1 created the column, exposes it as `shortId` in every response, and never writes it — so it is always null. It is not decorative; it is part of the agent contract.

### The binding technical constraint

`ToolDeriver::buildInputSchema()` (verified by reading it and confirmed against the live snapshot) merges three sources into one flat schema:

1. **Path parameters — unconditionally required.** The code comment says so and the loop appends every path parameter to `required` with no condition.
2. **Query parameters** (`schema['parameters']`, `in: 'query'`) — required only if the declaration says so.
3. **Request body** (`schema['request']`, a component name or inline schema) — merged flat, with the component's own `required` list respected.

Confirmed empirically against the committed snapshot:

```text
create_task    props=['sectionId']       required=['sectionId']    <- no body schema at all
list_tasks     props=['sectionId']       required=['sectionId']
create_project props=[]                  required=[]               <- takes nothing
tag_ping       props=['id','tag_id']     required=['id','tag_id']  <- body merges flat beside path
```

So an identifier can only be optional if it lives in a query parameter or a request body — never in a path segment. Matching the original's optionality therefore **requires** moving identifiers out of the path. This is why the slice reshapes routes rather than only adding schemas.

Doing it now is deliberate: D2 has not rewired the SPA, so D1's REST paths have **zero consumers**. The roadmap's own opening principle is that adoption is cheap before and expensive after. Every later day makes this more expensive.

---

## 3. The identifier resolver

A new class, `plugin/Access/IdentifierResolver.php`, resolves caller-supplied identifiers to internal integer ids before any handler logic runs.

### Accepted forms and precedence

Precedence is fixed and evaluated in this order; the first match wins:

| # | Form | Pattern | Resolves via |
|---|---|---|---|
| 1 | Integer | `^\d+$` | `id` |
| 2 | UUID | RFC 4122 shape | `public_id` |
| 3 | Short id | `^[A-Z]{2,5}-\d+$` | project by `prefix`, then task by `short_id` within it |
| 4 | Prefix | `^[A-Z]{2,5}$` | project by `prefix` |
| 5 | Slug | anything else | `slug` (projects, sections, groups) |
| 6 | Omitted | — | caller's `default_project_id` (§4), where the tool allows it |

Forms 3–5 apply only to entity types that have the backing column: only projects have `prefix`, only projects/sections/groups have `slug`, only tasks have `short_id`.

**Ambiguity is accepted, not prevented.** A project could carry `slug = "TDE"` while another carries `prefix = "TDE"`; precedence resolves it silently to the prefix match. This is a deliberate trade: deterministic and documented in each tool's description, rather than an ambiguity error that would break callers who are currently working fine. Each tool description states the accepted forms and their order.

### Scoping — the security-critical part

Every resolution is tenant-scoped **and** OU-scoped, reusing `OuScopeResolver` with the same single-static-SQL-template discipline D1 established (never a runtime-branched WHERE predicate — that anti-pattern was found and reverted once in D1's Task 8 and must not return).

An identifier that exists but is out of the caller's scope resolves to **not found**, producing the same 404 as an identifier that does not exist at all. The resolver must never be usable as an existence oracle.

This matters more than it did in D1. Flattening removes the *structural* enforcement point: today `/projects/{projectId}/sections` forces a project lookup, and that lookup is where the OU check lives. With `?project_id=` optional, a bare `list_sections` has no path parameter to check, so the resolver becomes the **only** thing between a caller and cross-OU data. It therefore gets a dedicated test suite rather than incidental coverage through handlers (§9).

### `short_id` generation

Required, because form 3 depends on it.

- Each project gets a `prefix` (`^[A-Z]{2,5}$`). Supplied explicitly, or derived from the name — the original's own `deriveProjectPrefix()` is the reference behaviour to mirror.
- Each task gets a per-project sequential `short_id`, allocated under `SELECT … FOR UPDATE` on the project row so concurrent creates cannot collide. This is the mechanism D1's spec §4 described and D1's implementation omitted.
- The external form is `{prefix}-{short_id}`, e.g. `TDE-31`.

---

## 4. Flattened routes and session state

### Route shape

Identifiers move out of path segments: query parameters for reads, body properties for writes.

```text
GET  /api/tasker/tasks?project_id=&section_id=&group_id=&status=
POST /api/tasker/tasks              body: {project_id?, section_id?, text, detail?, priority?, due_date?}
POST /api/tasker/tasks/complete     body: {task_id}
POST /api/tasker/tasks/move         body: {task_id, section_id?, group_id?, sort_order?}
GET  /api/tasker/projects/board?project_id=
```

D1's nested paths (`/sections/{sectionId}/tasks`, `/tasks/{id}/complete`, …) are replaced. Handler internals are unchanged — this reshapes route declarations and adds resolver calls at their entry points.

Mutating requests continue to require `X-Requested-With: XMLHttpRequest`; routes are still declared without `/v1` and served at `/api/v1/…`.

### Session state

One new table, `tasker_user_prefs`:

| Column | Notes |
|---|---|
| `id`, `public_id` | dual key, per D1's convention |
| `tenant_id` | integer, not null, bound in every query |
| `profile_id` | integer, not null |
| `default_project_id` | bigint, nullable, FK to `tasker_projects` `ON DELETE SET NULL` |
| `local_mode` | boolean, default false — declared now, consumed by D4 |
| `created_at`, `updated_at` | |

Unique on `(tenant_id, profile_id)`.

whity-core has no per-user preference store to reuse — `GlobalSettingsRepository` and `TenantSettingsRepository` are global and per-tenant, and `NotificationPreferenceRepository` is notification-specific. A per-user default project is Tasker domain state regardless ("which project is this user working in" is not a platform concern), so a plugin-owned table is the right home.

`__init_tasker_session` returns those preferences plus the directive playbook. The playbook lives in a **plugin constant, not a database row** — it is versioned content that must move in lockstep with the code whose behaviour it describes.

---

## 5. Tool inventory

Today: 34 tools (31 board + 3 `tasker_ping` scaffolding from Plan A). After this slice: 48.

### New (14)

| Group | Tools |
|---|---|
| Missing reads | `get_project`, `get_task` |
| Missing verbs | `uncomplete_milestone`, `move_task_to_group`, `update_project_context` |
| Name aliases | `rename_section`, `rename_group` |
| Environments → OU | `list_environments`, `create_environment`, `rename_environment`, `delete_environment` |
| Prioritization | `rank_tasks`, `get_my_attention` |
| Session | `__init_tasker_session` |

### Applied to the 32 schema-less existing tools

A request or query schema making each invocable, plus resolver-backed identifiers.

### Name aliases — the routing mechanism

Two `operationId`s cannot share one route: the router would see a duplicate method+path. So each alias is a **second route declaration, at its own path, pointing at the same handler method**:

| Alias tool | Route | Delegates to |
|---|---|---|
| `rename_section` | `POST /api/tasker/sections/rename` | `SectionsApiHandler::update()` |
| `rename_group` | `POST /api/tasker/groups/rename` | `GroupsApiHandler::update()` |

Both aliases and the `update_*` forms remain. The `update_*` forms also change `description`, `sort_order` and `view_prefs`, so "rename" would be a misleading sole name; and dropping either breaks a working caller. Two thin route declarations over one method is the cheapest way to break nothing in either direction.

### Coverage, stated honestly

This takes original-name coverage from **22 to 36 of the original's 131 tools** — all 14 new tools carry an original name. That completes the *board* portion of the agent surface.

The remaining 95 are not gaps in this slice:

| Destination | Tools |
|---|---|
| D5 flows and gates | 34 |
| D6 knowledge (IS + KB) | 19 |
| D7 intake and agent ops | 14 |
| D9 integrations | 15 |
| D4 local mode (incl. device tokens) | 5 |
| D3/D8 transfer | 2 |
| Board-adjacent, blocked on P4/D5/D6 (listed immediately below) | 6 |

That accounts for all 95 (34 + 19 + 14 + 15 + 5 + 2 + 6).

### Explicitly out of scope

- `analyze_section`, `section_insights` — require P4's AI proxy
- `advance_guide`, `get_validation_feedback`, `submit_validation_result` — D5
- `get_project_is` — D6
- Everything in D5/D6/D7/D9 and local mode

---

## 6. Environment → OU aliases

The roadmap (§6) specifies that `create_environment`/`list_environments` and friends become thin aliases over core's OU endpoints, because Tasker's "environment" concept was replaced by whity's Organizational Units.

Core exposes `/api/ous` and `/api/ous/{id}` via `OusApiHandler`, but there is **no OU repository** to construct directly — unlike `TagRepository` or `AuditLogger`, which the plugin already reuses that way. Creating and deleting OUs also affects RBAC role inheritance, which makes writing to `organizational_units` from a plugin more invasive than the reads `OuScopeResolver` already performs.

**The plan must verify how to delegate before implementing**, choosing between constructing `OusApiHandler` directly (preferred if its constructor allows), or plugin-owned tenant-scoped SQL against `organizational_units` (acceptable for reads, to be justified explicitly for writes). Guessing here is exactly the failure mode that cost D1 several fix rounds.

Whichever path: these four tools are aliases, not a reimplementation. Tasker owns no environment table.

---

## 7. Folded-in carry-over items

Included because this slice already touches these files:

- **Close the OU boundary on single-resource routes.** D1's carry-over left this open: routes taking a resource's own id (`complete_task`, `move_task`, `tag_task`, `update_section`, and roughly a dozen others) remain tenant-scoped only, while parent-parameterized routes were fixed. The same id-guessing argument applies, and a half-guarded boundary implies a guarantee that does not hold. Flattening routes touches every one of these call sites anyway.
- **`EntityTagRepository::detachAll()` on delete.** Deleting a tagged task or ping currently orphans its `entity_tags` rows. The bumped core provides `detachAll(int $tenantId, string $entityType, int $entityId): int`; the delete handlers should call it.
- **`move()`'s supplied-vs-changed `section_id` bug.** `$sectionChanging` is set from `array_key_exists`, so a plain reorder that echoes the current section silently un-groups a grouped task. One-line fix, and `move_task_to_group` lands in the same method.
- **Response-code documentation drift.** `create_project`/`create_section`/`create_group` return 409 without declaring it; `set_task_discussion` has an undeclared 400; several 404 descriptions still say "in the caller's tenant" when the OU fix made them tenant-or-OU. Route schemas are being rewritten wholesale here, so these correct themselves if done attentively.
- **Missing `p.tenant_id` on four joined visibility queries** — defense-in-depth, not reachable through any route, but inconsistent with the codebase's own convention.

---

## 8. Error semantics

| Condition | Response |
|---|---|
| Identifier not found, or out of tenant/OU scope | **404**, generic message, indistinguishable between the two cases |
| Ambiguous but resolvable | first match by §3 precedence, no error |
| Malformed short id (e.g. `TDE-abc`) | **400**, distinct from not-found |
| Required argument missing after default-project fallback fails | **400**, naming the argument |
| Unique-constraint collision (duplicate name) | **409**, as D1 established |
| Caller's OU unresolvable (no membership row) | **403**, fail closed, as D1's fix wave established |

---

## 9. Testing

Three tiers, following D1's established split between the fast SQLite tier and the Postgres-only tier for anything touching `OuScopeResolver::whereFragment()` (whose `= ANY(:scope)` cannot be prepared by SQLite).

1. **`IdentifierResolverTest`** — every accepted input form, every precedence collision, malformed inputs, and the omitted/default-project path. SQLite where the query shape allows.

2. **`TenantIsolationOuTest` extensions** — Postgres-only. Proves the resolver cannot cross an OU boundary for **any** of the six identifier forms, and that out-of-scope resolves to 404 rather than a distinguishable error. This is the security-critical tier, because flattening makes the resolver the sole enforcement point.

3. **Contract-parity test** — the one that converts this slice's central claim into a check. For every tool name present in both surfaces, assert the derived `inputSchema` against the original's `inputSchema` extracted from `V2/supabase/functions/mcp/index.ts` (property names, types, and which are required). Divergences must be **explicitly allowlisted with a written reason** — e.g. `uncomplete_milestone` accepting `milestone_id` in addition to `index`. An unlisted divergence fails the build. Without this, "we preserved the contract" stays an assertion; with it, a regression is caught mechanically.

The MCP tool-surface snapshot is regenerated once, deliberately, in its own task with the before/after diff reviewed — see §10.

---

## 10. Risks

**Route flattening touches code that just passed a heavy review.** Every route declaration in `TaskerPlugin.php` changes, and each handler entry point gains a resolver call. Handler internals — the tenant predicates, the OU joins, the 404 discipline — stay put, so the risk concentrates in the declarations and call sites rather than the query logic. Mitigation: sequence the resolver first, with its full test suite passing, before any route changes depend on it.

**The snapshot change is large and must not become routine.** 34 tools become 48, and most existing input schemas change shape. Regenerating is correct, but it is precisely the operation the drift test exists to make difficult. It happens once, in a dedicated task, with the diff reviewed — never quietly alongside feature work. The drift check must be re-proven to still fail on a real rename afterwards.

**Milestone dual addressing carries a race.** Accepting positional `index` preserves compatibility but is inherently racy under concurrent edits — two agents reordering the same task's milestones can have an index resolve to different rows. Ids do not have this problem. The `index` form is supported for compatibility and its tool description should say ids are preferred.

---

## 11. Definition of done

1. Every one of the 48 tools has a complete, invocable input schema — no tool exposes path parameters only.
2. The contract-parity test passes, with every divergence from the original explicitly allowlisted and justified.
3. `complete_task {task_id: "TDE-31"}`, `get_project {project_id: "TDE"}`, and `list_tasks {}` (default project) all work end to end against the live host.
4. `short_id` is populated for every created task, allocated race-safely.
5. The resolver cannot cross a tenant or OU boundary for any identifier form, proven by test on real PostgreSQL.
6. The OU boundary is closed on single-resource routes — no route reachable by guessing an integer id escapes it.
7. Every standing invariant still holds: tenant isolation, one static SQL template per OU predicate, dual keys, single-colon permissions, `host/.core/` untouched, CI green with the Postgres tier actually running.

**Not delivered:** a working SPA (D2), data transfer (D3), local mode (D4 — `local_mode` column is declared, not consumed), flows, knowledge, intake, integrations, or any AI-backed tool.
