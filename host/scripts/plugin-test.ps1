#Requires -Version 5.1
# Run the plugin's PHPUnit suite inside the same php:8.4-cli container CI
# uses, plus pdo_pgsql layered on top (see phpunit-pgsql.Dockerfile) so
# TenantIsolationOuTest can reach a real Postgres when npm run host:up is
# running locally. A dedicated script file (rather than an inline
# `%cd%`-based npm script) so this does not depend on npm's script-shell
# defaulting to cmd.exe: $PSScriptRoot resolves the repo root regardless of
# which shell invoked `npm run plugin:test`, or from what working directory.
$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir

# Cached by Docker's build cache: a no-op after the first run as long as
# phpunit-pgsql.Dockerfile is unchanged, so this does not add per-run cost.
docker build -q -t tasker-plugin-phpunit:8.4 -f "$PSScriptRoot/phpunit-pgsql.Dockerfile" "$PSScriptRoot" | Out-Null

# TenantIsolationOuTest defaults to the disposable `tasker_test` database
# (never the live `tasker` one — an earlier default that wiped real dev data).
# That database does not exist on a fresh machine, and its absence makes 62
# Postgres-backed tests skip *silently*: the run still prints OK, just with
# half the suite gone. Create it here so a developer with the host up gets the
# real signal by default rather than a green one that means less than it looks.
# Host down: createdb fails harmlessly and those tests skip, which is correct.
$pgRunning = (docker ps --filter 'name=tasker_postgres' --filter 'status=running' --format '{{.Names}}' 2>$null)
if ($pgRunning) {
    docker exec tasker_postgres createdb -U tasker tasker_test 2>$null | Out-Null
}

docker run --rm -v "${repoRoot}:/repo" -w /repo/plugin tasker-plugin-phpunit:8.4 php vendor/bin/phpunit
exit $LASTEXITCODE
