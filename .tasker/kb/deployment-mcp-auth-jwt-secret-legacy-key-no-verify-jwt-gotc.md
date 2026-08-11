# {deployment} MCP: AUTH_JWT_SECRET legacy key & --no-verify-jwt gotcha

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

When deploying the `mcp` Supabase Edge Function or managing its authentication keys, there is a critical "gotcha" involving Supabase JWT secrets:

### 1. Edge Function Deployments MUST bypass JWT Verification
Always deploy the `mcp` edge function with the `--no-verify-jwt` flag. 
**Command:** `npx supabase functions deploy --no-verify-jwt mcp` (or `mcp --no-verify-jwt`)

If you forget this flag, Supabase's API Gateway will aggressively reject any incoming request that lacks a Supabase-signed JWT with an HTTP 401 Unauthorized *before it even reaches our code*. Tasker uses its own bearer token (`tsk_...`) and OAuth logic in the Edge Function, so it MUST handle its own auth. Forgetting this flag causes a silent, total outage of all MCP tool calls. A `scripts/smoke-test-mcp.ts` has been added to test this post-deployment.

### 2. AUTH_JWT_SECRET and the Legacy-vs-Signing-Key Gotcha
The `getScopedClient()` function in the MCP relies on `Deno.env.get('AUTH_JWT_SECRET')` to sign a short-lived `HS256` token for interacting with the database.
- You **CANNOT** name this environment variable `SUPABASE_AUTH_JWT_SECRET` because the Supabase CLI structurally refuses to let you set environment variables with the `SUPABASE_` prefix (it is reserved).
- This secret **MUST** be wired to the project's **Legacy HS256 JWT Secret** (found in Supabase Settings → API → JWT Keys → Legacy JWT Secret tab).
- Do **NOT** wire it to the "Key ID" shown on the main JWT Signing Keys tab. Those new keys use asymmetric ECC/RSA cryptography and cannot be used to sign a verifiable `HS256` token for the local scoped client logic.
