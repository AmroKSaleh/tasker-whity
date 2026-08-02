#Requires -Version 5.1
# Fetch whity-core at the pinned ref into host/.core (gitignored, never committed).
$ErrorActionPreference = 'Stop'

$hostDir = Split-Path -Parent $PSScriptRoot
$coreDir = Join-Path $hostDir '.core'
$ref     = (Get-Content (Join-Path $hostDir 'core.version') -Raw).Trim()
$repo    = 'https://github.com/AmroKSaleh/whity-core.git'

if (-not (Test-Path $coreDir)) {
    Write-Host "Cloning whity-core into $coreDir"
    git clone $repo $coreDir
}

Write-Host "Checking out pinned ref: $ref"
git -C $coreDir fetch --all --tags
git -C $coreDir checkout $ref

$envFile = Join-Path $hostDir '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $hostDir '.env.example') $envFile
    Write-Host "Created host/.env from .env.example"
}

Write-Host "Core ready at $coreDir"
