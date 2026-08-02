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
#      setting. This is a database row (tenant_settings), not a file, so a
#      fresh clone/fresh database needs it set once via the settings API:
#
#        POST /api/v1/login            (admin@example.com / INITIAL_ADMIN_PASSWORD)
#        PATCH /api/v1/settings        { "settings": { "mcp.enabled": "true" } }
#
#      See the README's dev-loop section for the exact commands. There is no
#      migration/seeder for this — it is a per-tenant, per-database setting,
#      same as any other tenant admin would flip from the Settings UI.
param([switch]$Write)

$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir
$base     = 'http://localhost:8010'

$password = if ($env:INITIAL_ADMIN_PASSWORD) { $env:INITIAL_ADMIN_PASSWORD } else { 'admin123' }

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

    Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $init | Out-Null

    $list = @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 5

    $response = Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $list

    $tools = $response.result.tools |
        Where-Object { $_.name -like '*ping*' } |
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
