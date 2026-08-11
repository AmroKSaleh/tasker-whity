# {flows} (ai) Flows UI vs MCP split — decided (TDE-191)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Decision: Hybrid — authoring = MCP, everything else = UI

**Flow authoring** (creating tasks, wiring I/O edges, deriving contracts via `build_new_flow`) stays MCP-conversational. This is judgment-heavy structured work the agent handles well.

**Everything after authoring** is UI:
- View flow DAG (FlowGraph — read-only, clickable)
- View/edit contract rules (FlowTaskPanel + ContractEditor — fully editable in browser)
- Bless contracts (FlowTaskPanel — "Bless" button per contract)
- Flow name / short ID editing (FlowsPage header)
- Gate trust badge (FlowCard — read-only)

**Why:** The split maps cleanly to the two user modes — design-time (agent-led) vs. review/correction-time (browser). Forcing users into MCP to tweak a single rule or bless a contract would be friction with no benefit.

**Do not add a UI flow-authoring wizard** — it would duplicate the MCP interview with lower quality (no agent reasoning, no contract derivation, no pushback on vague rules).
