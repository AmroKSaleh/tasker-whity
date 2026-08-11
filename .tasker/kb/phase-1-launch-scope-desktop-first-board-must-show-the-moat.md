# Phase-1 launch scope: desktop-first, board must show the moat (decided 2026-08-04)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Four launch-scope judgment calls that TDE-790 had left open were decided by the founder on 2026-08-04. Recording them here because future sessions will re-ask these and the answers are not derivable from the code.

**1. Mobile web is OUT of Phase-1 scope — desktop-first launch.**
TDE-860 (Today column collapses to ~0px at 390px) and TDE-861 (board header truncation) do NOT gate launch. This extends the Foundation's "no mobile app until web is stable and paying" from native apps to responsive web. Accepted cost: mobile clicks on launch day hit a broken page, so launch messaging must say desktop-first rather than letting visitors find out. Do not re-open these as blockers.

**2. The web board MUST render gate/contract/judge state before launch (TDE-816 is a committed blocker).**
The MCP side is already real and shipped (get_flow_exceptions, TDE-382), but the Flows page doesn't render any of it. The rejected alternative was "first cohort is MCP-first, so the terminal carries the moat" — that escape hatch is now CLOSED. Consequence worth understanding: because the web board is a launch surface, board-level visual breakage is launch-blocking, not cosmetic — this is exactly why TDE-867 (dark theme paints light everywhere but Settings) was promoted from `low` to blocker. TDE-816 is itself blocked on an undecided rebuild-or-refine call, making that decision the launch critical path.

**3. Connectors: honesty over repair.** Fix TDE-865's lying status only (show "reconnect needed" on a 401 instead of "connected"); leave TDE-866's Gmail 502 down through launch. Connectors are not the core hub+MCP wedge. A status indicator that lies is worse than one that admits failure.

**4. TDE-343 requires one real dogfooding pass before launch** — analysis→section→populate→direct-AI, end to end, across MCP and web. It is the only one of the four original phase criteria that no experiment has touched; "I build Tasker in Tasker daily" was explicitly rejected as sufficient evidence.

**Process gotcha, generalizable:** TDE-790's blocker list read "zero committed blockers" for four days while carrying four. The 2026-07-31 draft was correct when written; eight bugs (TDE-860–867) were filed 2026-08-02 and never run through the tracker's own bar. A cleared blocker list is only valid as of its draft date — re-sweep newly-filed bugs against the bar whenever a batch lands, and never read an old "all clear" as current. This is a different failure from the stale-bookkeeping pattern already recorded (TDE-263, pull_google_task, TDE-780): there the task was stale, here the SUMMARY was stale.

