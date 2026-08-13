---
id: TDE-96
title: Embed AI behavioral instructions in MCP server
status: done
priority: high
section: mcp-integrations
order: 20
updated_at: 2026-07-25T07:41:59.616Z
---

Return behavioral instructions automatically when AIs connect to the Tasker MCP, eliminating the need for users to manually create CLAUDE.md or .cursorrules files.

Implementation options:
1. Add a get_ai_instructions() MCP tool that returns the platform-agnostic primer
2. Include instruction metadata on each tool definition so agents learn best practices on-the-fly
3. Create an onboard_ai() endpoint that returns primer + setup instructions at connection time

This makes the MCP self-documenting — agents understand Tasker's conventions immediately without external setup.
