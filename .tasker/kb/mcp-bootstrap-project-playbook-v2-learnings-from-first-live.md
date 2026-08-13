# MCP: bootstrap_project playbook v2 — learnings from first live test

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

First live run of bootstrap_project (sample: "Weekly Meal Planner") validated the spine — draft-first → react-interview → challenge-in-flight → ratify → create_project → propose IS all worked. Full transcript was logged to a report. Key observations + the playbook changes they drove (all shipped):

WHAT WORKED
- Draft-first made the interview confirm/correct, not blank-page extraction. Leading with "why" gave every later question a yardstick (the meal-source fork could be framed AGAINST the stated "save time" intent, making the recommendation self-justifying).
- scope.out / quality_bar / assumptions fields forced the three things users never volunteer. Provenance marking (decided vs assumed vs open-non-blocking) kept it honest without stalling.
- The (Recommended) defaults did heavy lifting: user took EVERY recommended option except the one multi-select scope answer — and that single off-default answer (Pantry IN, Combine OUT) was where all the valuable conversation happened.

CLUNK FOUND → FIXES SHIPPED (in the bootstrap_project playbook)
1. Strict one-at-a-time fought AskUserQuestion's 4-question batch capability; independent fields (platform, quality bar) became needless round-trips. → Rule now: dependency-order, but BATCH genuinely independent fields into one call; one-at-a-time only where an answer reshapes the next.
2. AskUserQuestion needs >=2 options even for user-only knowledge (the "why"), forcing invented options that risk anchoring on the field you should least lead. → New rule: USER-ONLY FIELDS — DON'T ANCHOR (no Recommended; ask in prose first or present options with no recommended pick).
3. Multi-select "tick what you want IN" can yield internally incoherent sets (Pantry IN contradicts the time-saving goal). The agent caught it via challenge — made explicit. → CHALLENGE rule now mandates a COHERENCE PASS after any multi-select scope question.
4. create_project returned only slug+UUID, not the prefix/short-ID handle the rest of Tasker uses — and new projects had NO prefix at all. → create_project now auto-derives a unique 2–5 letter prefix (deriveProjectPrefix helper, e.g. "Weekly Meal Planner" → WMP) and returns prefix|slug|id. Renameable via update_project.
5. Playbook elicited the Foundation but didn't close the loop to action. → Added step 6: after persist+IS, offer build_new_flow for the first concrete chunk of work. create_project response echoes this nudge.

Builds on [[design_conductor_per_connector]] is unrelated; this extends the TDE-262 Foundation work. Testing pattern worth reusing: have the test-window agent write a verbatim report (questions/answers/drafts/pushbacks/final) to a file for the designer to read.
