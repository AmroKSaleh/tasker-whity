# Tech Stack

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Tech Stack

## Frontend
React 19.2, Vite 8, Tailwind CSS 3.4, Zustand 5 (state), React Router v7.15. Hosted on Netlify. Mobile deployment via Capacitor.

## Backend
Supabase (Postgres, Auth, Edge Functions). All queries use the JS client with RLS. Edge Functions run on Deno.

## AI
Gemini API for project generation (discussProject, generateProjectStructure). MCP server for AI client integrations (Claude Code, Cursor, Windsurf).
*Note: In-app AI relies on @anthropic-ai/sdk.*

## Key Libraries
- @supabase/supabase-js 2.105 - DB + auth client
- @anthropic-ai/sdk - AI layer
- xlsx - spreadsheet export
- react-router-dom - routing
- zustand - global state

## Current Surface Area
- **Core:** Tasks, sections, groups, flows, milestones.
- **Organization:** Environments, orgs, RBAC (in progress).
- **Integrations:** Connectors (Google Tasks).
- **Architecture:** Local Mode (two-way repo sync).
