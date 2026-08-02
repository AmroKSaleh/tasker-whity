#Requires -Version 5.1
# Fail loudly when the live derived MCP tool surface (Tasker's ping tools)
# drifts from the committed snapshot at docs/mcp-tool-surface.json.
#
# Kept as its own script file, rather than an inline `npm run` PowerShell
# one-liner, because nesting JSON-shaped npm script strings inside
# package.json inside a `powershell -Command "..."` invocation on Windows
# (where npm itself shells out via cmd.exe) requires multiple layers of quote
# escaping that broke in practice. A script file sidesteps all of that.
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$hostDir   = Split-Path -Parent $scriptDir
$repoRoot  = Split-Path -Parent $hostDir
$snapshot  = Join-Path $repoRoot 'docs\mcp-tool-surface.json'

$live = & (Join-Path $scriptDir 'mcp-tools.ps1') | Out-String
$snap = Get-Content -Path $snapshot -Raw

if ($live.Trim() -ne $snap.Trim()) {
    Write-Error 'MCP tool surface drifted from docs/mcp-tool-surface.json'
    exit 1
}

Write-Host 'MCP tool surface matches snapshot'
