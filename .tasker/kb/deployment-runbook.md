# Deployment Runbook

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Deployment Runbook

## Frontend (Netlify)
`
cd V2/app
npx netlify-cli deploy --prod --dir=dist
`
Vite builds to dist/, Netlify CLI uploads. No Docker required. Env vars set in Netlify dashboard.

## MCP Edge Function (Supabase)
`
SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy mcp --project-ref rzjhmipbamyvpwlkfvxx --no-verify-jwt
`
The `--no-verify-jwt` flag is required - the function handles its own auth. Without it all requests get 401 at the gateway.

**Important Environment Variables for Auth Hardening:**
The MCP function uses `jose` to mint short-lived custom JWTs for Row-Level Security (RLS) enforcement. It expects the following variables to be set in the edge function environment:
- `SUPABASE_AUTH_JWT_SECRET` (usually auto-injected by Supabase)
- `SUPABASE_ANON_KEY` (usually auto-injected by Supabase)

If they are ever missing, set them manually using:
`supabase secrets set SUPABASE_AUTH_JWT_SECRET=<your-jwt-secret> SUPABASE_ANON_KEY=<your-anon-key> --project-ref rzjhmipbamyvpwlkfvxx`

## Database Migrations
Use `npx supabase db query --linked --file migration.sql` to run SQL against the linked project. Write migration files without BOM (use UTF-8 no-BOM encoding).
