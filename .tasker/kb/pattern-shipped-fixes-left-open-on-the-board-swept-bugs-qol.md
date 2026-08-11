# Pattern: shipped fixes left open on the board — swept Bugs/QoL, 3 more found (7 total)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Seven instances found in one session (2026-07-31), each independently: code was written and shipped that fully addresses an open task, but the task was never marked done.

1. **TDE-263** ("filters can't combine") — filed 2026-06-14, fixed 2026-06-19 in commit c92aa1c. Left open 6 weeks.
2. **TDE-257** ("collapsing the Flows sidebar hides the reopen button") — filed 2026-06-14, fixed the SAME DAY as TDE-263, same commit c92aa1c ("always show 'Show list' button in flow detail (was hidden on desktop)"). The fix's code location later moved (a 2026-07-30 Flows-graph redesign commit, e41ee01, restructured FlowGraph.jsx/FlowsPage.jsx) — confirmed the button still renders unconditionally at its new location before closing. Left open 6 weeks.
3. **TDE-403**'s sort half ("add sorting options to each section") — fully built 2026-06-18/07-18 (commits 0fe0fbb, d003e80), both explicitly tagged TDE-403. Left open 6 weeks; only the flow-steps-toggle half was genuinely missing.
4. **TDE-322** ("add the ability to sort tasks inside sections") — a true DUPLICATE of TDE-403, filed 2 weeks earlier (2026-06-29) and never converged. Folded via merge_task_as_duplicate rather than closed independently, preserving the duplicate_of provenance link.
5. **TDE-780** — an audit recommendation (rename to "MCP authorization hardening") wri written into the task detail but never applied to the task itself. Caught a session later.
6. **pull_google_task** — shipped but never functional: wrote `sorting_order` where the column is `sort_order`, failing every call since the day it was written.

**THE SWEEP METHOD, validated:** `git log --all --format="%h %ad %s" --grep="<task-ref>"` (commit MESSAGE search) found every real hit above. **`git log -S"<task-ref>"` (content pickaxe) produced a mass false positive** — one bulk commit (Local Mode v1 dogfood, 9d6be69) that exported the entire project as `.tasker/` fixture files matched EVERY task ID checked, because the ID appears as plain data inside the dumped files, not as a real code change. Use `--grep` on messages first; only fall back to `-S` on specific paths if `--grep` comes up empty, and treat any single commit that matches many unrelated IDs as fixture-data contamination, not a real signal.

**Swept 2026-07-31 (Bugs + QoL sections, 9 open tasks checked):** 2 confirmed fixed (TDE-263, TDE-257), 1 duplicate merged (TDE-322), 1 partial match left untouched (TDE-392 — an OVERDUE bucket already exists in TodayPage, but urgency colors and rollover don't — not clean enough to close). Four remain genuinely unbuilt with no trace found: TDE-183 (mobile-specific layout bug — needs an actual device check, can't confirm via static grep), TDE-391, TDE-394, TDE-396, TDE-158.

**Practical implication for future sessions:** before starting work on an old, vague, or long-untouched task, grep commit MESSAGES for its own ID first — cheap, and repeatedly found the task already done or already duplicated. Don't assume an open task means outstanding work; assume nobody has checked recently. The Bugs and QoL sections are now swept; other sections (Core App, Flows, 3rd Party Integrations) have not been.
