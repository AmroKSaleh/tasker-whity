# Product: AI code-churn — IS + verification gate as ONE system (TDE-365 → build in TDE-344)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Strategic conclusion (TDE-365, 2026-07-06). Restates and sharpens Tasker's moat (see "Execution Layer" decision: moat = contract authoring + verification loop).

THESIS: AI "code churn" (~80–90% of AI code accepted on first pass, much reverted soon after = wrong-on-arrival code that shipped because nobody checked) is NOT fixed by Instruction Sets alone. IS improves GENERATION quality (front-loaded standards/DoD); churn is an ACCEPTANCE-DISCIPLINE problem. The lever is the GATE between "AI generated" and "accepted/done." IS is necessary, NOT sufficient. Of the 4 churn causes (missing standards / no verification gate / fuzzy requirements / reviewer fatigue-rubber-stamping), IS only touches #1. The gate beats IS on the churn metric. Product story + Core App UX should treat IS + an enforced gate as ONE churn-reduction system, gate at least as prominent/low-friction as IS.

TWO SHARPENINGS (this session):
1. A gate that needs a human to eyeball + approve DECAYS into cause #4 (rubber-stamp). So DESIGN PRINCIPLE: prefer DETERMINISTIC kind=check gates (tests pass, build compiles, lint clean, file/pattern exists, word count) that assert pass/fail WITHOUT human judgment — they move the number because they don't rely on discipline. Reserve kind=judgment for where no check can express the bar.
2. Don't hard-mandate the gate on every AI task (mandatory → click-through fatigue). 

DECISION (user, 2026-07-06):
- Gate for executor=agent tasks = DEFAULT-SUGGESTED, ONE-CLICK, SKIPPABLE (not reserved for full flows).
- Core App must DISTINGUISH "done" from "done + verified" — completing an agent task without a passing gate shows visibly as "done (unverified)", not silently green. Surfaces the acceptance failure instead of hiding it.
- BUILD VEHICLE = TDE-344 (verify-before-complete on checkable deliverables). TDE-365 is the rationale/positioning only; do NOT build a parallel gate. Related: TDE-261 (task-level judge) supplies the judgment path; kind=check rules supply the deterministic path.

TDE-365 closed as the recorded rationale.
