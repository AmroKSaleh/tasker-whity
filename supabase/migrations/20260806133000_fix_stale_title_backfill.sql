-- TDE-875 follow-up: stop the stale-title flag from firing on fabricated history.
--
-- The first migration (20260806120000) backfilled text_updated_at = created_at, reasoning
-- that a title is written at creation and we have no record of title edits. Measured against
-- real data that is wrong, and the render proved it: on WQW roughly 70 of 132 tasks lit up,
-- most reading "22d ago" in lockstep. What that comparison actually measures on legacy rows
-- is "how long after creation was this task last touched" — i.e. task age — which has no
-- relationship to whether the title still describes the work. Meanwhile WQW-137, one of the
-- four tasks from the incident that motivated TDE-875, was NOT flagged, because its body
-- happened to move inside the seven-day window.
--
-- Half a board of warnings is not a signal. An agent reading it learns to ignore the mark,
-- which leaves the real ones undefended — the same failure as a heuristic summary that is
-- usually right, arrived at from the other direction. This task rejected first-N-chars and
-- last-paragraph extraction for manufacturing confidence out of nothing; a backfilled title
-- date is the same sin with a timestamp instead of a sentence.
--
-- So: assume title and body were in sync as of the last known edit. No legacy row is flagged.
-- The flag now fires ONLY on divergence this system actually observed — someone edited a body
-- and left the title alone, seven days past the last title change. That is a real event with a
-- real meaning, and it accrues from here on every task's next body edit.
--
-- The cost, stated plainly: boards that are ALREADY full of stale titles get no marks today.
-- The remedy for those is current_state, written deliberately on the tasks that matter — which
-- is the primary mechanism anyway. The flag was always the backstop, not the fix.

update tasks set text_updated_at = detail_updated_at
where text_updated_at = created_at
  and detail_updated_at > text_updated_at;
