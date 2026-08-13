# KB: TDE-254 read-loop — titles index in get_task + get_kb_entries

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-254 (dynamic-KB read loop) shipped — option 3 (titles index + selective pull).

**get_task** now injects a lightweight **KB TITLES INDEX**: active (non-archived) project KB entries as `• [id] (ai?) title`, capped at 60, with an instruction to pull only the few relevant via get_kb_entries (no whole-KB dump). Added after the flow-KB injection block in the get_task case.

**New MCP tool `get_kb_entries(project_id, ids?, titles?)`** — fetches FULL content for selected entries. `ids` (preferred, from the index) + `titles` (ilike partial match); results deduped by id; excludes archived. The selective-read companion to get_knowledge_base (which dumps everything). This is the `get_kb_entry` the Brand DNA Drift case study asked for.

**Why it matters:** closes the write-auto/read-manual gap from TDE-184 — every task now surfaces what knowledge exists, and agents pull only what's relevant cheaply.

**Unblocks TDE-261 Phase 2 (TDE-268):** KB-enriched bar assembly can now scan the titles index → get_kb_entries the topic-matched ones → merge into the bar. The title format from the dynamic-KB rule (`[Area]: [learning]`) makes the scan reliable.

Both halves verified live against the deployed endpoint. Minor cosmetic: get_kb_entries (like get_knowledge_base) emits one empty block from the `[header, '', ...]` join — harmless.
