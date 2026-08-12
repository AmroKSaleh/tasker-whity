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
# D1b Task 14 FIX (review round 2): mcp-tools.ps1 now writes this file
# WITHOUT a BOM (strict JSON.parse elsewhere rejects one). Without an
# explicit -Encoding here, Windows PowerShell 5.1's Get-Content falls back
# to the system codepage for a BOM-less file, silently mangling every
# non-ASCII character (an em dash round-tripped as "â€”") -- caught by this
# task's own new tool-level drift diff reporting a false "changed" for
# every tool whose description has one. -Encoding UTF8 makes the read
# explicit rather than relying on BOM sniffing.
$snap = Get-Content -Path $snapshot -Raw -Encoding UTF8

if ($live.Trim() -ne $snap.Trim()) {
    # D1b Task 14 FIX (review round 2): the brief's own acceptance bar is
    # "FAIL naming the drift" -- this used to satisfy that only via a manual
    # follow-up probe, not the check itself. Diff the two tool lists by name
    # (added/removed) and, for names present in both, by description/
    # inputSchema (a renamed property, a widened enum, a changed required
    # list) so the failure message says WHAT changed, not just THAT it did.
    $liveTools = $null
    $snapTools = $null
    try {
        $liveTools = $live | ConvertFrom-Json
        $snapTools = $snap | ConvertFrom-Json
    } catch {
        # Malformed JSON on either side -- fall through to the generic
        # message below rather than letting a parse error masquerade as
        # "could not run" (this IS drift; the transport returned something).
    }

    if ($null -ne $liveTools -and $null -ne $snapTools) {
        $liveByName = @{}
        foreach ($t in $liveTools) { $liveByName[$t.name] = $t }
        $snapByName = @{}
        foreach ($t in $snapTools) { $snapByName[$t.name] = $t }

        $added   = @($liveByName.Keys | Where-Object { -not $snapByName.ContainsKey($_) } | Sort-Object)
        $removed = @($snapByName.Keys | Where-Object { -not $liveByName.ContainsKey($_) } | Sort-Object)
        $changed = @(
            $liveByName.Keys | Where-Object { $snapByName.ContainsKey($_) } | Sort-Object | Where-Object {
                ($liveByName[$_] | ConvertTo-Json -Depth 12 -Compress) -ne
                ($snapByName[$_] | ConvertTo-Json -Depth 12 -Compress)
            }
        )

        if ($added.Count -gt 0)   { Write-Error "MCP tool surface DRIFTED: ADDED tool(s) not in the snapshot: $($added -join ', ')" -ErrorAction Continue }
        if ($removed.Count -gt 0) { Write-Error "MCP tool surface DRIFTED: MISSING tool(s) present in the snapshot but not live: $($removed -join ', ')" -ErrorAction Continue }
        if ($changed.Count -gt 0) { Write-Error "MCP tool surface DRIFTED: CHANGED tool(s) (description/inputSchema differs): $($changed -join ', ')" -ErrorAction Continue }
        if ($added.Count -eq 0 -and $removed.Count -eq 0 -and $changed.Count -eq 0) {
            # Only whitespace/ordering differs from the byte-level compare above.
            Write-Error 'MCP tool surface DRIFTED from docs/mcp-tool-surface.json (formatting/whitespace only -- no tool name or schema differs)' -ErrorAction Continue
        }
    } else {
        Write-Error 'MCP tool surface DRIFTED from docs/mcp-tool-surface.json (unable to parse one side as JSON to name the drift -- see raw output above)' -ErrorAction Continue
    }

    exit 1
}

Write-Host 'MCP tool surface matches snapshot'
exit 0
