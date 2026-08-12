#Requires -Version 5.1
# Run PHPStan over the plugin inside the same php:8.4-cli container CI uses.
# A dedicated script file (rather than an inline `%cd%`-based npm script) so
# this does not depend on npm's script-shell defaulting to cmd.exe:
# $PSScriptRoot resolves the repo root regardless of which shell invoked
# `npm run plugin:stan`, or from what working directory.
$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir

# --memory-limit=512M is REQUIRED, not a tuning knob (whole-branch review
# finding B1): php:8.4-cli ships memory_limit=128M, and analysing this plugin
# at level 6 exceeds it — PHPStan aborts with "process crashed because it
# reached configured PHP memory limit: 128M" and exit 1. PHPStan has no
# config-file equivalent (the limit is CLI-only, phpstan.neon cannot set it),
# so it has to live at every invocation site: here and in the CI workflow's
# PHPStan step. Every "PHPStan clean" claim before this flag existed came from
# a manual `-d memory_limit=512M` that was in nobody's repo.
docker run --rm -v "${repoRoot}:/repo" -w /repo/plugin php:8.4-cli php vendor/bin/phpstan analyse --memory-limit=512M
exit $LASTEXITCODE
