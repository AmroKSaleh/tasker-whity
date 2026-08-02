#Requires -Version 5.1
# Fail loudly when the live derived MCP tool surface (Tasker's ping tools)
# drifts from the committed snapshot at docs/mcp-tool-surface.json.
#
# Kept as its own script file, rather than an inline `npm run` PowerShell
# one-liner, because nesting JSON-shaped npm script strings inside
# package.json inside a `powershell -Command "..."` invocation on Windows
# (where npm itself shells out via cmd.exe) requires multiple layers of quote
# escaping that broke in practice. A script file sidesteps all of that.
#
# Exit codes are deliberately distinguishable, because "the tool surface
# actually changed" and "the check could not run at all" are very different
# situations for whoever is reading CI output:
#   0 -> live surface matches the committed snapshot.
#   1 -> REAL drift: a live tool list was obtained and it differs from the
#        snapshot (e.g. a route's operationId was renamed).
#   2 -> the check could not be run at all — host down, MCP_ENABLED unset
#        (503), the tenant's mcp.enabled setting off (403), an expired/bad
#        token (JSON-RPC-level error, HTTP 200 -- see mcp-tools.ps1), or the
#        snapshot file itself missing. This is a setup/infrastructure
#        problem, not evidence that anyone renamed a tool.
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$hostDir   = Split-Path -Parent $scriptDir
$repoRoot  = Split-Path -Parent $hostDir
$snapshot  = Join-Path $repoRoot 'docs\mcp-tool-surface.json'

try {
    $live = & (Join-Path $scriptDir 'mcp-tools.ps1') | Out-String
}
catch {
    # NOTE: with $ErrorActionPreference = 'Stop' in scope, Write-Error itself
    # becomes a TERMINATING error and would abort the script before the
    # `exit 2` below ever ran (PowerShell then falls back to its own default
    # exit code, 1 -- indistinguishable from a real drift!). -ErrorAction
    # Continue forces this one call back to non-terminating so the explicit
    # exit code below is actually what gets returned. Caught and fixed by
    # observing exactly this collision empirically while testing this script.
    Write-Error "MCP tool surface check COULD NOT RUN (infrastructure/setup problem, NOT drift): $($_.Exception.Message)" -ErrorAction Continue
    exit 2
}

if (-not (Test-Path -Path $snapshot)) {
    Write-Error "MCP tool surface check COULD NOT RUN (infrastructure/setup problem, NOT drift): snapshot not found at $snapshot" -ErrorAction Continue
    exit 2
}
$snap = Get-Content -Path $snapshot -Raw

if ($live.Trim() -ne $snap.Trim()) {
    Write-Error 'MCP tool surface DRIFTED from docs/mcp-tool-surface.json' -ErrorAction Continue
    exit 1
}

Write-Host 'MCP tool surface matches snapshot'
exit 0
