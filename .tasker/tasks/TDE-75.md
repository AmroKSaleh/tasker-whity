---
id: TDE-75
title: Use GitHub OAuth token for native GitHub functionality (replace separate PAT setup)
status: done
priority: medium
section: core-app
order: 11
updated_at: 2026-07-14T23:09:51.590Z
---

When a user signs in via GitHub OAuth, capture the provider token from Supabase auth (session.provider_token) and use it as the source of truth for GitHub access — eliminating the need for the user to separately paste a Personal Access Token.

Work involved:
- Request the right scopes at login time (likely "repo" for full repo access; "public_repo" if only public is needed). Update the signInWithOAuth call to include options.scopes.
- On successful auth, persist session.provider_token into user_settings.github_access_token so the existing MCP tools (github_list_repos, github_import_project, github_sync_issues) work transparently.
- Handle token refresh: Supabase doesn't auto-refresh GitHub provider tokens. May need to prompt re-auth when token is invalid (the existing 401 handling in mcp/index.ts already throws a "reconnect" error).
- Keep the PAT setup as a fallback for users who didn't sign in via GitHub.

Depends on: TDE-fbb70cbe (GitHub OAuth login).

Out of scope here: repo-picker UI on project creation — see separate task.
