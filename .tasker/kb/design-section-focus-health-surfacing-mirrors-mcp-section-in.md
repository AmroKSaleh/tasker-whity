# design: Section focus health surfacing mirrors MCP section_insights client-side (TDE-122)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SectionContextSidebar.jsx now proactively surfaces section health (Needs Attention block + Group Balance bars + stat row), replacing the old raw text dump.

**Key decision:** `section_insights` and `analyze_section` (V2/supabase/functions/mcp/index.ts, ~line 4079/4128) are PURE DETERMINISTIC RULES — no LLM. They compute imbalance (>50% of workload), stale (pending >7 days), and backlog pressure (pending > in_progress) from the same tasks+groups data the web sidebar already receives as props. So "surface existing MCP insights" (the scope the user chose over building fresh web-side AI) meant mirroring those exact rules client-side — no new AI logic, no extra network call.

**Keep-in-sync gotcha:** the health thresholds now live in TWO places — the MCP edge function and `computeHealth()` in SectionContextSidebar.jsx. If you change the imbalance/stale/backlog thresholds in one, change the other or the agent view and web view of a section will disagree. Same class of mirrored-logic risk as the contract-gate logic.

**Why not call the MCP from the web app:** MCP tools are token-authed for AI agents; the web app authenticates via Supabase session and already holds the data, so recomputing the rules client-side is cheaper and avoids auth plumbing.

Positioning note: this respects "web app = inspector" — it presents insight, it doesn't run a new AI diagnostic in the browser.
