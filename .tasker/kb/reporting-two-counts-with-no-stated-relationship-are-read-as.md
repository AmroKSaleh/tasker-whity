# Reporting: two counts with no stated relationship are read as disjoint sets (TDE-873)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Found 2026-08-06 by the owner reading a real project update — not by anyone reasoning about the feature. That provenance is the point: the defect was invisible in the code and obvious the moment a human tried to use the output.

**The failure.** The update rendered `20 Added / 10 Completed / 0 Blocked`. Owner's reaction, verbatim:

> "It doesn't show if the 10 tasks are from the added 20 or not, which made me assume that the 2 statistics are independent."

That is the correct reading of the display and the wrong picture of reality. 8 of the 10 completions were among the 20 added; only 2 touched the pre-existing backlog; the open count moved by +10, not +20.

**The generalisable rule: adjacent counts default to being read as disjoint.** A reader given two numbers and no stated relationship will assume they describe separate groups, because that is the only interpretation the display supports. If the sets actually overlap — and here they overlapped 80% — the reader arrives at the opposite of what happened, while the numbers remain individually accurate. Accuracy of each figure is not sufficient; the RELATIONSHIP is part of the data and has to be emitted.

Applies well beyond this feature. Any place Tasker shows counts side by side (section open/total, phase roll-ups, flow progress) is exposed to the same reading.

**The second-order finding: discovery had no representation.** Most of the launch-blocker work on 2026-08-06 was on tasks that did not exist when the previous update was published — they were found by sweeping the app and by measuring token spend. Under the old shape that renders as churn: lots added, lots closed, backlog barely moved. `added_closed_same_window` is now the figure that distinguishes a find-and-fix sweep from thrash. Note it CANNOT distinguish them on its own — a deliberate sweep and being pulled onto whatever is loudest produce identical numbers — so the narrative still has to say which it was.

**A metric can be dead rather than merely wrong.** `blocked_items` queries `status = 'blocked'`. Task status is only ever pending / in_progress / done, and nothing in the codebase writes 'blocked', so that number has been structurally incapable of being anything but 0 since it shipped. It printed a confident "0 Blocked", which reads as "nothing is stuck" — an assertion the data cannot support.

Decision (owner, 2026-08-06): leave it in place and render it STRUCK THROUGH rather than delete it, so the defect stays visible until it is fixed properly. Tasker does have a real blocked concept — flow dependencies, already computed by `unmetSourcesDeep` — so the eventual fix is repointing the query, not inventing a signal.

**Check for this class:** any metric that has only ever returned one value is a suspect. Nobody notices a number that is always zero, because zero is a plausible answer.

**Also fixed here:** the delta block was duplicated verbatim across `get_project_delta` and `post_project_update`, so every change had to be made twice — the same trap already recorded for the contract-gate logic. Now one `computeProjectDelta`. Merged duplicates (TDE-874) are reported separately, since a task filed and merged in-window counts as both an add and a completion while representing no work.

