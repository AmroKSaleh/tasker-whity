# D5a — flow spine and I/O contracts

**Date:** 2026-08-12
**Status:** Design — approved, ready for planning
**Implements against:** [2026-08-03-whity-full-parity-roadmap-design.md](2026-08-03-whity-full-parity-roadmap-design.md) (D5, first half)
**Binding decisions:** [2026-08-12-cross-slice-architecture-decisions.md](2026-08-12-cross-slice-architecture-decisions.md)
**Builds on:** D1 (board backend) and D1b (API completion + MCP parity), shipped at `origin/trunk` `5e2289f`

## Why this is half a slice

"D5 — flows and gates" is **47 tools** in the original, with a strict internal dependency chain: execution needs gates, gates need I/O contracts, contracts need the flow spine. For calibration, D1 was 34 tools and D1b was 15, so D5 as roadmapped is larger than both shipped slices combined.

It is therefore cut in two at the natural seam:

- **D5a (this spec) — 15 tools.** Flows exist, connect, and order themselves. Storage and shape work, no orchestration.
- **D5b — ~18 tools.** Gates, validation, execution, templates, and the validation audit trail. Where the behaviour and the concurrency questions live.

Ten flow-scoped IS/KB tools belong to **D6** per the binding decisions, and four tools were mis-grouped into D5 by the roadmap and are removed from it entirely (see Out of scope).

---

## 1. Scope

### In — 15 tools

**Flow spine (8)**
`build_new_flow`, `name_flow`, `list_flows`, `delete_flow`, `get_flow_context`, `update_flow_context`, `get_flow_order`, `recompute_flow_steps`

Note `build_new_flow` is a **read** tool. It returns the interview playbook plus project grounding; it creates nothing. Persistence happens through `create_task` + `set_task_output` + `set_task_input`, then `name_flow`. This matters for planning: it is a response-shaping task, not a mutation.

**`name_flow` is the flow-creating call.** It takes the member task IDs plus a name, inserts the `tasker_flows` row, stamps `flow_id` on each member, and computes the initial `flow_step` ordering. There is no separate "create flow" tool, so a flow never exists unnamed — which is what makes `UNIQUE (project_id, name)` safe to enforce.

**I/O contracts (7)**
`set_task_input`, `set_task_output`, `remove_task_input`, `clear_task_output`, `derive_output_contract`, `confirm_contract`, `get_task_connections`

### Out of scope, and where each went

| Tool | Why not D5a | Owner |
|---|---|---|
| `get_flow_audit` | Returns which rules passed/failed, evidence notes, retry counts, contract blessing status — pure validation data | D5b |
| `validate_output`, `submit_validation_result`, `store_artifact`, `get_task_critique`, `get_validation_feedback`, `get_flow_exceptions` | Gate machinery | D5b |
| `run_flow`, `resume_flow`, `stop_flow`, `guide_flow`, `advance_guide` | Execution | D5b |
| `save_flow_as_template`, `instantiate_flow_template`, `list_flow_templates` | Templates; need the spine and contracts first | D5b |
| `enable_task_review`, `disable_task_review`, `review_task`, `submit_task_review` | Second entry point into D5b's gate storage | D7 |
| 10 flow-scoped IS/KB tools | Same concept D6 owns at project and default scope | D6 |
| `add_task_link` | Attaches a **URL** to a task (a PR, a deployed page). Nothing to do with flows — the roadmap mis-grouped it on the word "link" | Unassigned; small, belongs with task metadata |
| `merge_task_as_duplicate` | Dedupe via `duplicate_of`. Touches edges but is not flows | Unassigned |
| `resolve_seed` | Handles the `seed_target: task` path; seeds need `kind` / `seed_target` / `seed_open_questions` columns D1 never built | Unassigned; own small slice |

**Not delivered by D5a:** nothing runs. A flow can be built, named, connected, ordered and inspected, but there is no `run_flow`, no validation, and no gate enforcement until D5b.

---

## 2. The contract model

This is the conceptual heart and the part most likely to be got wrong, so it is stated exactly. There are **two contract layers**, and one derives from the other.

**Producer level — one contract per task.** `set_task_output` sets *"this task's OUTPUT CONTRACT — the producer's single definition-of-done for the one artifact it produces."* Consumers are **derived**, not named: any task listing this one as a source. So `set_task_output` takes no target. The contract is meant to be context-free and portable.

**Edge level — one contract per consumer edge.** `set_task_input` declares *"this task consumes the output of `source_task_id`, and `contract` is the acceptance criteria that upstream output must meet for THIS task to use it"* — the consumer's demand, which may be stricter or differently framed than what the producer promises.

**Derivation runs consumer → producer.** `derive_output_contract` builds a producer's contract *from* its consumers' edge rules: *"the consumers' input-edge rules ARE the acceptance criteria."* Wire the consumer edges first, then call it on the producer. It returns a **draft** rule set plus an `assumptions` list — vague inherited rules, multi-consumer merges, missing criteria — for a human to see before confirming. `apply: true` persists the draft.

**Blessing is a flag, and writes invalidate it.** Agent-authored contracts are AI-QA'd, recorded as `contract_blessed: false`. `confirm_contract` blesses a task's contract after human review. Any subsequent `set_task_output` or `set_task_input` **resets it to AI-QA'd**.

**Decision on the reset's blast radius.** The original's wording ("any subsequent call to `set_task_output` or `set_task_input` resets the contract") does not say whose blessing is reset when a *consumer* edge changes. Since `confirm_contract` takes a single `task_id`, blessing is per-task, and D5a implements:

- Writing a task's own contract (`set_task_output`, `clear_task_output`) resets **that task's** blessing.
- Writing an edge (`set_task_input`, `remove_task_input`) resets **the consumer's** blessing, and **also** the producer's — because a derived producer contract is only as valid as the consumer rules it was derived from, and silently keeping a blessing over changed inputs is the failure the flag exists to prevent.

The producer cascade is a **deliberate divergence** if the original does not do it; it is recorded in the parity allowlist as SEMANTIC with a named behavioural test, per the allowlist's own rule.

---

## 3. Storage

### `tasker_flows`

Dual key per the project quality bar: `id BIGSERIAL PRIMARY KEY`, `public_id UUID NOT NULL UNIQUE` (PHP-generated). Plus `tenant_id BIGINT NOT NULL`, `project_id BIGINT NOT NULL` FK → `tasker_projects(id)`, `name TEXT NOT NULL`, `context JSONB NOT NULL DEFAULT '{}'`, `step_list_open BOOLEAN NOT NULL DEFAULT FALSE`, `short_id INTEGER`, `created_by`, `created_at`, `updated_at`.

**OU scoping is inherited from the project**, exactly as sections, groups and tasks already do — flows carry no `ou_id` of their own, and every flow query joins to `tasker_projects` and applies `OuScopeResolver::whereFragment('p.ou_id')`.

**Flows have their own short-id namespace.** `resolve_reference` addresses flows as `TDE-F1` — an `F`-prefixed form distinct from a task's `TDE-31`. So `IdentifierResolver` gains a seventh form and a `resolveFlow()` method. Allocation reuses the D1b `ShortIdAllocator` against a per-project flow sequence.

`UNIQUE (project_id, name)` — `name_flow` names a flow within a project, and two flows sharing a name in one project would make `get_flow_context` ambiguous.

`UNIQUE (project_id, short_id)` — the constraint D1b added for task short ids, applied to flows for the same reason. Note the **known inherited defect**: `ShortIdAllocator::next()` uses live `MAX + 1`, so deleting the highest-numbered flow frees its number for reissue, after which a stored `TDE-F3` reference can address a different flow. This is tracked separately (see the D1b carry-over) and D5a must not paper over it — flow short ids inherit the same limitation as task short ids until that fix lands.

### `tasker_task_edges`

The normalised replacement for the original's `tasks.input.edges` JSON array.

`id BIGSERIAL`, `public_id UUID`, `tenant_id BIGINT NOT NULL`, `source_task_id BIGINT NOT NULL` FK → `tasker_tasks(id) ON DELETE CASCADE`, `target_task_id BIGINT NOT NULL` FK → `tasker_tasks(id) ON DELETE CASCADE`, `expected_type TEXT NULL`, `contract JSONB NULL`, `created_at`.

`UNIQUE (target_task_id, source_task_id)` — one edge per consumer/producer pair; a second `set_task_input` for the same pair upserts.
`CHECK (source_task_id <> target_task_id)` — no self-edges.

**Why normalise** (the binding decision, restated so a planner sees the reasoning): the JSON column cannot carry a foreign key, so a deleted producer leaves a dangling `source_task_id`; finding *dependents* means selecting tasks and scanning their `input` JSON with jsonb containment; and `move_task`'s documented "cross-project I/O edges DROPPED — its own inputs **and any references to it**" is application code walking other rows. `ON DELETE CASCADE` on both sides makes that a database guarantee, and `get_task_connections` becomes two indexed queries.

### `tasker_tasks` — new columns

`flow_id BIGINT NULL` FK → `tasker_flows(id) ON DELETE SET NULL` · `flow_step INTEGER NULL` · `output_contract JSONB NULL` · `output_contract_blessed BOOLEAN NOT NULL DEFAULT FALSE`.

`ON DELETE SET NULL` on `flow_id`: deleting a flow returns its steps to the board rather than destroying tasks. `delete_flow` therefore un-flows tasks; it does not cascade to them.

**`delete_flow` leaves the edges intact.** Edges join two tasks and are independent of flow membership, so dismantling a flow does not dismantle the I/O graph its tasks share — the tasks return to the board still wired to each other. Removing an edge is `remove_task_input`'s job, deliberately. Stated here because it is precisely the kind of thing an implementer would otherwise guess at, in either direction.

The blessed flag lives here, on the task, so D5a is self-contained. D5b's validation ledger **reads** it when recording `contract_blessed` in an audit entry.

### Indexes

`tasker_task_edges (source_task_id)` and `(target_task_id)` for the two connection directions; `tasker_tasks (flow_id, flow_step)` for ordered flow reads; `tasker_tasks (flow_id)` partial `WHERE flow_id IS NOT NULL`.

---

## 4. Step ordering

`flow_step` is a **stored** topological position, recomputed **inside the same transaction** as any edge mutation that changes the DAG. `recompute_flow_steps` remains a real tool for parity and as a repair hatch, but it stops being load-bearing.

The original stamps `flow_step` at creation and lets it go stale — `recompute_flow_steps`' own description says step numbers *"go stale if the DAG changes"* and must be re-stamped by hand. That is a known-wrong-data bug an agent hits silently, and auto-recompute removes the whole class without changing any tool shape or making reads more expensive.

**Cycles are rejected with 422.** The original has no cycle prevention — its only "cycle-safe" code is a reader that dedupes via a `seen` set, so a circular dependency is creatable and leaves topological order undefined. Auto-recompute makes rejection mandatory rather than optional: the sort has no answer over a cycle. `set_task_input` therefore refuses an edge that would close one, naming the path.

`FlowStepSorter` is a **pure** class — DAG in, positions out, or a cycle report. No PDO, no tenant, no OU. That makes it fully unit-testable on the SQLite tier, which matters because everything else in this slice is OU-scoped and therefore Postgres-only.

---

## 5. Components

| File | Responsibility |
|---|---|
| `plugin/Api/FlowsApiHandler.php` | Flow CRUD, context read/write, `get_flow_order`, `recompute_flow_steps` |
| `plugin/Api/TaskEdgesApiHandler.php` | `set_task_input`, `remove_task_input`, `set_task_output`, `clear_task_output`, `get_task_connections` |
| `plugin/Domain/FlowStepSorter.php` | Topological sort + cycle detection. Pure. |
| `plugin/Domain/ContractDeriver.php` | `derive_output_contract` — merges consumer edge rules, produces the draft plus the `assumptions` list. Pure. |
| `plugin/Access/IdentifierResolver.php` | Gains `resolveFlow()` and the `F`-prefixed short-id form |
| `plugin/Migrations/CreateTaskerFlowsTable.php` | The flows table, both unique constraints, and the `flow_id` index |
| `plugin/Migrations/CreateTaskerTaskEdgesTable.php` | The edge table, both FKs with cascade, the pair-uniqueness and no-self-edge constraints, and the two directional indexes |
| `plugin/Migrations/AddTaskerTaskFlowAndContractColumns.php` | The four `tasker_tasks` columns and the `(flow_id, flow_step)` index. Additive `ALTER`s — no data migration, since no existing row is a flow step |

`build_new_flow` returns a playbook and needs no handler of its own — it is a route method composing a static playbook with project grounding, like D1b's `__init_tasker_session`.

---

## 6. Cross-slice impact: the board-exclusion retrofit

**TDE-320: flow steps leave the board entirely.** In the original they drop out of `list_tasks`, out of the board, and out of *every* section tally and denominator (TDE-806). A task that becomes a flow step stops being a task for display purposes.

So D5a must retrofit **six already-shipped tools** with a `flow_id IS NULL` predicate: `list_tasks`, `get_board`, `get_project`, `get_ready_work`, `rank_tasks`, `get_my_attention` — plus every count and tally in those responses.

**The contract-parity test cannot catch this.** It compares property names, `required`, and enums; this is a behaviour change with no shape change. That is exactly the class the D1b whole-branch review found four of, so it gets explicit tests rather than trust: for each of the six, a task moved into a flow disappears from that tool's output, and the section tally drops by one.

---

## 7. Deliberate divergences from the original

Each is recorded in `plugin/tests/Contract/parity-allowlist.php` with a reason. The allowlist is staleness-checked, and a `severity => 'semantic'` entry must name a behavioural test that exists and contains an assertion.

| Divergence | Kind | Why |
|---|---|---|
| Edges in a table, not `tasks.input` JSON | Invisible to parity | Tool shapes unchanged — `set_task_input` still takes `source_task_id` + `contract`. Storage is ours. No allowlist entry needed. |
| `flow_step` auto-recomputed | SEMANTIC | Same tool surface, strictly better data. Entry records that `recompute_flow_steps` is no longer required for correctness. |
| Cycles rejected with 422 | SEMANTIC | The original permits creating one. Forced by auto-recompute. |
| Blessing reset cascades to the producer | SEMANTIC | See §2. Only if the original proves not to cascade — verify against the code during implementation before adding the entry. |

---

## 8. Error handling

Follows the project quality bar without exception:

- Every query binds `tenant_id` explicitly. One static SQL template per OU predicate; no caller value ever reaches SQL text.
- Out of tenant or OU scope → **404**, indistinguishable from not-found. Malformed short id → **400**. Unresolvable caller identity or OU membership → fail closed **403**.
- Cross-project edge (source and target in different projects) → **422**. Cycle → **422**, naming the path.
- A contract that is not a JSON object → **422**.
- Booleans bind with `PDO::PARAM_BOOL` explicitly.
- Migrations use `CURRENT_TIMESTAMP`, never `NOW()`; UUIDs PHP-generated.
- A mutating route never resolves its own target from a caller default — the rule the D1b review had to add after `update_project_context` could wipe an unnamed project.
- Query parameters read via `queryParam()`; core empties the body on `GET`/`DELETE`/`HEAD`.

---

## 9. Testing

**Postgres tier (`plugin/tests/TenantIsolationOuTest.php`)** — everything OU-scoped, because `OuScopeResolver::whereFragment()` emits `= ANY(:scope)` and fails at `PDO::prepare()` under SQLite. Per resource: a sibling-OU 404 paired with a same-OU positive control, since a 404-only test can pass because the fixture was never visible.

**SQLite tier** — `FlowStepSorter` and `ContractDeriver`, both pure. Cycle detection, diamond DAGs, disconnected components, single-node flows, stable ordering among independent siblings.

**Behavioural floor, beyond the boundary tests:**
- Deleting a producer removes its edges by cascade, and no dangling `source_task_id` survives.
- Deleting a flow returns its tasks to the board with `flow_id NULL`, and destroys no tasks.
- Each of the six retrofitted tools excludes flow steps, and its tallies drop accordingly.
- `derive_output_contract` surfaces an `assumptions` entry for a genuine multi-consumer merge.
- `confirm_contract` then `set_task_input` leaves the contract unblessed.
- An edge whose source is in another project is refused.

**Baseline entering the slice:** 378 tests / 883 assertions / 0 skipped, PHPStan clean at level 6 via the unmodified CI script, 49 MCP tools, parity allowlist 19 entries / 56 divergences / 4 semantic.

---

## 10. Definition of done

1. 15 new tools derive and are invocable with real arguments; tool count 49 → 64.
2. `host/scripts/mcp-tools.ps1`'s allowlist matches the code's `operationId`s exactly, and `npm run mcp:check` passes against a freshly synced live host.
3. The contract-parity test passes; every divergence in §7 is allowlisted with a reason, and each SEMANTIC entry names a behavioural test that exists and asserts.
4. All six retrofitted tools provably exclude flow steps, with tests.
5. No edge can cross a tenant or OU boundary, proven on real PostgreSQL for every identifier form including the new `F`-prefixed flow form.
6. A cycle cannot be created, and `flow_step` is never stale after any edge mutation.
7. Full suite green with **0 skipped**; PHPStan clean at level 6 through the repo's own unmodified script.
