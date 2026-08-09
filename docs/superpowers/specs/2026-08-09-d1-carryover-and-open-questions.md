# D1 carry-over: deferred work and open questions

**Date:** 2026-08-09
**Status:** Input document for D2 planning — not a spec
**Source:** D1's final whole-branch review (opus) + the terminal re-review of its fix wave
**Implements against:** [2026-08-04-whity-d1-board-backend-design.md](2026-08-04-whity-d1-board-backend-design.md)

D1 shipped green (128 tests, 242 assertions, PHPStan clean at level 6, pushed to `origin/trunk` at `4401b8f`). Its review cycle surfaced work that was deliberately *not* done, plus one design question that needs a human decision before D2 builds on it. This document exists so none of it is rediscovered the hard way.

---

## 1. The open design question — decide before D2

**Do single-resource routes need OU checks?**

D1's final review found that the plan's original OU-scoping rationale was factually wrong. The plan justified tenant-only scoping on child routes by reasoning that "a caller can only ever learn a section/group/task id by first reaching it through an OU-visible project." That premise fails for any route taking a **parent** id as a path parameter, because `tasker_projects.id` is a plain sequential `BIGSERIAL` — an OU-restricted caller can simply count upward.

That gap **was fixed** for parent-parameterized routes (`list_sections`/`create_section`, `list_groups`/`create_group`, `create_task`, `add_milestone`, `get`/`set_task_discussion`), which now join up to `tasker_projects.ou_id` and apply `OuScopeResolver`.

**Still open:** routes taking the resource's *own* id — `update_section/{id}`, `delete_section/{id}`, `update_group/{id}`, `delete_group/{id}`, `update_task/{id}`, `delete_task/{id}`, `complete_task`, `uncomplete_task`, `pin_task`, `unpin_task`, `move_task`, `tag_task`, milestone `update`/`delete`/`toggle`. These remain **tenant-scoped only**, deliberately, pending this decision.

The same id-guessing argument applies to them: these ids are also sequential `BIGSERIAL`. A caller who guesses a task id can mutate a task in an OU they cannot see. The counter-argument is that these are mutations on already-identified resources rather than discovery endpoints, and the cost is ~15 more methods carrying an OU join.

**Recommendation:** close it. The reason the boundary was declared real for parent routes applies verbatim here; leaving half the surface guarded is the worst of both worlds, because it implies a guarantee that doesn't hold. Budget it as a small, mechanical D2-prerequisite slice — every one of these handlers already has the join path and the `resolveCallerOu()` plumbing from D1's fix wave.

---

## 2. Deferred: MCP request-body schemas (blocks agent use)

**31 of 34 derived MCP tools have no request-body schema.** Only the three ping routes (from Plan A) declare `'request' => ...` + `components`; none of D1's 31 routes do. The committed snapshot shows the consequence — tool input schemas contain path parameters only:

```
create_project      props=[]            <- an agent cannot pass a name
create_task         props=[sectionId]   <- cannot pass text/priority
update_task         props=[id]          <- cannot pass anything to update
move_task           props=[id]
tag_task            props=[id]          <- vs. tag_ping props=[id, tag_id]
set_task_discussion props=[id]
```

`tag_task` versus `tag_ping` is the clearest seam: the same operation, implemented in two different tasks, produced two different tool contracts.

D1's acceptance criterion was satisfied literally — 34 tools exist and the drift check provably bites — but the roadmap's stated goal ("agent tool names survive a total backend replacement") is only half-delivered while roughly 20 mutation tools cannot be meaningfully invoked.

**Why it was deferred:** it is a large, mechanical lift best done once, against the request shapes D2's frontend actually exercises, rather than guessed at inside a bug-fix wave.

**Do this early in D2**, not late — the frontend and the agent surface want the same shapes, so doing it alongside the SPA work is cheaper than doing it twice.

---

## 3. Minor code items (none blocking, all small)

1. **`TasksApiHandler::move()` clears `group_id` when `section_id` is merely *supplied*, not *changed*.** `$sectionChanging = array_key_exists('section_id', $decoded)` — so `{"section_id": <current>, "sort_order": 5}` (a plain reorder that echoes the current section) silently un-groups a grouped task. The docblock says "when section_id **changes**"; the code does not implement that. One-line fix:
   `$sectionChanging = array_key_exists('section_id', $decoded) && (int) $decoded['section_id'] !== (int) $row['section_id'];`
   Low practical risk today — the known client always passes section and group together — but D2's drag-and-drop is exactly the code that will hit it.

2. **Joined visibility queries bind `tenant_id` on the child table only.** `GroupsApiHandler`, `TasksApiHandler`, `MilestonesApiHandler`, and `TaskDiscussionsApiHandler` each join `tasker_projects p ON p.id = <child>.project_id` without a `p.tenant_id` predicate. Not reachable through any API route (no route can create a cross-tenant child→parent link), and strictly more constrained than the pre-fix code — but it diverges from the codebase's own convention (`BoardApiHandler` explicitly binds both sides). Defense-in-depth; add `AND p.tenant_id = :tenant_id` to the four joins.

3. **New response codes undocumented in route schemas.** `create_project`/`create_section`/`create_group` now return 409 but declare only 201/400/404/422; `set_task_discussion` gained a 400 path it doesn't declare. Separately, several 404 descriptions still read "not found in the caller's tenant" when the OU fix made them tenant-*or*-OU — `list_groups` was updated to say "tenant or OU scope" but its siblings weren't.

4. **`phpunit.xml` lacks `failOnSkipped="true"`.** If the CI Postgres service, DSN, or `pdo_pgsql` step ever regresses, the 62 OU tests fall back to `markTestSkipped()` and the build stays green — the exact silent-coverage-loss failure mode that made the CI gap a Critical finding in the first place. Adding this flag makes that fix self-enforcing.

5. **Two test micro-weakenings from the SQLite→Postgres migration.** A `COUNT(*) === 1` assertion was dropped from the discussion malformed-body test (the no-duplicate property is covered by an adjacent test), and the cross-*project* group rejection is now only logically subsumed by the cross-*section* test rather than directly asserted.

6. **Local `TenantIsolationOuTest` runs silently skip on a fresh machine.** The DSN now defaults to `dbname=tasker_test`, which doesn't exist until someone runs `createdb tasker_test`. CI creates it; local developers get 62 silent skips with no signal. A README line or an npm script would close the loop.

---

## 4. Noted, outside this plugin's control

- **`MembershipRepository::findByProfile()` does not filter on membership `status`.** A suspended or pending membership still resolves as a valid caller OU. This is pinned host code (`host/.core/`), never patched from here. Worth raising upstream in whity-core rather than working around in Tasker.

- **Stale rows in the shared dev database.** Prior pre-fix runs of `TenantIsolationOuTest` against `dbname=tasker` left orphaned `organizational_units` and `tenants` rows (synthetic tenant ids 7 and 9) and a drifted id sequence. A one-time `setval()` repair was applied to unblock testing; the orphaned rows were deliberately left in place. Harmless, but they can be cleaned whenever convenient — the test suite no longer touches that database.

---

## 5. Next immediate task (not part of D2)

**Bump the whity-core pin.** `host/core.version` is at `d4c74cd`; upstream is 60 commits ahead, SDK 1.14.0 → 1.16.0. Changes that touch Tasker's surface: WC-712 (plugin-accessible permission resolution), WC-714 (entity-tag cleanup on taxonomy deletes — interacts with Tasker's own cascade deletes), atomic entity-deletion hooks, plus new i18n and error-tracking subsystems.

Verified already: `EntityTagRepository::attach()` and `TagRepository::find()` — the only two core APIs Tasker calls directly — have unchanged signatures, and the SDK moved by minor versions (additive under semver). So the bump is expected to be low-risk, but it should be done as its own focused change with the core version as the only variable, so any breakage is unambiguously attributable.
