# Flows: get_flow_exceptions — the human sees exceptions, never outputs (TDE-382 promoted scope)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SHIPPED + DEPLOYED 2026-07-29, branch tde-382-flow-exceptions. This is the STRUCTURAL half of TDE-382, distinct from the presentation half that shipped 2026-07-11.

## Read this first if TDE-382 looks done
TDE-382 shipped in July as a per-task narrative (`review_verdict.narrative {core, sections, secondary}`) — 3/3 milestones, verified live. Then Q7 (TDE-799) **promoted it from presentation to structural** on 2026-07-28 and added no milestones, so the task read COMPLETE while carrying unbuilt scope. Five PROMOTED SCOPE milestones were added and completed 2026-07-29. Milestones 0–2 = July; 3–7 = this work. Beware the same pattern elsewhere: a promotion that changes scope without changing the checklist leaves a task looking finished.

## Why this exists (Q7's actual argument — worth restating exactly)
Human attention does not merely run out, it DEGRADES with volume. Anyone shown 29 step outputs is rubber-stamping by the sixth. **A rubber-stamped output is worse than an ungated one, because it then propagates with confidence it never earned.** Therefore per-step human approval cannot work at any flow length worth calling a flow, and the only shape where broad gating and an attentive human coexist is: show EXCEPTIONS, never outputs — so review load scales with problems found rather than with flow length.

## The tool
`get_flow_exceptions(task_id | flow_id, include_history?)` returns three categories and nothing else:
1. **FAILED CHECKS** — with `observed_value` surfaced. A claim that something failed is not reviewable; what was actually seen is. Includes the consuming step and retry count. When no observed_value exists it says so ("the check was asserted, not run") rather than quietly omitting it.
2. **JUDGMENT RESIDUE** — judgment-kind output rules with no independent (non-self, non-unverified) pass. Q7: "What cannot be reduced to a check IS the human's review list." **These appear even when nothing failed**, because nothing has verified them either. This category is the one people will be tempted to drop; don't — it is where unexamined risk actually lives.
3. **TERMINAL OUTPUT** — steps nothing in-flow consumes, listed unconditionally regardless of check state, because no downstream receiver exists to catch them.

**Deliberately excluded:** passing checks, step artifacts, progress. These are omissions on purpose, not gaps. `get_flow_audit` remains the everything-view and now carries a pointer saying so.

## Blast-radius ordering — and what was NOT guessed
Q7's placement rule is "early seams in long flows, and irreversible actions." Only the first half is computable, and it is implemented as **transitive descendant count**: a bad output early in a long chain contaminates everything downstream, the last step contaminates only itself. **Irreversibility is not detectable from the graph and is deliberately not inferred** — a heuristic guess there would be confidently wrong on exactly the actions that matter most.

## Dependency that resolved itself the same morning
`include_history:true` reads earlier failed attempts from `task_events`. That was IMPOSSIBLE before TDE-818 shipped hours earlier — validation ledgers were keyed per edge and each attempt overwrote the last, so "what did this fail on the first time" had no answer. If you are sequencing work: record-then-surface. The surface is worthless without the record.

## Directive added
"NEVER ASK A HUMAN TO REVIEW OUTPUTS — SHOW THEM EXCEPTIONS", with the authoring corollary that matters just as much: **every criterion converted into a kind=check is one the human never looks at again, on every seam, on every run, forever.** So interrogate each criterion with "how would we actually check this?" and record kind=judgment only when the answer is genuinely nothing. The contract's job is to shrink the residue.

## Honest limitation
On the 3-step verification fixture, the everything-view was 30 lines against 20 for exceptions — an unimpressive ratio, and it should not be quoted as evidence. The argument is structural: audit grows per STEP, exceptions grow per PROBLEM. They diverge at Q7's stated scale, not at three steps. The real evidence is that the passing check is absent from the output entirely.

## For TDE-816
MCP-only by design, because the Flows pages are being rebuilt and an exception VIEW would be discarded while the exception QUERY is durable. **TDE-816 should render this, not reinvent it** — it is precisely the "flow detail opens with 'step 4 failed its check, here is the evidence'" that TDE-816 names as its biggest gap.
