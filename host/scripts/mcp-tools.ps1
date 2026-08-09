#Requires -Version 5.1
# Dump Tasker's derived MCP tools as a normalised, sorted JSON projection.
# Usage: mcp-tools.ps1            -> print to stdout
#        mcp-tools.ps1 -Write     -> overwrite docs/mcp-tool-surface.json
#
# Prerequisite (one-time per tenant/database): MCP must be enabled twice over
# before this script can reach a real tool list —
#   1. Infrastructure gate: host/.env must set MCP_ENABLED=true (see
#      host/.env.example). Without it, POST /mcp returns a bare 503 for every
#      caller, before auth is even checked.
#   2. Per-tenant opt-in: the admin's tenant must have the mcp.enabled=true
#      setting. This is a database row (tenant_settings), not a file. On a
#      fresh clone this is now applied automatically by
#      host/scripts/enable-tenant-mcp.php, run as part of the `bootstrap`
#      compose service (see host/docker-compose.yml) — `npm run host:up`
#      alone is enough. If that step ever fails (see its own header comment
#      for why it's non-fatal) or you are re-enabling MCP for a tenant that
#      predates it, fall back to the settings API manually:
#
#        POST /api/v1/login            (admin@example.com / INITIAL_ADMIN_PASSWORD)
#        PATCH /api/v1/settings        { "settings": { "mcp.enabled": "true" } }
#
#      See the README's dev-loop section for the exact commands.
param([switch]$Write)

$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir
$base     = 'http://localhost:8010'

# Prefer an explicit env var, then host/.env (the file that actually seeded the
# running host), then the original seed default. Reading host/.env matters: the
# admin password gets rotated there, and the seeder's ON CONFLICT DO NOTHING
# means a re-seed never updates an existing hash — so a stale 'admin123'
# fallback fails with a 401 that reads like a broken MCP surface rather than
# the credential problem it is.
$password = if ($env:INITIAL_ADMIN_PASSWORD) {
    $env:INITIAL_ADMIN_PASSWORD
} else {
    $envFile = Join-Path $hostDir '.env'
    $fromFile = if (Test-Path $envFile) {
        (Get-Content $envFile |
            Where-Object { $_ -match '^\s*INITIAL_ADMIN_PASSWORD\s*=' } |
            Select-Object -First 1) -replace '^\s*INITIAL_ADMIN_PASSWORD\s*=\s*', ''
    }
    if ($fromFile) { $fromFile.Trim() } else { 'admin123' }
}

# CsrfGuard rejects mutating requests without this header.
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }

# 1. Log in as a human user (cookie session). Routes are versioned: /api/v1/...
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri "$base/api/v1/login" -Method Post `
    -ContentType 'application/json' -Headers $csrf `
    -Body (@{ email = 'admin@example.com'; password = $password } | ConvertTo-Json) `
    -WebSession $session | Out-Null

# 2. Mint a short-lived MCP bearer token with that session.
$minted = Invoke-RestMethod -Uri "$base/api/v1/mcp/tokens" -Method Post `
    -ContentType 'application/json' -Headers $csrf `
    -Body (@{ name = 'tasker-surface-check'; scope = @('tools:call') } | ConvertTo-Json) `
    -WebSession $session

# The MCP transport itself is unversioned and bearer-authenticated.
$headers = @{ Authorization = "Bearer $($minted.token)" }

try {
    # 3. Initialize, then list tools, over the JSON-RPC transport at /mcp.
    # (Verified empirically: the initialize response carries no MCP-Session-Id
    # or similar header on this deployment, so there is nothing to thread
    # through to the tools/list call beyond the same bearer token.)
    $init = @{
        jsonrpc = '2.0'; id = 1; method = 'initialize'
        params  = @{
            protocolVersion = '2025-03-26'
            capabilities    = @{}
            clientInfo      = @{ name = 'tasker-surface-check'; version = '1.0' }
        }
    } | ConvertTo-Json -Depth 6

    $initResp = Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $init

    # IMPORTANT: only McpFeatureDisabledException (tenant opt-in off) and
    # McpRateLimitException map to a non-2xx HTTP status (403 / 429), which
    # Invoke-RestMethod would throw on by itself. UNAUTHENTICATED (missing,
    # invalid, or expired bearer token) is returned as HTTP 200 with a
    # JSON-RPC-level `error` object instead (verified empirically) — that
    # would otherwise sail straight through as a "successful" call with no
    # tools, indistinguishable from a real empty result. Surface it as a
    # genuine thrown error so callers (mcp-check.ps1) can tell "the check
    # could not run" apart from "the tool surface actually changed".
    if ($initResp.PSObject.Properties.Name -contains 'error') {
        throw "MCP initialize failed: [$($initResp.error.code)] $($initResp.error.message)"
    }

    $list = @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 5

    $response = Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $list

    if ($response.PSObject.Properties.Name -contains 'error') {
        throw "MCP tools/list failed: [$($response.error.code)] $($response.error.message)"
    }

    $taskerToolNames = @(
        'list_pings', 'create_ping', 'tag_ping',
        'list_projects', 'create_project', 'update_project', 'delete_project',
        'list_sections', 'create_section', 'update_section', 'delete_section',
        'list_groups', 'create_group', 'update_group', 'delete_group',
        'list_tasks', 'create_task', 'update_task', 'move_task', 'delete_task',
        'complete_task', 'uncomplete_task', 'pin_task', 'unpin_task', 'tag_task', 'get_ready_work',
        'list_milestones', 'add_milestone', 'complete_milestone', 'update_milestone', 'delete_milestone',
        'get_board',
        'get_task_discussion', 'set_task_discussion'
    )
    $tools = $response.result.tools |
        Where-Object { $taskerToolNames -contains $_.name } |
        Sort-Object name |
        ForEach-Object {
            [ordered]@{
                name        = $_.name
                description = $_.description
                inputSchema = $_.inputSchema
            }
        }

    $json = ConvertTo-Json @($tools) -Depth 12

    if ($Write) {
        $target = Join-Path $repoRoot 'docs\mcp-tool-surface.json'
        Set-Content -Path $target -Value $json -Encoding UTF8
        Write-Host "Wrote $target"
    } else {
        Write-Output $json
    }
}
finally {
    # Tokens are long-lived (90 days); revoke by jti so repeated runs do not
    # accumulate credentials. NOTE: this sub-API is versioned like every other
    # app route (verified empirically — the brief's unversioned
    # /api/mcp/tokens/{jti} 404s; the live route is /api/v1/mcp/tokens/{jti}).
    Invoke-RestMethod -Uri "$base/api/v1/mcp/tokens/$($minted.jti)" -Method Delete `
        -WebSession $session -ErrorAction SilentlyContinue | Out-Null
}
