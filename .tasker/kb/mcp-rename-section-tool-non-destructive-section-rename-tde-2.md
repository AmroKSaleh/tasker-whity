# {mcp} rename_section tool — non-destructive section rename (TDE-275)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-275 shipped: `rename_section(project_id, section_id, name)`.**

Closes the gap where renaming a section via MCP required the destructive create→move-all-tasks→delete dance. Now a one-call non-destructive name change; tasks/groups/ordering untouched.

Mirrors the exact ownership pattern of delete_section: resolveProject (user-scoped) → fetch section by id + project_id → update name. Schema placed right after create_section; handler right after the create_section case in mcp/index.ts. Same shape as the existing rename_group tool.

Deployed live 2026-06-25. New tool → needs a CC restart to appear in an existing session's toolset.
