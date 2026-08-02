#Requires -Version 5.1
# Install the plugin's PHP dependencies inside the same php:8.4-cli container
# CI uses (.github/workflows/ci.yml), so a clean clone needs Docker only --
# no PHP or Composer on the host.
#
# Mounts the REPO ROOT (not just plugin/) and sets the working directory to
# /repo/plugin, exactly like plugin-test.ps1 / plugin-stan.ps1. This matters:
# plugin/composer.json declares a path repository at ../host/.core/sdk, and
# composer materialises plugin/vendor/whity/plugin-sdk as a symlink into that
# path. The symlink only resolves if host/.core is visible in the same
# container alongside plugin/ -- mounting plugin/ alone breaks it.
$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir

if (-not (Test-Path (Join-Path $hostDir '.core'))) {
    throw "host/.core is missing - run 'npm run core:fetch' first"
}

# Mirrors ci.yml's plugin job step-for-step: the php:8.4-cli image ships
# curl but not git, unzip, or Composer itself, so all three are installed
# fresh in the ephemeral container before `composer install` can run.
$installScript = @(
    'apt-get update -qq && apt-get install -y -qq git unzip'
    'curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer'
    'composer install --no-interaction --no-progress'
) -join ' && '

docker run --rm -v "${repoRoot}:/repo" -w /repo/plugin php:8.4-cli sh -c $installScript
if ($LASTEXITCODE -ne 0) { throw "plugin dependency install failed with exit code $LASTEXITCODE" }
