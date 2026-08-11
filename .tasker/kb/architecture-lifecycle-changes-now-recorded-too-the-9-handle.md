# Architecture: lifecycle changes now recorded too — the 9 handlers that bypass update_task (TDE-819)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SHIPPED + DEPLOYED 2026-07-28. Closes the gap documented in the task_events entry ("status changes outside update_task are not recorded"). Read alongside that entry — TDE-818 built the log, this filled it in.

⚠ NUMBERING NOTE: this work is **TDE-819**. It was mistakenly referenced as "TDE-821" while in progress — the short ID was inferred rather than checked, and TDE-821 was later consumed by a throwaway test task. Code comments and this entry are corrected. The git branch `tde-821-lifecycle-history` and its merged commit message still carry the wrong number and cannot be rewritten (already on main). If you are tracing history: branch tde-821-* == task TDE-819.

## The gap
`fields_changed` fired ONLY from the `update_task` handler. Every other handler mutating task lifecycle wrote to `tasks` directly and produced NO row — so a task being COMPLETED was absent from its own history, which made get_task_history misleading for the most basic question anyone asks of it.

## Fix: recordLifecycleChange wrapper
Thin wrapper over recordTaskEvent using kind='fields_changed' + entity='task', with **`meta.via`** naming the handler. Deliberately NOT a new event kind — the `kind` CHECK constraint in migration 20260728120000 would have needed altering; `via` carries the distinction at zero migration cost. Filter with get_task_history(kind:'fields_changed') then read `via`.

## The 9 sites now recorded (all live-verified)
| via | what it records |
|---|---|
| complete_task | status → done |
| uncomplete_task | status → pending, INCLUDING the completed_at being discarded |
| move_task_to_group | group_id (+ section_id when passed) |
| move_task | cross-project move: project/section/group/flow reset, dropped edges, stripped consumers, and **the old→new short_id** |
| set_task_phase | phase set AND unphase (both branches) |
| merge_task_as_duplicate | TWO rows — dup closed as MERGED (distinct from plain done), canonical shows it absorbed scope |
| resolve_seed | seed RESOLVED into a named task (closure, not work completion) |
| get_task_autostart | pending → in_progress side effect of get_task |
| advance_guide | guide step cleared BY A HUMAN, with evidence size |

## Why get_task_autostart is recorded (decided with the user, 2026-07-28)
`get_task` silently flips a pending task to in_progress. Convenient for real pickups, invisible for read-only inspection — in this very session a survey of tasks flipped 8 of them to in_progress and they had to be spotted and reverted by hand. Now that flip leaves a trace with `meta.auto: true`. Bounded: fires only on the pending→in_progress transition, not on every read.

## THE RECURRING TRAP — resolveTask's fixed projection (bit us three more times)
`resolveTask` selects a FIXED column list. It does NOT include completed_at, group_id, phase_id, priority, due_date, pinned, executor, agent_ready. Deriving a before-state from a resolveTask result therefore silently omits those fields — and asserting `?? null` writes a FALSE prior value, which is worse than an absent one. Sites that now fetch the prior value explicitly before writing: uncomplete_task (completed_at), move_task_to_group (group_id), set_task_phase (phase_id) — plus update_task from TDE-818. **Check this every time you record a before-state.** Where the value genuinely isn't available cheaply, OMIT the field rather than claiming null (complete_task does this for completed_at).

## SHORT IDs ARE REUSED after a task leaves a project
Observed while testing: a task that was TDE-820 moved to another project (becoming AAA-1), and the NEXT task created in TDE was also assigned 820. The short_id trigger computes max+1 over the project's current tasks, so a departed number is handed out again. This makes the move_task provenance row more important than first thought — an old reference like "TDE-820" doesn't merely dangle, it can later resolve to a DIFFERENT task. Worth its own task if durable references matter.

## Deliberately NOT recorded (scope boundary — don't "fix" these without deciding)
- flow_step renumbering — internal ordering bookkeeping, not lifecycle
- input/output edge + contract writes — already covered by the contract_* kinds
- store_artifact, drive_files — artifact storage, not gate state
- delete_flow unlinking, delete_group ungrouping — bulk teardown side-effects
- submit_validation_result reopening the producer — already contextualised by its validation_submitted row
- import/instantiate bulk creation

## STILL OPEN: the Local Mode flush hole
The flush path (index.ts ~1121) writes task fields directly from .tasker/ files, so **file-driven edits still leave no history**. Not fixed here on purpose: different semantics (bulk reconciliation, LWW, hub_wins corrections) mean naive recording would double-count or spam. Needs its own decision about what a "file edit" event should even mean.
