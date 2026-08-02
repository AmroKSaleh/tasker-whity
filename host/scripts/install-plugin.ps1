#Requires -Version 5.1
# Deploy-copy the Tasker plugin into the host's plugins/ mount point.
$ErrorActionPreference = 'Stop'

$hostDir    = Split-Path -Parent $PSScriptRoot
$repoRoot   = Split-Path -Parent $hostDir
$source     = Join-Path $repoRoot 'plugin'
$target     = Join-Path $hostDir '.core\plugins\Tasker'

if (-not (Test-Path (Join-Path $hostDir '.core'))) {
    throw "host/.core is missing - run 'npm run core:fetch' first"
}

robocopy $source $target /MIR `
    /XD tests vendor stubs .phpunit.cache `
    /XF phpunit.xml phpstan.neon .gitattributes composer.lock | Out-Null

# robocopy exit codes below 8 are success
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

Write-Host "Plugin deployed to $target"
