# {flows} (ai) Guide Mode — executor attribute + guide_flow/advance_guide (TDE-281)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## What shipped (TDE-281)

**DB** (`20260625120000_add_task_executor.sql`):
- `tasks.executor` TEXT NOT NULL DEFAULT 'agent' CHECK IN ('agent','user','external') — who runs this step
- `tasks.human_guidance` TEXT — human-facing step instructions for guide mode (distinct from `detail` which is AI-facing)
- `flows.guide_cursor` INTEGER — the flow_step ordinal the guide is currently paused at (null = not active)

**MCP tools added**: `guide_flow`, `advance_guide`

**MCP tools updated**: `create_task` (executor + human_guidance in schema + INSERT), `update_task` (executor + human_guidance in allowed list), `run_flow` (executor badge per step, hybrid protocol), `build_new_flow` (ask executor per step, persist human_guidance)

**Frontend**: `FlowStepList.jsx` shows USER/EXTERNAL badges (accent/amber color) on non-agent steps; expands to show human_guidance under "GUIDE INSTRUCTIONS" kicker. `useFlows.js` includes executor + human_guidance in TASK_FIELDS.

## Key design decisions

- **executor is per-task**, not per-flow-type — a single flow can be hybrid (some agent steps, some user/external)
- **human_guidance is distinct from detail** — detail is AI-facing context, human_guidance is what the user literally needs to do
- **guide_cursor on flows** — makes guide mode resumable across sessions; updated by guide_flow (on enter) and advance_guide (on step complete)
- **advance_guide requires evidence** — a URL, screenshot desc, or confirmation. Stored as output.artifact on the task before marking done.
- **Agent role in guide = COACH + VERIFIER**, not executor — explained in guide_flow output
- **AGENT badges suppressed in UI** — only USER/EXTERNAL show badges to avoid visual noise on all-agent flows

## How to use

1. When building a flow (`build_new_flow`), set executor per step and write human_guidance for user/external steps
2. When running a hybrid flow (`run_flow`), the protocol tells you when to switch to `guide_flow`
3. `guide_flow(flow_id)` → returns current human step + coaching context, sets guide_cursor
4. User works the step; agent coaches
5. `advance_guide(flow_id, evidence)` → stores evidence, marks step done, advances cursor, tells you what's next

