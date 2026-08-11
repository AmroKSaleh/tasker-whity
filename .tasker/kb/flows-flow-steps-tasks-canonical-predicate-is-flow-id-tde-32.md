# {flows} Flow steps ≠ tasks — canonical predicate is flow_id (TDE-320)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-320 makes a flow member a STEP, not a task: it disappears from project-level task surfaces and lives only on the Flows page. Shipped as PRESENTATION-ONLY (no schema change, reversible) — steps stay rows in `tasks` with section_id intact; delete_flow unlinks them and they reappear.

CANONICAL PREDICATE: a task "belongs to a flow" iff `flow_id IS NOT NULL` (matches the existing isFlowTask at index.ts ~line 404). NOT "has an I/O edge / is in a detected connected component." A task becomes a step when NAMED into a flow (name_flow), not the instant one edge is drawn — otherwise tasks vanish surprisingly mid-authoring.

THE GOTCHA (why this task existed): the web board and MCP DISAGREED. ProjectBoard.jsx built flowTaskIds from detectFlows(tasks) — hiding ANY task with an edge, named or not. MCP list_tasks hid NOTHING. So an unnamed-but-wired task vanished from the board yet showed in list_tasks. Fixed by unifying BOTH on flow_id: board is now `tasks.filter(t => !t.flow_id)` (dropped the detectFlows import), and MCP list_tasks adds `.is('flow_id', null)` by default.

THREE SURFACES filtered, all on flow_id, so counts reconcile: (1) MCP list_tasks — excludes by default; include_flow_steps:true is an EXPLICIT USER-ONLY override (description tells agents never to self-flip it). (2) MCP list_sections — the x/y open/total tally skips flow_id members. (3) Web board — boardTasks drives columns, Pulse %, filter counts, section x/y, "STANDALONE TASKS".

Templates need NO rework: instantiation still creates tasks + names the flow, so members get flow_id and are auto-excluded by the same filter.
