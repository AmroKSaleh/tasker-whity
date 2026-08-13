# {mcp} Self-contained task context — enforcement approach (TDE-305)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Decision
Enforce self-contained task context via two lightweight layers (no hard gate):

1. **New `ASSISTANT_DIRECTIVES` entry** (`index.ts`) — injected into every session at init time. Tells the agent to write `detail` so a cold reader can act without the chat, session memory, or external notes. Covers all creation paths: direct `create_task`, `bootstrap_project` populate, flow task creation, `resolve_seed`.

2. **Updated `detail` parameter descriptions** in `create_task` and `resolve_seed` — inline nudge at the point of use. Specifies what "self-contained" means: goal/why, key decisions or open questions, pointers to files/KB/decisions, obvious next step.

## Why no hard gate
A hard gate (server-side rejection of sparse context) would block legitimate terse tasks and add latency. The directive + tool-description combo is advisory but consistent — every agent sees it on every session start and again when calling create_task. That's enough to shift the default behavior.

## What "self-contained" means in practice
- Goal/why of this specific task (not the project)
- Key decisions or open questions if any
- Pointers to load-bearing context (files, KB entries, past decisions)
- Obvious next step
- NOT a transcript dump — the minimum a cold reader needs to act
