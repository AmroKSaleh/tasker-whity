# Session roll-up 2026-07-28/29: gate history built, Flows definition propagated to every code surface

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

One long session. Theme, in one line: **the system stopped asserting things it could not support.** Six tasks closed, two migrations, five deploys. Detail lives on each task and in the per-topic KB entries; this is the map.

## Shipped and MERGED to main (pushed)
- **TDE-818 — durable gate history.** New append-only `task_events` table (migration 20260728120000) + `get_task_history`. Before this, contract/review/gate changes were in-place overwrites: `confirm_contract` left three mutable fields that the next `set_task_output` erased, review verdicts overwrote per attempt, validation ledgers were keyed per EDGE not per ATTEMPT, so `retry_count: 3` could report three failures with all three bodies gone. `get_flow_audit` is named "audit" but renders current mutable JSONB — now relabelled "Gate Snapshot" and pointing at the real log.
- **TDE-819 — lifecycle changes recorded.** `fields_changed` fired only from `update_task`, so nine other handlers wrote to `tasks` directly and left no trace — a COMPLETED task was absent from its own history. All nine now record via `recordLifecycleChange` with `meta.via`: complete_task, uncomplete_task, move_task_to_group, move_task, set_task_phase (both branches), merge_task_as_duplicate (records on BOTH tasks), resolve_seed, get_task autostart, advance_guide.
- **TDE-820 — naming a flow no longer requires contracts.** `name_flow` hard-blocked unless every handoff had a blessed contract, so a legitimately ungated flow needed `bypass:true` and got stamped gate_bypassed for life. `contractGateViolations()` → `contractAdvisories()`, which separates ungated / vague / unblessed and blocks on NONE. Historical bypass flags kept as data, re-worded to a neutral "Pre-gate-change".
- **TDE-813 — Flows UI** (closed this session; code had shipped 07-28). Ungated flows were invisible on every surface at once: detection ran on I/O edges, and a contract-less flow has none, while `flow_id` already hid its tasks from the board.
- **TDE-808** — the MCP FLOW-vs-AD-HOC directive rewrite (merged in the same stack).

## Shipped, deployed, pushed — NOT merged
- **TDE-811 — honest flow progress.** New `flows.step_list_open` (migration 20260729120000). `run_flow` used to print "COMPLETE — all steps done" and RETURN EARLY whenever done == known steps; for discovery-shaped work that fires at every pause, and an agent reading COMPLETE stops working. Branch `tde-811-honest-flow-progress`.
- **TDE-382 promoted scope — `get_flow_exceptions`.** The human review surface: failed checks with observed evidence, judgment residue, terminal output, ordered by blast radius. Branch `tde-382-flow-exceptions` (stacked on TDE-811).

## Parked
- **TDE-812 (public docs)** — deliberately parked by the user: "many things will change soon", so the page gets rewritten once against the final shape. All scoping is already recorded on the task; only two editorial calls remain open.

## The Flows definition is now on FOUR surfaces, one still wrong
directive (TDE-808) ✓ · UI (TDE-813) ✓ · MCP finalization gate (TDE-820) ✓ · **public docs (TDE-812) ✗ parked**. The definition itself is settled (TDE-792); the user confirmed *"Flows themselves have been rebuilt already — the Flows PAGES still need to be built"* (TDE-816).

## Cross-cutting lessons worth more than the individual fixes
1. **`resolveTask` selects a FIXED column list** — no priority, due_date, pinned, executor, group_id, agent_ready, completed_at, phase_id. Deriving a before-state from it silently omits those, and `?? null` writes a FALSE prior value. This bit four times in one session. Where the value is not cheaply available, OMIT the field rather than assert null.
2. **Short IDs are REUSED** after a task leaves a project. A task that was TDE-820 moved out and the next new task also got 820. So an old reference does not merely dangle — it can later resolve to a DIFFERENT task.
3. **`create_task` returns only a UUID.** Inferring the short ID from sequence produced a real error this session (see below). Read it back from `list_tasks`.
4. **A promotion that changes scope without changing milestones leaves a task reading DONE.** TDE-382 showed 3/3 shipped while carrying unbuilt structural scope. Check for this pattern.
5. **Record before you surface.** `get_flow_exceptions`' history view was impossible until TDE-818 landed hours earlier.

## Known error baked into git history
The merge commit for TDE-819 reads **"Merge TDE-821: lifecycle changes now recorded in gate history"**, and its branch is `tde-821-lifecycle-history`. The task is **TDE-819**. The short ID was inferred instead of read; TDE-821 was later consumed by a throwaway. Code comments and KB were corrected; the pushed commit and branch name cannot be. **branch tde-821-* == task TDE-819.**

## Board hygiene done
Deleted the stale `ZZ THROWAWAY` fixtures (old TDE-F3/814/815) plus every fixture created this session — board holds zero throwaway tasks. Reset 8 tasks that `get_task` had silently flipped to in_progress during a read-only survey (this is exactly why TDE-819 now records `get_task_autostart`). Mined Ideas tagged [DO IT]/[NOT NOW]; TDE-556 dissolved into TDE-818 + TDE-378 + a reduced saved-views task.

## Four tasks are in_progress ON PURPOSE — do not "tidy" them
TDE-796 and TDE-797 are held open pending the Round 2 experiment (**TDE-791**) and say so explicitly. TDE-351 is an unstarted rethink. Closing them would destroy real information.
