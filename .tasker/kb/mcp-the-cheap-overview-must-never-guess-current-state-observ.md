# MCP: the cheap overview must never guess — current_state + observed-only staleness (TDE-875)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped 2026-08-06. The design rule is the durable part; the fields are just how it's expressed.

**The rule: the affordable path must not be the one that misleads.**

`get_project` drops Notes by default, so the cheap overview is title + priority + status. On a task worked over weeks those are the *stalest* fields on the record — titles are written once, at creation, when the least is known; bodies accrete. An agent wrote a WQW status report off that output and asserted a security entry vector was still open when the mitigation had shipped ten days earlier.

**Two heuristics were proposed and rejected: first-N-chars of detail, and last-paragraph of detail.**

Both would have caught all four WQW cases. That is exactly why they're dangerous. They work on WQW because *that project's* bodies accrete chronologically with status headings at the bottom — a habit of whoever wrote them, not a property of Tasker. On a spec-shaped body the last paragraph is the last spec bullet: noise, rendered confidently. A heuristic that's right most of the time teaches the reader to trust it, which makes the remainder worse than no signal. Same failure as the stale title, one layer down.

So the overview has exactly two branches and no third: the task states its standing (`current_state`, written deliberately), or it admits it can't vouch for the title (staleness `⚠`). Never an extracted guess.

**The mistake worth remembering: I committed that same sin in the first migration, via a timestamp instead of a sentence.**

The staleness flag compares `text_updated_at` to `detail_updated_at`. There's no record of historic title edits, so I backfilled `text_updated_at = created_at` and reasoned it was the honest default, erring loud on the grounds that an unnecessary body read costs tokens while an unflagged stale title cost a wrong deliverable.

Against real data that was wrong. On WQW it lit up ~70 of 132 tasks, most reading "22d ago" in lockstep — because what the comparison actually measures on legacy rows is *task age at last edit*, which correlates with nothing. Half a board of warnings is not a signal; an agent learns to ignore the mark within one screen, leaving the real ones undefended. And WQW-137, one of the four incident tasks, wasn't flagged at all — its body moved inside the seven-day window.

Corrected in `20260806133000`: legacy rows get `text_updated_at = detail_updated_at`, so no row is flagged on fabricated history and the flag fires only on divergence the system actually observed. **The generalizable lesson: a backfilled timestamp is invented data. Deriving a user-facing signal from one manufactures confidence exactly as much as summarising prose does — test any such signal against a real board and count how often it fires before trusting the reasoning that produced it.**

**Consequence to know:** boards already full of stale titles get no marks until their next body edit ages seven days. The remedy for existing tasks is writing `current_state` on the ones that matter — the flag was always the backstop, not the fix. Four WQW tasks were given state lines by hand as part of this work.

**Maintenance is the design's real weak point.** `current_state` is only worth reading if it keeps up, so `update_task` nudges whenever a caller changes `detail` and not `current_state`, quoting the line being left stale. Without that the field decays to empty and the whole thing reduces to a flag.

Also added: a warning (never a block) on titles over 120 chars, since titles are re-sent in full on every board read — WQW-134's "title" is a multi-paragraph document with a PHP code block in it, and it costs ~85 tokens on every single overview call, forever.

