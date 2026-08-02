#Requires -Version 5.1
# Run PHPStan over the plugin inside the same php:8.4-cli container CI uses.
# A dedicated script file (rather than an inline `%cd%`-based npm script) so
# this does not depend on npm's script-shell defaulting to cmd.exe:
# $PSScriptRoot resolves the repo root regardless of which shell invoked
# `npm run plugin:stan`, or from what working directory.
$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir

docker run --rm -v "${repoRoot}:/repo" -w /repo/plugin php:8.4-cli php vendor/bin/phpstan analyse
exit $LASTEXITCODE
