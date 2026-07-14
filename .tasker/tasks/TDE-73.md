---
id: TDE-73
title: Add GitHub OAuth login to the sign-in flow
status: done
priority: high
section: core-app
order: 10
updated_at: 2026-07-14T23:09:51.590Z
---

Add a "Continue with GitHub" button on the LoginPage alongside the existing Google OAuth. Same Supabase pattern: supabase.auth.signInWithOAuth({ provider: 'github' }).

Work split (most of the work is config, not code):
- GitHub: create an OAuth App at github.com/settings/developers — set the Authorization callback URL to https://rzjhmipbamyvpwlkfvxx.supabase.co/auth/v1/callback. Grab the Client ID + generate a Client Secret.
- Supabase Dashboard → Auth → Providers → enable GitHub, paste Client ID + Client Secret, save.
- Frontend: add a GitHub button to LoginPage.jsx mirroring the existing Google handler.

Out of scope for this task (keep separate):
- Unifying with the existing github_access_token PAT integration used for issue syncing. That's a bigger refactor. The OAuth login token has limited scopes by default and would need additional scope requests (repo) and persistence handling.
