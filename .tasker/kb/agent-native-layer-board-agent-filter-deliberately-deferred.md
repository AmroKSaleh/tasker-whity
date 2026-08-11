# Agent-Native Layer: board agent filter deliberately deferred (TDE-375)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-375 (agent identity & delegation) shipped actor threading, delegated_to, and "via {agent}" inspector attribution. The one remaining milestone — a board-level filter/group-by-agent view — was intentionally NOT built and the task was still marked done.

Why: with only one labeled agent (via agent_label on the API key) in use, a board filter by agent has ~zero utility — there's nothing to filter between. Building that infra now would be speculative.

When to revisit: once a second agent is actually labeled (e.g. Cursor alongside Claude Code), build the board-level agent filter then — not before.
