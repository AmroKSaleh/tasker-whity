# php:8.4-cli (the base image CI's plugin job and this local script both use)
# ships only pdo_sqlite. TenantIsolationOuTest needs a REAL pdo_pgsql
# connection to prove OuScopeResolver's `= ANY(:scope)` traversal, which
# SQLite cannot execute. Layering the extension onto the same base image
# (rather than switching to a different image) keeps everything else about
# the plugin's PHP environment identical to CI.
#
# Built and tagged once by plugin-test.ps1; Docker's build cache makes every
# subsequent `npm run plugin:test` a no-op rebuild (no repeated apt/network
# cost) as long as this file doesn't change.
FROM php:8.4-cli

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev \
    && docker-php-ext-install pdo_pgsql \
    && rm -rf /var/lib/apt/lists/*
