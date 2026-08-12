# D1b carry-over: deferred work, open questions, and method lessons

**Date:** 2026-08-12
**Status:** Input document for D2 planning — not a spec
**Source:** D1b's 16 per-task reviews, its final whole-branch review, and the frozen-bar acceptance run
**Implements against:** [2026-08-09-d1b-board-api-completion-and-mcp-parity-design.md](2026-08-09-d1b-board-api-completion-and-mcp-parity-design.md)

D1b shipped to `origin/trunk` at `1b4ca65` — 43 commits, 38 files, 18,017 insertions. 378 tests / 883 assertions / 0 skipped, PHPStan clean at level 6 via the repo's own unmodified CI script, `mcp:check` passing and re-proven to catch both a rename and an added tool. 49 MCP tools, all invocable with real arguments; before this slice, 2 of 34 were.

This document exists so none of what follows is rediscovered the hard way.

---

## 1. The number that matters most

D1b's contract-parity test converted the slice's central claim into something a build can fail on. It derives our surface through core's **real** `ToolDeriver` against the live route table — not a snapshot — so it runs in CI with no host.

**36 of the original app's 143 MCP tools exist on whity. 19 of those 36 diverge in a recorded way. 107 are unported.**

A green build means "no *unrecorded* divergence", not "compatible". Divergences live in `plugin/tests/Contract/parity-allowlist.php` — 19 entries, 56 waived divergences, 4 tagged semantic — and the list is staleness-checked: an entry describing a divergence that no longer exists fails the build, so it must shrink over time. A `severity => 'semantic'` entry additionally cannot be discharged by declaring the property alone; it must name a behavioural test that exists and contains an assertion.

The test was proven to bite rather than assumed to: a reviewer injected twelve divergences — an invented property, a re-added `{id:\d+}` path parameter, a widened enum, a narrowed enum, seven stale-allowlist classes, and a fake "port" — and got twelve failures, then reproduced the original first-run failure list from an emptied allowlist.

**Residual limit, on record:** the test compares schema-to-schema and never schema-to-handler. A parameter that is declared and then ignored is structurally invisible to it. That is exactly how `list_projects`' inert `environment_id` survived into the final review (§3).

---

## 2. Open questions — decide before or during D2

**Should reordering exist over MCP at all?** The live original exposes **no** reordering tool: neither `update_task` nor `move_task_to_group` carries `sort_order`, and its drag-and-drop is served over its own REST layer. D1b kept the capability by adding `sort_order` to `move_task_to_group` as a deliberate ADDITIVE divergence, because D2's frontend needs it. If D2 instead calls a non-MCP endpoint for reordering, that divergence can be retired.

**Does `get_project`'s response payload need to match the original's?** `toProjectTask()` deliberately omits `tenantId`, `projectId`, `createdBy` and timestamps that `toPublicTask()` carries. D1b's parity target was the tool **input** contract, so response shape was out of scope and no test pins it. D2's frontend is the first real consumer and will settle it — check against the original's frontend hooks, not against `index.ts`.

**Is 403-for-not-found acceptable on the environment aliases?** The four `*_environment` tools delegate to core's `OusApiHandler`, which answers an absent-or-other-tenant OU with **403**, not the 404 the rest of the surface uses. Core uses the identical status and message for both cases, so there is no existence oracle and the security intent survives — but it is a visible inconsistency in the surface an agent sees, and closing it would mean translating core's response, which the alias deliberately does not do.

---

## 3. What the final whole-branch review caught, and why per-task review could not

All four blockers were **compositions**. Every contributing task was locally correct and passed its own review; the defect lived in the seam between them. This is the single most transferable finding of the slice.

1. **CI's PHPStan step was red at HEAD.** It ran `php vendor/bin/phpstan analyse` with no memory limit and crashed at PHP's 128M. No single task pushed the plugin past that ceiling — 18,000 cumulative insertions did. Sixteen consecutive tasks were told to treat it as a known environment defect and pass a manual `-d memory_limit=512M` that existed nowhere in the repo, so every "PHPStan clean" result in the slice was true only of a command CI never ran.

2. **Duplicate project prefixes were settable in one call**, after which `TDE-5` resolved to whichever project Postgres returned first (`projectByColumn()` used `LIMIT 1` with no `ORDER BY`). A deterministic silent wrong-row mutation needing no concurrency. One task built short-id resolution *assuming* prefix uniqueness; one put the uniqueness check inside `PrefixDeriver` and filed only the race as pre-existing; two exposed `prefix` as a writable field. Nobody owned the composition, and no test created two projects with the same prefix.

3. **`update_project_context({context, replace: true})` wiped the caller's default project's Foundation** — violating the branch's own documented rule that a mutating route must never resolve its own target from a caller default. The sweep that established that rule had enumerated destructive routes by HTTP **verb** ("every other DELETE route"), so a destructive PATCH escaped it.

4. **`list_projects` declared an `environment_id` filter the handler never read.** The previous slice's exact failure mode — name matches, shape matches, the argument silently does nothing — surviving into the slice built to eliminate it, and passing the parity test green with no allowlist entry because the shape was byte-identical to the original's.

**Takeaway for D2's plan:** budget a whole-branch review that sweeps *invariants globally* rather than re-reading each task's diff, and enumerate destructive operations by **what they destroy**, never by HTTP verb.

---

## 4. Filed as separate work — do not rediscover

Each is recorded in the Tasker project (`TOW`) with a concrete fix.

- **Short IDs are not stable references.** `ShortIdAllocator::next()` uses live `MAX(short_id) + 1`, so deleting or moving the highest-numbered task frees its number, and the next `create_task` reissues it — after which every stored reference to `SRC-40` addresses a different live task. Inherited from D1; `delete_task` has always done this. Recommended fix: a `last_short_id` column on `tasker_projects` allocated by one atomic `UPDATE … RETURNING`, which also removes the lost-race retry loop entirely. The migration must backfill `MAX(short_id)` per project, not 0.
- **Re-sync the original's tool snapshot from the live server.** `V2/supabase/functions/mcp/index.ts` is a month stale — 131 tool names against 143 live, with 12 live-only and 0 present-but-dead, so it works only as a floor. Three properties had to be hand-patched into the generator from a live-oracle table, and the generator can detect a *redundant* correction but never a *missing* one.
- **D7's agent-ops gaps, now precisely scoped.** `update_task` lacks eight fields the original has (`agent_ready`, `current_state`, `delegated_to`, `executor`, `human_guidance`, `relay_context`, `tags`, `agent_proposal`). `get_ready_work` ignores the original's `agent_ready` hand-off gate, so it returns *all* pending work rather than *handed-over* work — the highest-consequence agent-ops divergence found. Three of `get_my_attention`'s five buckets depend on review, guidance and agent-session features that do not exist yet.

---

## 5. Known limits carried deliberately

- **The `UPDATE`/`DELETE` statements are tenant-only**, with the OU predicate in the preceding `findVisible()`. No boundary is reachable — the pre-check 404s first — but it is a check-then-act shape with a TOCTOU window if a project's `ou_id` changes mid-request. Documented at each of the four sites.
- **`delete_section` takes the only `SELECT … FOR UPDATE` in the plugin.** Folding the sibling-count predicate into the DELETE's own `WHERE` — the technique that closed the *emptiness* guard — cannot close the *last-section* guard, because it is a predicate over sibling rows the statement never touches, so under READ COMMITTED two concurrent deletes of different sections never conflict. This was established empirically (an observed 204 where a refusal was required) after the plan asserted the opposite. The lock is on the parent project row, inside a transaction, proven with two genuine PDO connections.
- **`mcp:check` is not in CI** — it needs a live host. The CI-visible guard is the parity test over `getRoutes()`, which is the one that matters; the live-surface comparison remains a manual run.
- **`short_id` is `INTEGER NULL`** and Postgres treats NULLs as distinct in the unique index, so population is a code-path guarantee rather than a schema one. One live row predating the allocator has `short_id IS NULL`.
- **`tag_ping` still exposes a bare `id`** — the last surviving `{id:\d+}` path parameter, Plan A scaffolding outside the board surface.
- **System tenant 0 lists OUs across all tenants**, inherited from core's own `@tenant-guard-ignore`. `host/.core/` is never patched, so this is upstream's to fix.

---

## 6. Method lessons

**Settle every parity question against the running server.** Both the design repo's `index.ts` *and* the app's own MCP documentation page (`app/src/docs/contentMcpV2.js`) contradict the live surface. The docs page described `rank_tasks` as a bulk reorder mutation; the live tool is a read-only ranking call. An implementer correctly refused to ship against my brief on the strength of the docs page, and was right that something was wrong even though the source it consulted gave the wrong answer.

**When handler behaviour changes, sweep the route schema strings by hand.** Three separate occurrences in this slice of a handler changing while the schema text describing it — in a different file — went stale, twice telling an agent the exact opposite of what the code did. Nothing mechanical catches it, because the parity test compares property names, `required` and enums, never descriptions. One deliberate sweep after a behaviour change found four further stale strings.

**A gate authored to fit completed work is a description, not a gate.** D1b's acceptance run failed its own bar rule 1 — the wording counted zero-argument tools as defects alongside genuinely uninvocable ones. It was submitted as a failure rather than reinterpreted, the task reopened, and the wording was corrected only on an explicit human ruling. The same lesson closed Phase 1 earlier in this project.

**Twelve of sixteen tasks found a real error in the brief they were given**, and the tasks that pushed back produced the most valuable findings in the slice — including a parameter that had been invented outright, a default `status` filter that contradicted the contract quoted three lines above it, and the transaction-versus-retry interaction that would have broken short-id allocation under Postgres. Brief implementers to say so plainly when an instruction rests on a false premise, and mean it.
