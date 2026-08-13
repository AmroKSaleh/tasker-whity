# Flows: step_list_open — a flow must not claim completion when it only ran out of KNOWN steps (TDE-811)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SHIPPED + DEPLOYED 2026-07-29. Migration 20260729120000_flow_step_list_open.sql, branch tde-811-honest-flow-progress.

## The bug (sharper than the task described)
`run_flow` computed `allDone = completedCount === sorted.length`, printed "Status: COMPLETE — all steps done." and **returned early**. `advance_guide` did the same via `remaining.length === 0`. For work that discovers its next step as it goes (research, investigation, debugging) that condition is true at EVERY pause — finish step 1 of an eventual 5 and the flow declares itself complete, then silently reverts when step 2 appears.

The damage is behavioural, not cosmetic: the early return means an agent reading COMPLETE **stops working**. A wrong fraction misinforms; a wrong terminal verdict changes what happens.

## WHAT WAS NOT WRONG — there is no frozen denominator anywhere
TDE-811's third milestone assumed a step count "frozen at start". There isn't one, and never was:
- `flows` table has no count column (20260605140000: id, user_id, project_id, name, context, created_at, updated_at).
- Web app: `stepCount: steps.length`, computed live in useFlows.js.
- MCP: every readout counts the current task list — `sorted.length`, `guideSorted.length`, `total`.
Proven live: adding a step mid-run moved the readout 1/1 → 1/2 with zero code change. **If you are ever asked to "unfreeze" a flow count, check first — the premise is false.**

## The fix: one mutable fact, explicitly NOT a flow type
`flows.step_list_open boolean not null default false`.

Q6 (TDE-798) refused flow "types" and was right — nothing here branches on a *category* of flow. `step_list_open` is a statement about what is currently KNOWN: it flips both ways during a single run, and it changes nothing about execution except whether the system may call the flow finished. That distinction is what makes it legitimate under the no-types rule; keep it that way if you extend this.

Default `false` because most flows are authored whole by build_new_flow. Defaulting open would make every readout hedge — taxing the common case to serve the uncommon one.

## Where it is wired
- **run_flow** — `allKnownDone` split from `allDone`. Open + all known done → reports "ALL KNOWN STEPS DONE … it is NOT finished", lists steps so far, instructs the caller to create the next step or close the list. No COMPLETE verdict.
- **guide_flow** — appends "— step list OPEN, more steps expected".
- **advance_guide** — replaces "Flow complete" with the all-known-steps wording when open.
- **list_flows** — an open flow does not roll up to `done` even at 2/2: "2 known so far · 2/2 done · in_progress · step list OPEN".
- **update_flow_context(step_list_open)** — the setter, both directions.
- **name_flow(step_list_open)** — declarable at creation. **GUARD:** written only when explicitly passed, so re-calling name_flow to add a step cannot silently slam an open list shut. Verified.
- **Global directive "STEP LIST OPEN"** — tells agents to declare it at authoring time if steps aren't listable to the end, to open it the moment they realise remaining work isn't knowable (not after the readout is already lying), and to CLOSE it once the extent is known, since an open list permanently withholds the flow's ability to report itself finished.

## KNOWN REMAINING GAP — the web app ignores the flag
`useFlows.js` derives status as `doneCount === steps.length ? 'done'`, so an open flow still rolls up to done in the UI. One line. Deliberately left: the Flows PAGES are being rebuilt (TDE-816) while the Flows system itself is already rebuilt, so auditing/patching today's page rendering would be thrown away. **The rebuild must read `step_list_open`** — that is the whole point of putting the signal in the data layer. Recorded on TDE-811 too so it is not lost.

## Why this belongs to a pattern
Third instance of one bug class in two days: TDE-806 (two denominators disagreeing), TDE-818/819 (state asserting what it could not support), and this (a total asserted as final). The house rule that keeps falling out: **never render a number or verdict you cannot stand behind — say what is actually known.** The phases PhaseBar precedent (an explicit unphased segment rather than a silent residual) is the same instinct.
