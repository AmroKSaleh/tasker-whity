# Dogfooding Report — Flow *Authoring* Experience

- **Date:** 2026-06-15
- **Exercise:** Author the build-flow for TDE-261 (the task-level output judge) *using Tasker Flows*, to evaluate the product on real work.
- **Flow produced:** `TDE-F1` — "TDE-261 Task-Level Output Judge — Build" (6 tasks, TDE-264…269).
- **Author:** Claude (Opus 4.8), directed by the user.

## Scope of this report — read first

This covers **flow authoring only** — `build_new_flow` → `create_task` → `set_task_output`/`set_task_input` → `create_flow_is_entry`/`create_flow_kb_entry` → `name_flow` → `get_flow_order`.

It does **not** cover **execution** (`run_flow`, the judge loop, regenerate/escalation) — we authored the flow but have not run it yet. A second report should follow after execution; many of the most important findings (does the validation loop actually catch bad output? how do contracts behave under regeneration?) can only come from running it.

---

## What worked well (keep these)

- **P1 — Contract rule-quality linter is the standout.** `set_task_output`/`set_task_input` flagged vague judgment language ("relevant", "readable") *at authoring time* and pushed toward checkable criteria, with a concrete example in the warning. It caught two soft rules I would have let slide. This is the single best part of the authoring UX — it enforces the discipline that makes contracts worth having.
- **P2 — Output/input contract split + fan-in is clean.** Modeling def-of-done (`set_task_output`) separately from acceptance criteria (`set_task_input`, one call per source) made the fan-in on TDE-266 (consumes 264 *and* 265) straightforward. The upsert-per-source semantics are intuitive.
- **P3 — Flow KB auto-loads on every task.** Unlike project KB (on-demand), flow KB rides along on every `get_task` in the flow. This is exactly the "carry the design to each step without re-injection" behavior you want for a multi-step build — and it's a live preview of why the judge feature needs reliable KB reads (TDE-254).
- **P4 — `get_flow_order` is a good final artifact.** The numbered, dependency-aware view with the context bag inline is a clear "here's what you built" confirmation.

---

## Frictions & gaps (each: what happened → impact → recommendation)

### F1 — No fast-path for arriving *with* a finished design
`build_new_flow` assumes a cold start: it returns a grill-me interview playbook and instructs the agent to interview the user one question at a time. But we had an approved spec already, so the entire interview was redundant. There is no "I already designed this — just help me persist it" mode.
- **Impact:** redundant interaction (or, as here, the agent silently skips the prescribed interview, which means the tool's own protocol wasn't followed).
- **Recommendation:** add a mode that accepts a structured flow spec (tasks + edges + contracts) and persists it directly, OR have `build_new_flow` detect an attached design doc and switch to "review & persist" instead of "interview".

### F2 — Grounding dumps *all* project tasks
The `project_context` payload included **all ~80 project tasks** regardless of relevance to the goal.
- **Impact:** noisy and token-expensive; scales badly as the project grows; most of it is irrelevant to authoring this flow.
- **Recommendation:** relevance-filter or cap the grounding (e.g. tasks in the target section + a goal-keyword match), or summarize by section with counts and let the agent pull detail on demand.

### F5 — Step ordering interleaves phases (depth-only topo-sort)
`get_flow_order` placed Phase-2's TDE-268 (KB-enriched bar) at **step 4**, ahead of Phase-1's TDE-267 (verdict visibility) at **step 5**, because 268 sits shallower in the dependency graph. But 268 is blocked on TDE-254.
- **Impact:** the recommended execution order is misleading — it sequences a *blocked* later-phase task ahead of an *unblocked* earlier-phase one. "Phase" / logical grouping is not expressible in the I/O graph alone.
- **Recommendation:** support a `phase`/group concept or soft-ordering hints that the topo-sort respects as a tiebreaker; and/or warn when a task with an unmet external blocker is ordered early.

### F6 — Flow IS silently suppresses the project's non-universal IS
Creating the first flow IS entry flips the flow into "flow IS governs" mode, which **replaces the project's non-universal IS** (Code Style, Deployment Rules) for these tasks. I had to *restate* those rules in a flow IS entry to avoid the build tasks losing them.
- **Impact:** a real footgun — critical operational rules (e.g. deploy commands, code style) silently vanish for flow tasks unless the author remembers to restate or universalize them.
- **Recommendation:** when the first flow IS is created, **warn** which project IS entries will be suppressed and offer to copy them in; and/or treat clearly-operational rules (deploy, code style) as universal by default.

### F7 — External / cross-flow dependencies aren't expressible
TDE-268/269 (Phase 2) genuinely depend on **TDE-254** (a task *outside* this flow). Wiring that as a real `set_task_input` edge would pull TDE-254 into this flow's connected component (and `run_flow` would then treat 254 as a step). So the dependency could only be **documented** (in flow IS + context + task detail), not **enforced**.
- **Impact:** a real, hard prerequisite goes unenforced by the dependency system; the graph under-models reality. The server *could* block on it, but only at the cost of merging two logically-separate flows.
- **Recommendation:** support a "soft"/external dependency edge that blocks a task without merging connected components — i.e. cross-flow dependencies as a first-class concept.

### F8 — Authoring is "protocol-dispenser" only; nothing verifies the author followed it
`build_new_flow` returns instructions for the agent to run; nothing checks that an interview happened, that every edge actually got a contract, or that contracts are non-trivial before `name_flow`.
- **Impact:** flow quality depends entirely on agent diligence; a lazy author could `name_flow` with no contracts and the system wouldn't object.
- **Recommendation:** a lightweight pre-`name_flow` check ("N edges have no contract; M rules are warning-flagged — proceed?").

### F12 — Authoring overhead: ~27 tool calls for a 6-task flow
Tally: 1 `build_new_flow` + 6 `create_task` + 7 `set_task_output` + 7 `set_task_input` + 1 `name_flow` + 3 `create_flow_is_entry` + 1 `create_flow_kb_entry` + 1 `get_flow_order` ≈ **27 calls** (plus 2 re-sets to fix linter-flagged rules).
- **Impact:** high authoring cost in tokens and round-trips; scales linearly with flow size.
- **Recommendation:** a batch/transactional `create_flow(spec)` that accepts the whole structure (tasks + edges + contracts + IS + KB) in one call and validates atomically.

---

## Smaller notes

- **N1 — confirm_contract not exercised.** All 12 contracts are "AI-QA'd" until a human blesses them via `confirm_contract`. The user confirmed the *flow* verbally, but no contract was human-blessed. Worth clarifying in UX the difference between "flow confirmed" and "contracts blessed" (the latter is the real moat per TDE-203).
- **N2 — Duplicate sections in grounding.** Two identically-named "Define docs structure… - Flow Tasks" sections appeared — pre-existing cruft from an earlier flow's task-filing. Suggests flow-task sectioning can create duplicate sections; worth a cleanup + a guard.
- **N3 — Re-set ergonomics.** Fixing a linter-flagged rule meant re-sending the whole contract (`set_task_output` replaces). A per-rule patch would be lighter.

---

## Top recommendations (ranked for the Flows-optimization discussion)

1. **Batch `create_flow(spec)`** (addresses F1, F12) — biggest authoring-cost win; also gives a natural "persist a pre-designed flow" path.
2. **Warn on flow-IS suppression** (F6) — prevents silent loss of deploy/code-style rules; low effort, high safety.
3. **External/soft dependencies** (F7) — needed for any flow with real out-of-flow prerequisites; also unblocks honest phase-ordering.
4. **Relevance-scoped grounding** (F2) — cost + scale.
5. **Phase/group-aware ordering** (F5) — correctness of the recommended order.
6. **Keep & extend the contract linter** (P1) — consider auto-suggesting the concrete rewrite.

---

## Appendix — the flow as built

```
TDE-F1  "TDE-261 Task-Level Output Judge — Build"
Step 1 · TDE-264  Schema + enable flag, eligibility & flow-exclusivity guards   [high]
Step 2 · TDE-265  Bar assembly from task text + IS (Phase 1)                     [high]  ← 264
Step 3 · TDE-266  Trigger + single-task judging protocol (reuse flow loop)       [high]  ← 264, 265 (fan-in)
Step 4 · TDE-268  KB-enriched bar via title-scan (Phase 2, needs TDE-254)        [low]   ← 265
Step 5 · TDE-267  Verdict visibility (get_task + web app)                        [medium]← 266
Step 6 · TDE-269  KB category soft-hint for retrieval (Phase 2)                  [low]   ← 268
```
- 12 contracts (6 output def-of-done + 6 input acceptance), all AI-QA'd (none human-blessed yet).
- 3 flow IS entries (build discipline; phase discipline; restated project rules).
- 1 flow KB entry (condensed design + machinery map).
- Phase 1 = 264→265→266→267. Phase 2 = 265→268→269 (blocked on TDE-254).
