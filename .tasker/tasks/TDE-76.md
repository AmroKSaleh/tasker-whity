---
id: TDE-76
title: Repo picker in New Project flow (for GitHub-connected users)
status: done
priority: medium
section: core-app
order: 12
updated_at: 2026-07-14T23:09:51.590Z
---

When a user creates a new project and they're connected to GitHub (either via OAuth login or a saved PAT), present their repos as a selectable list. Picking a repo creates a project linked to that repo and triggers issue import (same flow as the existing github_import_project MCP tool, but from the UI instead of MCP).

UI:
- New Project modal grows a section: "Import from GitHub" — shows repo list with search/filter.
- Optional: also let user create a blank project (the current default).
- Picking a repo: pre-fill project name from repo name; show count of open issues that would be imported; confirm.

Backend:
- Reuse the GitHub fetch path that already exists in supabase/functions/mcp/index.ts (githubFetch + fetchAllIssues). May want to lift it into a shared edge function so the frontend can call it without going through MCP.

Depends on: TDE-9e191a21 (native GitHub functionality via OAuth) — so the user can actually list their repos without setting up a PAT.
