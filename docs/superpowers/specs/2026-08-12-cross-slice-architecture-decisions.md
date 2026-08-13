# Cross-slice architecture decisions: review gates, IS/KB scoping, jobs

**Date:** 2026-08-12
**Status:** Decided — binding on D5, D6, D7 and D9
**Resolves:** TOW-22 (seed)
**Read this before writing the D5, D6, D7 or D9 design spec.**

Three questions sat duplicated inside four separate slice checklists. A question answered independently in two slices produces two different storage shapes for one concept, which is far more expensive to unpick later than to decide once. All three were settled against **evidence from the current original app and the bumped whity-core**, not from reasoning about what the shape ought to be.

---

## 1. Review gates: ONE mechanism, two entry points. D5 owns it.

**Decision.** One set of columns, one history table, one code path. D5 (flows and gates) builds it, because flow gates are the harder case and land first. D7 (intake and agent ops) consumes the same mechanism for standalone task review rather than building its own.

**Why — what the original actually does.** The question was whether flow gates (`validate_output` / `submit_validation_result`) and standalone task review (`enable_task_review` / `submit_task_review`) are one mechanism or two. Reading `supabase/functions/mcp/index.ts`:

- `review_enabled`, `review_bar` and `review_verdict` are **columns on the `tasks` row itself** — they appear together in the same `select` list, alongside `output_contract`.
- `task_events` records **both** `validation_submitted` **and** `review_submitted` as values of one `kind` column.

So upstream already treats them as one mechanism with two entry points. Building two would diverge from the original *and* create the duplicate-shape problem this decision exists to prevent.

**Consequences.**
- D5 creates the review/gate columns on `tasker_tasks` and the event/history table with a `kind` discriminator.
- D5 owns `validate_output`, `submit_validation_result`, `store_artifact`, `derive_output_contract`, `confirm_contract`, `get_task_critique`, `get_validation_feedback`.
- D7 owns `enable_task_review`, `disable_task_review`, `review_task`, `submit_task_review` — as a second entry point into D5's storage, adding no tables of its own for this.
- D7's design spec must state that dependency explicitly, so it is not planned as independent work.

---

## 2. IS/KB storage: normalise to TWO tables with a scope column. D6 owns all scopes.

**Decision.** Two tables — instruction sets and knowledge entries — each carrying `scope` (`default` | `project` | `flow`) plus a `scope_id`. D6 (knowledge) owns both, for every scope. D5 consumes flow-scoped entries rather than building storage for them.

**Why — a deliberate divergence from the original's storage, invisible to the contract.** The original has **five** tables: `default_instructions`, `project_instructions`, `flow_instructions`, `project_knowledge`, `flow_knowledge`. There is no scope column (the 50 `scope` mentions in the MCP function are token scopes and prose, not storage).

Storage shape is ours to choose, because **the MCP tool surface stays scope-specific regardless** — `create_is_entry`, `create_flow_is_entry` and `create_default_is_entry` remain three distinct tools with their own names and argument shapes. Contract parity is measured on the tool surface, not on table layout, so normalising costs nothing in parity terms and removes five-tables-for-two-concepts from a rewrite whose stated purpose is to improve on the original's organisation.

**Consequences.**
- D6 creates `tasker_instruction_sets` and `tasker_knowledge_entries`, each with `scope` + `scope_id`, and owns every scope-specific tool across all three scopes.
- D5's flow-scoped IS/KB tools (`create_flow_is_entry`, `list_flow_is_entries`, `get_flow_is`, `get_flow_kb`, `create_flow_kb_entry`, `update_flow_kb_entry`, `delete_flow_kb_entry`, `list_flow_kb_entries`) become thin callers into D6's storage. **This makes D6 a prerequisite of that part of D5** — if D5 lands first, those tools wait for D6 rather than getting temporary storage.
- **Note the asymmetry we are deliberately NOT fixing:** the original has no `default_knowledge`, only default *instructions*. The normalised table can physically hold a default-scoped knowledge row, but no tool exposes one, and none should be added. Adding that capability would make the surface non-1:1 and would need an ADDITIVE allowlist entry. Left alone.
- D3/D8 (transfer) must reshape on import: the original's export carries five separate collections, which map onto two tables plus a scope value. Whoever writes the importer needs this document.

---

## 3. Jobs: Tasker ships its own worker, using the injectable seam. No core patch, no upstream block.

**Decision.** Tasker provides its own `queue:work`-style CLI command that constructs a `JobRegistry`, registers core's handlers via `CoreJobs::register()` plus Tasker's own, and runs core's real `JobRunner`. D7 and D9 both design against that. The upstream request is filed in parallel so the workaround has a retirement path.

**Why — the seam half-exists, and the missing half is injectable.** The project Foundation's constraint *"jobs has no plugin-registration seam yet (no PluginJobsInterface)"* is now **out of date and needs correcting**. As of the bumped core:

- `JobInterface` is in the **SDK** (`host/.core/sdk/src/JobInterface.php`, one method: `handle(array $payload): array`), so a plugin may legitimately implement a job handler.
- `JobRegistry::register(string $name, JobInterface $handler, bool $submittable = false)` exists, and `CoreJobs`' own docblock describes what it registers as the *"core (**non-plugin**)"* handlers — the plugin category is recognised.
- **But** `QueueWorkCommand`'s no-arg constructor does `new JobRegistry()` then `CoreJobs::register()` and never loads plugins, and `PluginLoader` has no jobs awareness. So a plugin job submitted today is dead-lettered by the shipped worker as *"No handler registered for job."*
- **The seam:** `QueueWorkCommand`'s `$runner` and `$repo` are constructor-injectable. A plugin-owned worker can therefore build a registry containing both core's jobs and its own and hand it to the genuine `JobRunner`, using only public APIs.

**Consequences.**
- D7 (intake polling, agent sessions) and D9 (integration sync) both target real core jobs, not plugin-owned polling tables and not a reinvented queue.
- Tasker owns one CLI entry point for this; both slices register handlers into it rather than each solving it.
- `host/.core/` is still never patched. This uses public constructor injection, nothing more.
- File the upstream request for proper plugin job discovery (a `PluginJobsInterface` plus `PluginLoader` wiring). When it lands, Tasker's worker retires and the handlers stay.
- The Foundation constraint must be updated, or the next slice will re-derive a blocker that no longer exists.

---

## What this changes about slice ordering

- **D6 gains a dependency edge into D5.** D5's flow-scoped IS/KB tools need D6's tables. Either sequence D6 before that part of D5, or scope D5 to flows-and-gates only and let the flow IS/KB tools land with D6.
- **D7 shrinks.** It no longer owns review storage (D5 does) and no longer needs a jobs workaround of its own.
- **D9 shrinks similarly** on the jobs question.
- **D3/D8 grow slightly**, by the IS/KB reshaping on import.
