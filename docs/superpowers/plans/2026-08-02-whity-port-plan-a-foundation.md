# Tasker on whity-core — Plan A: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `tasker-whity` monorepo with Tasker's own whity-core host, a loadable `Tasker` plugin, and one trivial entity driven all the way through — migration → tenant-scoped route → derived MCP tool → SPA fetch under cookie auth — so every seam in the port is proven before real schema work begins.

**Architecture:** A monorepo with three parts. `host/` fetches whity-core at a pinned ref into a gitignored `.core/` and runs it under Docker (FrankenPHP + Postgres + Caddy) on its own ports. `plugin/` is a distributable composer package depending only on `whity/plugin-sdk`, deploy-copied into `host/.core/plugins/Tasker/`. `app/` is the Vite SPA, proxying `/api` to the host in dev so the `SameSite=Lax` cookie behaves identically in dev and production.

**Tech Stack:** PHP 8.4, FrankenPHP, PostgreSQL 15, Caddy, Docker Compose, `whity/plugin-sdk` ^1.9, PHPUnit 10, PHPStan 1.10, React 19 + Vite, Vitest, Node 20+.

## Global Constraints

- Every plugin table carries `tenant_id INTEGER NOT NULL`. Every SELECT/UPDATE/DELETE on it binds an explicit parameterised `tenant_id` predicate. No exceptions without a `@tenant-guard-ignore: <reason>` comment.
- The plugin depends on `whity/plugin-sdk` **only** — never on `whity-core`. Host classes (`\Whity\app()`, `\Whity\Database\Database`, `\Whity\Core\Tenant\TenantContext`) are runtime seams, resolved at request time and stubbed for PHPStan.
- API handlers receive `int $tenantId` as an argument. Only `TaskerPlugin`'s route methods touch `TenantContext`. This keeps handlers host-free and unit-testable.
- Table prefix is `tasker_`. Permission slugs use `resource:action` notation matching `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/` — **exactly one colon**. Multi-word resources use an underscore (`tasker_ping:view`), never a second colon (`tasker:ping:view`), which the loader rejects by silently dropping the route with only a logged warning.
- Every route declares an explicit `schema.operationId` — it becomes the MCP tool name.
- `host/.core/` is gitignored and never committed. Real plugins are never committed into whity-core.
- Ports: `8010` host API, `5433` Postgres, `5174` Vite dev. Compose project name `tasker`.
- Migration DDL uses `DEFAULT (NOW())` (parenthesised) so it runs on both PostgreSQL and the in-memory SQLite used by the conformance kit.
- SDK constraint: `^1.9`.

**Deviation from spec §13:** the spec's definition of done names `make dev`. `make` is not reliably present on Windows, so the canonical entry points are **npm scripts** in the root `package.json` (`npm run host:up`, `npm run dev`, …), with a `Makefile` shipped as a thin alias for anyone who has `make`. Both paths do the same thing.

**Prerequisites:** Docker Desktop running, Node 20+, Git. No local PHP needed — PHP runs in containers.

## Verified host contract (established during Task 2 — treat as fact, do not re-derive)

These were confirmed empirically against the running host and against `host/.core/public/index.php`. Earlier drafts of this plan got them wrong; these supersede any `/api/…` path written elsewhere in this document.

- **Routes are versioned.** The router is built as `new Router('/v1')`, and `register()` injects `/v1` after `/api`. So a plugin route *declared* as `/api/tasker/pings` is *served* at **`/api/v1/tasker/pings`**. Declare without `/v1`; call with it.
- **Four routes are unversioned** (`registerUnversioned`): `GET /api/health`, `GET /api/version`, `GET /api/openapi.json`, and `POST|GET /mcp`. Note the OpenAPI document is at `/api/openapi.json`, and the MCP transport is at `/mcp` — outside `/api` entirely.
- **Mutating requests are CSRF-guarded.** `CsrfGuard` rejects them with 403 `{"error":"Cross-site request rejected"}` unless the request carries **`X-Requested-With: XMLHttpRequest`**. `POST /api/v1/login` with that header and the seeded `admin@example.com` / `admin123` returns 200. Every API client in this plan — including the SPA's `client.js` — must send it.
- **MCP is a per-tenant opt-in.** `Dispatcher` calls a `tenantMcpEnabled` closure and raises `McpFeatureDisabledException` when the caller's tenant has not enabled MCP. An unauthenticated `POST /mcp` currently returns 503. Task 5 must enable MCP for the tenant and authenticate with a bearer token before `tools/list` will answer.

---

### Task 1: Repo scaffold and host stack

**Files:**
- Create: `tasker-whity/.gitignore`
- Create: `tasker-whity/README.md`
- Create: `tasker-whity/package.json`
- Create: `tasker-whity/Makefile`
- Create: `tasker-whity/host/core.version`
- Create: `tasker-whity/host/.env.example`
- Create: `tasker-whity/host/docker-compose.yml`
- Create: `tasker-whity/host/Caddyfile`
- Create: `tasker-whity/host/scripts/fetch-core.ps1`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a running host reachable at `http://localhost:8010/api/health`; `host/.core/` containing a whity-core checkout at the pinned ref; npm scripts `host:up`, `host:down`, `core:fetch`.

- [ ] **Step 1: Create the repository and directory skeleton**

```powershell
New-Item -ItemType Directory -Force C:\Projects\tasker-whity | Out-Null
Set-Location C:\Projects\tasker-whity
git init
New-Item -ItemType Directory -Force app, plugin, host\scripts, docs | Out-Null
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
# whity-core is fetched at a pinned ref, never committed
host/.core/

# env
host/.env
.env
.env.local

# node
node_modules/
app/node_modules/
app/dist/

# php
plugin/vendor/
plugin/.phpunit.cache/
plugin/composer.lock
```

- [ ] **Step 3: Pin the core version**

Create `host/core.version` with a single line naming the whity-core ref to fetch. Use `main` initially; replace with a commit SHA once the first green run exists so upgrades are explicit.

```text
main
```

- [ ] **Step 4: Write `host/.env.example`**

```dotenv
# Tasker's own whity-core host. Ports deliberately differ from any other
# whity deployment on this machine so the two never collide.
APP_ENV=development

DB_HOST=postgres
DB_PORT=5432
DB_NAME=tasker
DB_USER=tasker
DB_PASSWORD=tasker_dev

JWT_SECRET=dev-only-secret-change-me-at-least-32-chars
ENCRYPTION_KEY=dev-only-encryption-key-change-me-32ch

CORS_ALLOWED_ORIGINS=http://localhost:5174

FRANKENPHP_WORKERS=4
MAX_REQUESTS=500
WORKER_MEMORY_LIMIT_MB=128

INITIAL_ADMIN_PASSWORD=admin123
INITIAL_USER_PASSWORD=user123
```

- [ ] **Step 5: Write `host/docker-compose.yml`**

```yaml
name: tasker

services:
  postgres:
    image: postgres:15
    container_name: tasker_postgres
    environment:
      POSTGRES_DB: ${DB_NAME:-tasker}
      POSTGRES_USER: ${DB_USER:-tasker}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-tasker_dev}
    ports:
      - "5433:5432"
    volumes:
      - tasker_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-tasker} -d ${DB_NAME:-tasker}"]
      interval: 5s
      timeout: 5s
      retries: 20

  frankenphp:
    build:
      context: ./.core
      dockerfile: Dockerfile
    image: tasker-core:dev
    container_name: tasker_frankenphp
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env
    environment:
      # Verified against whity-core's own compose file: the container
      # listens on :80, the Caddyfile lives at /etc/frankenphp/Caddyfile,
      # and these four variables are consumed by that Caddyfile.
      CADDY_GLOBAL_OPTIONS: "auto_https off"
      SERVER_NAME: ":80"
      SERVER_ROOT: "public/"
      FRANKENPHP_WORKERS: ${FRANKENPHP_WORKERS:-4}
      FRANKENPHP_TIMEOUT: ${FRANKENPHP_TIMEOUT:-60s}
    ports:
      - "8010:80"
    volumes:
      - ./.core:/app
      - ./Caddyfile:/etc/frankenphp/Caddyfile
      - ../app/dist:/app/public/spa

volumes:
  tasker_pgdata:
```

Four details here are load-bearing and were verified against `host/.core/docker-compose.yml` rather than assumed:

- The container listens on **:80**, so the mapping is `8010:80` — not `8010:8000`.
- The Caddyfile mounts at **`/etc/frankenphp/Caddyfile`** — not `/etc/caddy/Caddyfile`.
- `SERVER_NAME`, `SERVER_ROOT`, `CADDY_GLOBAL_OPTIONS`, and the two `FRANKENPHP_*` variables are read by the Caddyfile; omitting them breaks startup.
- `../app/dist` must exist before the stack starts, or Docker creates it as a root-owned empty directory. Task 1 Step 9a creates it.

- [ ] **Step 6: Write `host/Caddyfile`**

Caddy serves the built SPA at `/` and hands the API paths to the PHP worker, which is what makes the cookie flow same-origin in production.

**This file is a derivative of whity-core's own `Caddyfile`, not a replacement for it.** The global `frankenphp { worker … }` block is what puts FrankenPHP into persistent-worker mode — the platform's entire performance premise. Dropping it silently downgrades the host to classic per-request PHP. Diff this against `host/.core/Caddyfile` after every core upgrade.

```caddyfile
{
	# Caddy global options — preserved verbatim from whity-core's Caddyfile.
	skip_install_trust
	{$CADDY_GLOBAL_OPTIONS}

	frankenphp {
		# The persistent worker pool. Do not remove.
		worker /app/public/index.php {$FRANKENPHP_WORKERS:8}

		# Max wait time in queue before 504 Gateway Timeout
		max_wait_time {$FRANKENPHP_TIMEOUT:60s}
	}
}

{$SERVER_NAME:localhost} {
	encode zstd gzip

	# Everything the backend owns. /mcp is the MCP JSON-RPC transport and
	# lives OUTSIDE /api — routing it to the SPA would break every agent.
	@backend path /api/* /mcp /mcp/* /openapi.json
	handle @backend {
		root * /app/{$SERVER_ROOT:public/}
		php_server
	}

	# Everything else is the SPA, with history-API fallback.
	handle {
		root * /app/public/spa
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 7: Write `host/scripts/fetch-core.ps1`**

```powershell
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
```

- [ ] **Step 8: Write the root `package.json`**

```json
{
  "name": "tasker-whity",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "core:fetch": "powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/fetch-core.ps1",
    "host:up": "npm run core:fetch && docker compose --env-file host/.env -f host/docker-compose.yml up -d",
    "host:down": "docker compose -f host/docker-compose.yml down",
    "host:logs": "docker compose -f host/docker-compose.yml logs -f frankenphp",
    "host:migrate": "docker exec tasker_frankenphp php public/index.php migrate run",
    "host:seed": "docker exec tasker_frankenphp php public/index.php seed"
  }
}
```

- [ ] **Step 9: Write the `Makefile` alias**

```makefile
.PHONY: host-up host-down migrate seed dev

host-up:
	npm run host:up

host-down:
	npm run host:down

migrate:
	npm run host:migrate

seed:
	npm run host:seed

dev:
	npm run dev
```

- [ ] **Step 9a: Create the SPA mount target before Docker does**

`host/docker-compose.yml` bind-mounts `../app/dist`. If that path does not exist when the stack starts, Docker silently creates it as an empty directory owned by root, which later breaks `vite build` writing into it. Create it first, with a tracked placeholder so a fresh clone has it too.

```powershell
New-Item -ItemType Directory -Force app\dist | Out-Null
Set-Content -Path app\dist\.gitkeep -Value '' -Encoding ascii
```

Add a negation to `.gitignore` so the placeholder survives the `app/dist/` ignore rule:

```gitignore
app/dist/
!app/dist/.gitkeep
```

- [ ] **Step 10: Bring the stack up**

Run:

```powershell
npm run host:up
```

Expected: `fetch-core.ps1` clones whity-core and checks out the pinned ref, then Docker builds and starts `tasker_postgres` and `tasker_frankenphp`. First run takes several minutes for the image build.

- [ ] **Step 11: Migrate, seed, and verify health**

Run:

```powershell
npm run host:migrate
npm run host:seed
Invoke-RestMethod http://localhost:8010/api/health | ConvertTo-Json -Depth 5
```

Expected: HTTP 200 with a JSON body reporting healthy worker, memory, and database status. A 503 means degraded — check `npm run host:logs` before continuing. Do not proceed past this step until health is 200.

- [ ] **Step 12: Write `README.md`**

```markdown
# Tasker on whity-core

Tasker's board, re-founded on [whity-core](https://github.com/AmroKSaleh/whity-core).
A separate product from KeyHub: its own host, its own database, its own tenants.

## Layout

- `app/` — Vite React SPA
- `plugin/` — `whity/plugin-tasker`, an SDK-only composer package
- `host/` — Tasker's own whity-core deployment (core fetched at a pinned ref into `.core/`, never committed)
- `docs/` — specs and plans

## Dev loop

```powershell
npm run host:up        # fetch pinned core, start Postgres + FrankenPHP
npm run host:migrate
npm run host:seed
npm run plugin:install # deploy-copy plugin into the host, then migrate
npm run dev            # Vite on :5174, proxying /api to :8010
```

Host API: <http://localhost:8010/api> · Health: <http://localhost:8010/api/health>

Seeded dev accounts come from `host/.env` (`INITIAL_ADMIN_PASSWORD`).

## Upgrading core

Edit `host/core.version`, then `npm run core:fetch && npm run host:up`.
```

- [ ] **Step 13: Commit**

```bash
git add .gitignore README.md package.json Makefile host/
git commit -m "chore: scaffold repo and Tasker's own whity-core host"
```

---

### Task 2: Plugin package that the host loads

**Files:**
- Create: `plugin/composer.json`
- Create: `plugin/TaskerPlugin.php`
- Create: `plugin/phpunit.xml`
- Create: `plugin/phpstan.neon`
- Create: `plugin/stubs/whity-host.stub.php`
- Create: `plugin/.gitattributes`
- Test: `plugin/tests/TaskerPluginTest.php`
- Create: `host/scripts/install-plugin.ps1`
- Modify: `package.json` (add `plugin:install`, `plugin:test`, `plugin:stan`)

**Interfaces:**
- Consumes: the running host from Task 1.
- Produces: class `Tasker\TaskerPlugin` with `getName(): string`, `getVersion(): string`, `getSdkConstraint(): string`, `getCoreConstraint(): string`, `getPluginDependencies(): array`, `getRoutes(): array`, `getPermissions(): array`, `getHooks(): array`, `getMigrations(): array`. Later tasks append to `getRoutes()`, `getPermissions()`, and `getMigrations()`.

- [ ] **Step 1: Write `plugin/composer.json`**

The SDK is consumed through a path repository pointing into the fetched core, so the plugin never depends on whity-core itself.

```json
{
  "name": "whity/plugin-tasker",
  "description": "Tasker board plugin for Whity-based hosts",
  "type": "library",
  "version": "0.1.0",
  "license": "AGPL-3.0-only",
  "repositories": [
    { "type": "path", "url": "../host/.core/sdk" }
  ],
  "require": {
    "php": ">=8.4",
    "whity/plugin-sdk": "^1.9"
  },
  "require-dev": {
    "phpunit/phpunit": "^10.0",
    "phpstan/phpstan": "^1.10"
  },
  "autoload": {
    "psr-4": { "Tasker\\": "" },
    "exclude-from-classmap": ["tests/", "stubs/"]
  },
  "autoload-dev": {
    "psr-4": { "Tasker\\Tests\\": "tests/" }
  }
}
```

- [ ] **Step 2: Write `plugin/.gitattributes`**

Dev-only files are export-ignored so `git archive` produces exactly the deploy set.

```gitattributes
/tests            export-ignore
/stubs            export-ignore
/phpunit.xml      export-ignore
/phpstan.neon     export-ignore
/.gitattributes   export-ignore
```

- [ ] **Step 3: Write `plugin/stubs/whity-host.stub.php`**

These are the runtime seams the host provides. They exist only so PHPStan can analyse the plugin standalone; they are never loaded at runtime and never deployed.

```php
<?php

declare(strict_types=1);

namespace Whity {
    /**
     * Resolve a service from the host container.
     *
     * @param string $id Service id (usually a class-string).
     * @return object The resolved service.
     */
    function app(string $id): object
    {
    }
}

namespace Whity\Database {
    class Database
    {
        public function getPdo(): \PDO
        {
        }
    }
}

namespace Whity\Core\Tenant {
    class TenantContext
    {
        public static function getTenantId(): ?int
        {
        }
    }
}
```

- [ ] **Step 4: Write `plugin/phpunit.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
         bootstrap="vendor/autoload.php"
         cacheDirectory=".phpunit.cache"
         colors="true"
         failOnWarning="true"
         failOnRisky="true">
  <testsuites>
    <testsuite name="Tasker">
      <directory>tests</directory>
    </testsuite>
  </testsuites>
</phpunit>
```

- [ ] **Step 5: Write `plugin/phpstan.neon`**

```neon
parameters:
    level: 6
    paths:
        - .
    excludePaths:
        - vendor
        - tests
        - stubs
    bootstrapFiles:
        - stubs/whity-host.stub.php
```

- [ ] **Step 6: Write the failing test**

Create `plugin/tests/TaskerPluginTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PHPUnit\Framework\TestCase;
use Tasker\TaskerPlugin;
use Whity\Sdk\PluginInterface;
use Whity\Sdk\PluginRequirementsInterface;

final class TaskerPluginTest extends TestCase
{
    public function testImplementsTheSdkContracts(): void
    {
        $plugin = new TaskerPlugin();

        self::assertInstanceOf(PluginInterface::class, $plugin);
        self::assertInstanceOf(PluginRequirementsInterface::class, $plugin);
    }

    public function testIdentifiesItselfAsTasker(): void
    {
        self::assertSame('Tasker', (new TaskerPlugin())->getName());
    }

    public function testRequiresSdkNineOrLater(): void
    {
        self::assertSame('^1.9', (new TaskerPlugin())->getSdkConstraint());
    }

    public function testDeclaresNoPluginDependencies(): void
    {
        self::assertSame([], (new TaskerPlugin())->getPluginDependencies());
    }
}
```

- [ ] **Step 7: Install dependencies and run the test to verify it fails**

Run:

```powershell
docker run --rm -v "${PWD}\plugin:/app" -v "${PWD}\host\.core\sdk:/sdk" -w /app composer:2 composer install
docker run --rm -v "${PWD}\plugin:/app" -w /app php:8.4-cli php vendor/bin/phpunit
```

Expected: FAIL — `Class "Tasker\TaskerPlugin" not found`.

Note: the path repository resolves `../host/.core/sdk` from the plugin directory. If composer cannot see it because the container only mounts `plugin/`, mount the repo root instead and use `-w /app/plugin`.

- [ ] **Step 8: Write the minimal plugin class**

Create `plugin/TaskerPlugin.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker;

use Whity\Sdk\PluginInterface;
use Whity\Sdk\PluginRequirementsInterface;

/**
 * Tasker — a kanban board with milestones, focus mode, and an agent-facing
 * MCP surface, packaged as a Whity plugin.
 *
 * Depends on whity/plugin-sdk only. The host seams are resolved at request
 * time: the shared Database service from the \Whity container, and the
 * caller's tenant from TenantContext. Handlers never touch either — route
 * methods on this class resolve them and pass plain values down, which keeps
 * the handlers unit-testable against a bare PDO.
 */
final class TaskerPlugin implements PluginInterface, PluginRequirementsInterface
{
    public function getName(): string
    {
        return 'Tasker';
    }

    public function getVersion(): string
    {
        return '0.1.0';
    }

    public function getSdkConstraint(): string
    {
        return '^1.9';
    }

    public function getCoreConstraint(): string
    {
        return '';
    }

    /**
     * @return list<string>
     */
    public function getPluginDependencies(): array
    {
        return [];
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function getRoutes(): array
    {
        return [];
    }

    /**
     * @return list<string>
     */
    public function getPermissions(): array
    {
        return [];
    }

    /**
     * @return array<string, mixed>
     */
    public function getHooks(): array
    {
        return [];
    }

    /**
     * @return list<class-string>
     */
    public function getMigrations(): array
    {
        return [];
    }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run:

```powershell
docker run --rm -v "${PWD}\plugin:/app" -w /app php:8.4-cli php vendor/bin/phpunit
```

Expected: PASS, 4 tests.

- [ ] **Step 10: Write `host/scripts/install-plugin.ps1`**

Deploy-copies the plugin into the host, excluding dev-only files, honouring whity's rule that real plugins are never committed to core.

```powershell
#Requires -Version 5.1
# Deploy-copy the Tasker plugin into the host's plugins/ mount point.
$ErrorActionPreference = 'Stop'

$hostDir    = Split-Path -Parent $PSScriptRoot
$repoRoot   = Split-Path -Parent $hostDir
$source     = Join-Path $repoRoot 'plugin'
$target     = Join-Path $hostDir '.core\plugins\Tasker'

if (-not (Test-Path (Join-Path $hostDir '.core'))) {
    throw "host/.core is missing — run 'npm run core:fetch' first"
}

robocopy $source $target /MIR `
    /XD tests vendor stubs .phpunit.cache `
    /XF phpunit.xml phpstan.neon .gitattributes composer.lock | Out-Null

# robocopy exit codes below 8 are success
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

Write-Host "Plugin deployed to $target"
```

- [ ] **Step 11: Add npm scripts**

Add to the root `package.json` `scripts` block:

```json
"plugin:install": "powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/install-plugin.ps1 && npm run host:migrate",
"plugin:test": "docker run --rm -v \"%cd%/plugin:/app\" -w /app php:8.4-cli php vendor/bin/phpunit",
"plugin:stan": "docker run --rm -v \"%cd%/plugin:/app\" -w /app php:8.4-cli php vendor/bin/phpstan analyse"
```

- [ ] **Step 12: Deploy the plugin and verify the host loads it**

Run:

```powershell
npm run plugin:install
Invoke-RestMethod http://localhost:8010/api/plugins | ConvertTo-Json -Depth 5
```

Expected: the response lists a plugin named `Tasker` with lifecycle state `active`. If it shows `failed` or `quarantined`, the SDK constraint or namespace is wrong — the directory name `Tasker` must match the `Tasker\` namespace prefix.

- [ ] **Step 13: Commit**

```bash
git add plugin/ host/scripts/install-plugin.ps1 package.json
git commit -m "feat: Tasker plugin skeleton loading in the host"
```

---

### Task 3: The ping table and tenant-isolation conformance

A deliberately trivial entity. Its only job is to prove the migration path, the tenant registry, and the conformance kit before the real seven tables are written in Plan B.

**Files:**
- Create: `plugin/Migrations/CreateTaskerPingTable.php`
- Test: `plugin/tests/TenantIsolationTest.php`
- Modify: `plugin/TaskerPlugin.php` (register the migration)

**Interfaces:**
- Consumes: `Tasker\TaskerPlugin` from Task 2.
- Produces: table `tasker_pings (id SERIAL PK, tenant_id INTEGER NOT NULL, label VARCHAR(255) NOT NULL, created_at TIMESTAMP)`; class `Tasker\Migrations\CreateTaskerPingTable` implementing `Whity\Sdk\MigrationInterface`.

- [ ] **Step 1: Write the failing conformance test**

Create `plugin/tests/TenantIsolationTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests;

use Tasker\Migrations\CreateTaskerPingTable;
use Whity\Sdk\Tenant\TenantTableRegistry;
use Whity\Sdk\Testing\TenantIsolationConformanceTestCase;

/**
 * Proves Tasker's tenant isolation with the SDK conformance kit: every table
 * the plugin creates declares tenant_id, every query against a tenant-owned
 * table binds a tenant_id predicate, and the columns physically exist after
 * the migrations run on a real engine.
 */
final class TenantIsolationTest extends TenantIsolationConformanceTestCase
{
    protected function tenantTableRegistry(): TenantTableRegistry
    {
        return TenantTableRegistry::for([
            'tasker_pings' => 'Connectivity probe rows are per-tenant.',
        ]);
    }

    protected function migrationsDirectory(): string
    {
        return dirname(__DIR__) . '/Migrations';
    }

    /**
     * @return list<string>
     */
    protected function handlerSourceDirectories(): array
    {
        return [dirname(__DIR__) . '/Api'];
    }

    /**
     * @return list<\Whity\Sdk\MigrationInterface>
     */
    protected function schemaMigrations(): array
    {
        return [new CreateTaskerPingTable()];
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerPingTable" not found`.

(`TenantTableRegistry::for(array $tenantOwned, array $global = [])` is the SDK's documented convenience factory for plugins naming only their own tables — verified against SDK 1.9.)

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerPingTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Creates the connectivity-probe table used to prove the plugin's data path
 * end to end. Replaced by the real board tables in Plan B.
 *
 * DEFAULT (NOW()) is parenthesised so the same DDL runs on PostgreSQL and on
 * the in-memory SQLite the conformance kit applies it against.
 */
final class CreateTaskerPingTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_pings (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                label VARCHAR(255) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (NOW())
            )
        ');

        $pdo->exec(
            'CREATE INDEX IF NOT EXISTS idx_tasker_pings_tenant_id ON tasker_pings(tenant_id)'
        );
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_pings');
    }
}
```

- [ ] **Step 4: Register the migration with the plugin**

In `plugin/TaskerPlugin.php`, add the import and replace `getMigrations()`:

```php
use Tasker\Migrations\CreateTaskerPingTable;
```

```php
    /**
     * @return list<class-string>
     */
    public function getMigrations(): array
    {
        return [
            CreateTaskerPingTable::class,
        ];
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS. The conformance case contributes three tests — migration linter, predicate scanner, and the real-engine column check. The predicate scanner passes trivially right now because `Api/` does not exist yet; Task 4 makes it meaningful.

- [ ] **Step 6: Apply the migration to the host database**

Run:

```powershell
npm run plugin:install
docker exec tasker_postgres psql -U tasker -d tasker -c "\d tasker_pings"
```

Expected: the table description lists `id`, `tenant_id`, `label`, `created_at`.

- [ ] **Step 7: Commit**

```bash
git add plugin/Migrations plugin/tests/TenantIsolationTest.php plugin/TaskerPlugin.php
git commit -m "feat: tasker_pings table with tenant-isolation conformance"
```

---

### Task 4: Tenant-scoped ping API with permissions

**Files:**
- Create: `plugin/Api/PingApiHandler.php`
- Create: `plugin/Migrations/GrantTaskerPingPermissions.php`
- Test: `plugin/tests/Api/PingApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php` (routes, permissions, migration list)

**Interfaces:**
- Consumes: `tasker_pings` from Task 3.
- Produces: `Tasker\Api\PingApiHandler` with `list(int $tenantId): Response` and `create(int $tenantId, string $body): Response`; routes `GET /api/tasker/pings` (operationId `list_pings`, permission `tasker:ping:view`) and `POST /api/tasker/pings` (operationId `create_ping`, permission `tasker:ping:manage`); JSON shape `{ data: [{ id, tenantId, label, createdAt }] }`.

- [ ] **Step 1: Write the failing handler test**

Create `plugin/tests/Api/PingApiHandlerTest.php`. Note the handler takes `int $tenantId` and a raw JSON body string — no host classes — so it runs against a bare in-memory SQLite PDO.

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\PingApiHandler;
use Tasker\Migrations\CreateTaskerPingTable;

final class PingApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private PingApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        (new CreateTaskerPingTable())->up($this->pdo);

        $this->handler = new PingApiHandler($this->pdo);
    }

    public function testCreateStampsTheCallersTenant(): void
    {
        $response = $this->handler->create(7, json_encode(['label' => 'hello']));

        self::assertSame(201, $response->getStatusCode());

        $row = $this->pdo->query('SELECT tenant_id, label FROM tasker_pings')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame('hello', $row['label']);
    }

    public function testListReturnsOnlyTheCallersTenantRows(): void
    {
        $this->handler->create(7, json_encode(['label' => 'mine']));
        $this->handler->create(9, json_encode(['label' => 'theirs']));

        $payload = json_decode($this->handler->list(7)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('mine', $payload['data'][0]['label']);
        self::assertSame(7, $payload['data'][0]['tenantId']);
    }

    public function testCreateRejectsAnEmptyLabel(): void
    {
        $response = $this->handler->create(7, json_encode(['label' => '   ']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCreateRejectsAMalformedBody(): void
    {
        $response = $this->handler->create(7, 'not json');

        self::assertSame(400, $response->getStatusCode());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Api\PingApiHandler" not found`.

(`Response::getStatusCode(): int` and `Response::getBody(): string` are both verified present in SDK 1.9 at `sdk/src/Http/Response.php`.)

- [ ] **Step 3: Write the handler**

Create `plugin/Api/PingApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD over tasker_pings.
 *
 * Takes the resolved tenant id as an argument rather than reading
 * TenantContext, so the handler depends on nothing but PDO and the SDK's
 * Response — which is what lets the test suite run it against in-memory
 * SQLite with no host present.
 *
 * Every statement binds an explicit, parameterised tenant_id predicate.
 */
final class PingApiHandler
{
    private const MAX_LABEL_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/pings — the caller's pings, newest first.
     */
    public function list(int $tenantId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'SELECT id, tenant_id, label, created_at FROM tasker_pings
                 WHERE tenant_id = :tenant_id
                 ORDER BY id DESC'
            );
            $stmt->execute([':tenant_id' => $tenantId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicPing'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch pings', 500);
        }
    }

    /**
     * POST /api/tasker/pings — create a ping in the caller's tenant.
     *
     * @param string $body Raw JSON request body.
     */
    public function create(int $tenantId, string $body): Response
    {
        $label = $this->validatedLabel($body);
        if ($label === null) {
            return Response::error(
                'label must be a non-empty string of at most ' . self::MAX_LABEL_LENGTH . ' characters',
                400
            );
        }

        try {
            // The tenant is stamped from the caller's context — never from input.
            $stmt = $this->db->prepare(
                'INSERT INTO tasker_pings (tenant_id, label, created_at) VALUES (:tenant_id, :label, NOW())'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':label' => $label]);

            $id = (int) $this->db->lastInsertId();

            $find = $this->db->prepare(
                'SELECT id, tenant_id, label, created_at FROM tasker_pings
                 WHERE id = :id AND tenant_id = :tenant_id'
            );
            $find->execute([':id' => $id, ':tenant_id' => $tenantId]);
            $row = $find->fetch(PDO::FETCH_ASSOC);

            if (!is_array($row)) {
                return Response::error('Failed to create ping', 500);
            }

            return Response::json(['data' => $this->toPublicPing($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create ping', 500);
        }
    }

    /**
     * @return string|null The valid label, or null when missing/invalid.
     */
    private function validatedLabel(string $body): ?string
    {
        $decoded = json_decode($body, true);
        $label = is_array($decoded) ? ($decoded['label'] ?? null) : null;

        if (!is_string($label) || trim($label) === '' || mb_strlen($label) > self::MAX_LABEL_LENGTH) {
            return null;
        }

        return trim($label);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicPing(array $row): array
    {
        return [
            'id' => (int) ($row['id'] ?? 0),
            'tenantId' => (int) ($row['tenant_id'] ?? 0),
            'label' => (string) ($row['label'] ?? ''),
            'createdAt' => isset($row['created_at']) ? (string) $row['created_at'] : null,
        ];
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npm run plugin:test
```

Expected: PASS. If `NOW()` fails under SQLite in the INSERT, change it to `CURRENT_TIMESTAMP`, which both engines accept in an expression position.

- [ ] **Step 5: Write the permission-grant migration**

Create `plugin/Migrations/GrantTaskerPingPermissions.php`. This seeds the permission catalogue and attaches the permissions to the `admin` role so the endpoints work on a fresh install without manual SQL.

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Seeds Tasker's ping permissions and grants them to every admin role.
 *
 * Plugin permissions are registered in the in-memory registry at load time,
 * but RBAC grants are persisted rows — without this migration no role holds
 * them and even the platform admin gets 403s.
 *
 * Idempotent and additive. down() removes the admin grants, then only those
 * catalogue rows this migration created (identified by the description
 * marker) that no remaining grant references.
 *
 * Column names verified against the host schema and the core grant-migration
 * pattern: permissions(name, description, created_at) with UNIQUE(name);
 * role_permissions(role_id, permission_id, created_at) with a composite
 * unique key. Note the column is `name`, not `slug`.
 */
final class GrantTaskerPingPermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker:ping:view', 'tasker:ping:manage'];

    private const DESCRIPTION_PREFIX = 'Tasker plugin permission';

    public function up(\PDO $pdo): void
    {
        $insertPermission = $pdo->prepare(
            'INSERT INTO permissions (name, description, created_at)
             VALUES (:name, :description, CURRENT_TIMESTAMP)
             ON CONFLICT (name) DO NOTHING'
        );

        foreach (self::PERMISSIONS as $permission) {
            $insertPermission->execute([
                ':name' => $permission,
                ':description' => self::DESCRIPTION_PREFIX . ' (' . $permission . ')',
            ]);
        }

        // Grant to every admin role; ids resolve in the engine, so a
        // partially-seeded database is a no-op rather than an error.
        $grant = $pdo->prepare(
            "INSERT INTO role_permissions (role_id, permission_id, created_at)
             SELECT r.id, p.id, CURRENT_TIMESTAMP
             FROM roles r, permissions p
             WHERE r.name = 'admin' AND p.name = :permission
             ON CONFLICT (role_id, permission_id) DO NOTHING"
        );

        foreach (self::PERMISSIONS as $permission) {
            $grant->execute([':permission' => $permission]);
        }
    }

    public function down(\PDO $pdo): void
    {
        $dropGrants = $pdo->prepare(
            "DELETE FROM role_permissions
             WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
               AND permission_id IN (SELECT id FROM permissions WHERE name = :permission)"
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropGrants->execute([':permission' => $permission]);
        }

        $dropCatalogue = $pdo->prepare(
            'DELETE FROM permissions
             WHERE name = :permission
               AND description LIKE :marker
               AND NOT EXISTS (
                   SELECT 1 FROM role_permissions rp
                   WHERE rp.permission_id = permissions.id
               )'
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropCatalogue->execute([
                ':permission' => $permission,
                ':marker' => self::DESCRIPTION_PREFIX . '%',
            ]);
        }
    }
}
```

This mirrors `host/.core/plugins/HelloWorld/Migrations/GrantGreetingsPermissionsToAdmin.php`, which is the sanctioned reference for the pattern. If the migration errors on an unknown column, confirm the live schema and correct it here:

```powershell
docker exec tasker_postgres psql -U tasker -d tasker -c "\d permissions"
docker exec tasker_postgres psql -U tasker -d tasker -c "\d role_permissions"
```

- [ ] **Step 6: Wire routes, permissions, and the new migration into the plugin**

In `plugin/TaskerPlugin.php`, add the imports:

```php
use Tasker\Api\PingApiHandler;
use Tasker\Migrations\GrantTaskerPingPermissions;
use Whity\Sdk\Http\Request;
use Whity\Sdk\Http\Response;
```

Replace `getRoutes()`, `getPermissions()`, and `getMigrations()`:

```php
    /**
     * @return list<array<string, mixed>>
     */
    public function getRoutes(): array
    {
        return [
            [
                'method' => 'GET',
                'path' => '/api/tasker/pings',
                'handler' => [$this, 'listPings'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker:ping:view',
                'schema' => [
                    // operationId IS the derived MCP tool name. Never omit it.
                    'operationId' => 'list_pings',
                    'summary' => 'List the tenant\'s connectivity pings',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => 'TaskerPingListResponse',
                        403 => ['description' => 'Missing tasker:ping:view or unresolved tenant context'],
                    ],
                    'components' => self::pingComponents(),
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/pings',
                'handler' => [$this, 'createPing'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker:ping:manage',
                'schema' => [
                    'operationId' => 'create_ping',
                    'summary' => 'Create a connectivity ping in the caller\'s tenant',
                    'tags' => ['tasker'],
                    'request' => 'TaskerPingCreateRequest',
                    'responses' => [
                        201 => 'TaskerPingResponse',
                        400 => ['description' => 'label missing, empty, or longer than 255 characters'],
                        403 => ['description' => 'Missing tasker:ping:manage or unresolved tenant context'],
                    ],
                    'components' => self::pingComponents(),
                ],
            ],
        ];
    }

    /**
     * OpenAPI component schemas published by the ping resource.
     *
     * @return array<string, array<string, mixed>>
     */
    private static function pingComponents(): array
    {
        return [
            'TaskerPing' => [
                'type' => 'object',
                'required' => ['id', 'tenantId', 'label', 'createdAt'],
                'properties' => [
                    'id' => ['type' => 'integer'],
                    'tenantId' => ['type' => 'integer'],
                    'label' => ['type' => 'string'],
                    'createdAt' => ['type' => 'string', 'nullable' => true],
                ],
            ],
            'TaskerPingListResponse' => [
                'type' => 'object',
                'required' => ['data'],
                'properties' => [
                    'data' => [
                        'type' => 'array',
                        'items' => ['$ref' => '#/components/schemas/TaskerPing'],
                    ],
                ],
            ],
            'TaskerPingResponse' => [
                'type' => 'object',
                'required' => ['data'],
                'properties' => [
                    'data' => ['$ref' => '#/components/schemas/TaskerPing'],
                ],
            ],
            'TaskerPingCreateRequest' => [
                'type' => 'object',
                'required' => ['label'],
                'properties' => [
                    'label' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 255],
                ],
            ],
        ];
    }

    /**
     * @return list<string>
     */
    public function getPermissions(): array
    {
        return [
            'tasker:ping:view',
            'tasker:ping:manage',
        ];
    }

    /**
     * @return list<class-string>
     */
    public function getMigrations(): array
    {
        return [
            CreateTaskerPingTable::class,
            GrantTaskerPingPermissions::class,
        ];
    }
```

Then add the route methods and the two host seams at the end of the class:

```php
    /**
     * GET /api/tasker/pings
     *
     * @param array<string, string> $params
     */
    public function listPings(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new PingApiHandler($this->resolvePdo()))->list($tenantId);
    }

    /**
     * POST /api/tasker/pings
     *
     * @param array<string, string> $params
     */
    public function createPing(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new PingApiHandler($this->resolvePdo()))->create($tenantId, $request->getBody());
    }

    /**
     * The caller's resolved tenant, or null when context is unresolved.
     */
    private function requireTenantId(): ?int
    {
        return \Whity\Core\Tenant\TenantContext::getTenantId();
    }

    /**
     * Resolve a live PDO from the host container.
     *
     * Resolved per request, never cached, so the host's connection
     * self-healing and recycling are honoured.
     */
    private function resolvePdo(): \PDO
    {
        $database = \Whity\app(\Whity\Database\Database::class);
        if (!$database instanceof \Whity\Database\Database) {
            throw new \RuntimeException('The host did not register the shared Database service');
        }

        return $database->getPdo();
    }
```

- [ ] **Step 7: Run tests and static analysis**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PHPUnit PASS (all suites, including the predicate scanner now that `Api/` has real queries), PHPStan clean at level 6.

- [ ] **Step 8: Verify the endpoints against the running host**

Run:

```powershell
npm run plugin:install

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }

Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post `
  -ContentType 'application/json' -Headers $csrf `
  -Body (@{ email = 'admin@example.com'; password = 'admin123' } | ConvertTo-Json) `
  -WebSession $session | Out-Null

Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/pings -Method Post `
  -ContentType 'application/json' -Headers $csrf `
  -Body (@{ label = 'first light' } | ConvertTo-Json) -WebSession $session

Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/pings -WebSession $session | ConvertTo-Json -Depth 5
```

Expected: the POST returns the created ping with an integer `tenantId`; the GET returns `{ data: [ { label: 'first light', ... } ] }`.

Mind the split between declaration and call, per the verified host contract above: the route is **declared** as `/api/tasker/pings` in `getRoutes()` and **served** at `/api/v1/tasker/pings`, because the router injects `/v1`. Do not put `/v1` in the declaration. The `X-Requested-With` header is mandatory on both POSTs — without it `CsrfGuard` answers 403 before the handler runs.

- [ ] **Step 9: Commit**

```bash
git add plugin/Api plugin/Migrations/GrantTaskerPingPermissions.php plugin/tests/Api plugin/TaskerPlugin.php
git commit -m "feat: tenant-scoped ping API with RBAC-gated routes"
```

---

### Task 5: Prove MCP tool derivation and lock the surface

**Files:**
- Create: `host/scripts/mcp-tools.ps1`
- Create: `docs/mcp-tool-surface.json`
- Modify: `package.json` (add `mcp:tools`, `mcp:check`)

**Interfaces:**
- Consumes: the routes from Task 4.
- Produces: `docs/mcp-tool-surface.json`, a committed snapshot of Tasker's derived MCP tools; `npm run mcp:check` fails when the live surface drifts from it.

- [ ] **Step 1: Regenerate the OpenAPI spec and confirm the operationIds landed**

The served spec must describe the deployment's actual routes, so regeneration is a deploy step after installing a plugin.

Run:

```powershell
docker exec tasker_frankenphp php public/index.php generate:openapi
$spec = Invoke-RestMethod http://localhost:8010/api/openapi.json
$spec.paths.PSObject.Properties | Where-Object { $_.Name -like '*tasker*' } |
  ForEach-Object { "$($_.Name): " + (($_.Value.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value.operationId)" }) -join ', ') }
```

The spec is served at `/api/openapi.json` (unversioned). The path key it lists may be either the declared or the versioned form — the assertion that matters is the operationId values, not the key.

Expected: the `get` and `post` operations carry `operationId` values `list_pings` and `create_ping`. If they show derived names like `getApiTaskerPings` instead, the `schema.operationId` key is in the wrong place — it belongs inside `schema`, not at the route's top level.

- [ ] **Step 2: Write `host/scripts/mcp-tools.ps1`**

Four verified facts drive this script. The MCP transport is `POST /mcp` — unversioned, outside `/api`. It authenticates with `Authorization: Bearer <mcp-token>`, **not** the session cookie. That token is minted by `POST /api/v1/mcp/tokens` using a normal logged-in session, returning `{ jti, token, name, scope, expires_at }` with `token` shown only once. And **MCP is a per-tenant opt-in**: `Dispatcher` consults a `tenantMcpEnabled` closure and raises `McpFeatureDisabledException` when the caller's tenant has not enabled it.

**Enable MCP for the tenant before anything else in this task.** An unauthenticated `POST /mcp` currently returns 503, and a bearer token alone will not fix that if the tenant flag is off. Find the switch — check the admin UI at `/admin/mcp-tools`, the settings registry (`host/.core/src/Core/Settings/SettingsRegistry.php`), and `host/.core/docs/wiki/MCP-Operator-Runbook.md` — enable it, and record in your report exactly how you did it, because the answer belongs in the README's dev loop. If MCP genuinely cannot be enabled in this deployment, stop and report BLOCKED rather than skipping the task's gate.

```powershell
#Requires -Version 5.1
# Dump Tasker's derived MCP tools as a normalised, sorted JSON projection.
# Usage: mcp-tools.ps1            -> print to stdout
#        mcp-tools.ps1 -Write     -> overwrite docs/mcp-tool-surface.json
param([switch]$Write)

$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir
$base     = 'http://localhost:8010'

$password = if ($env:INITIAL_ADMIN_PASSWORD) { $env:INITIAL_ADMIN_PASSWORD } else { 'admin123' }

# CsrfGuard rejects mutating requests without this header.
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }

# 1. Log in as a human user (cookie session). Routes are versioned: /api/v1/...
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri "$base/api/v1/login" -Method Post `
    -ContentType 'application/json' -Headers $csrf `
    -Body (@{ email = 'admin@example.com'; password = $password } | ConvertTo-Json) `
    -WebSession $session | Out-Null

# 2. Mint a short-lived MCP bearer token with that session.
$minted = Invoke-RestMethod -Uri "$base/api/v1/mcp/tokens" -Method Post `
    -ContentType 'application/json' -Headers $csrf `
    -Body (@{ name = 'tasker-surface-check'; scope = @('tools:call') } | ConvertTo-Json) `
    -WebSession $session

# The MCP transport itself is unversioned and bearer-authenticated.
$headers = @{ Authorization = "Bearer $($minted.token)" }

try {
    # 3. Initialize, then list tools, over the JSON-RPC transport at /mcp.
    $init = @{
        jsonrpc = '2.0'; id = 1; method = 'initialize'
        params  = @{
            protocolVersion = '2025-03-26'
            capabilities    = @{}
            clientInfo      = @{ name = 'tasker-surface-check'; version = '1.0' }
        }
    } | ConvertTo-Json -Depth 6

    Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $init | Out-Null

    $list = @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 5

    $response = Invoke-RestMethod -Uri "$base/mcp" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body $list

    $tools = $response.result.tools |
        Where-Object { $_.name -like '*ping*' } |
        Sort-Object name |
        ForEach-Object {
            [ordered]@{
                name        = $_.name
                description = $_.description
                inputSchema = $_.inputSchema
            }
        }

    $json = ConvertTo-Json @($tools) -Depth 12

    if ($Write) {
        $target = Join-Path $repoRoot 'docs\mcp-tool-surface.json'
        Set-Content -Path $target -Value $json -Encoding UTF8
        Write-Host "Wrote $target"
    } else {
        Write-Output $json
    }
}
finally {
    # Tokens are long-lived (90 days); revoke by jti so repeated runs
    # do not accumulate credentials.
    Invoke-RestMethod -Uri "$base/api/mcp/tokens/$($minted.jti)" -Method Delete `
        -WebSession $session -ErrorAction SilentlyContinue | Out-Null
}
```

If minting 403s, the seeded admin lacks `mcp:tokens:manage`; grant it in the host admin UI at `/admin/mcp-tools` or via the roles API before continuing.

- [ ] **Step 3: Confirm the tools derive with the intended names**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1
```

Expected: two entries, `create_ping` and `list_pings`, each with an `inputSchema`. `create_ping`'s schema must contain a required `label` string property, proving the request component was merged into the tool's input schema.

- [ ] **Step 4: Write the snapshot**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1 -Write
```

- [ ] **Step 5: Add the drift check**

Add to the root `package.json` `scripts` block:

```json
"mcp:tools": "powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1",
"mcp:check": "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$live = & host/scripts/mcp-tools.ps1; $snap = Get-Content docs/mcp-tool-surface.json -Raw; if ($live.Trim() -ne $snap.Trim()) { Write-Error 'MCP tool surface drifted from docs/mcp-tool-surface.json'; exit 1 } else { Write-Host 'MCP tool surface matches snapshot' }\""
```

- [ ] **Step 6: Verify the check passes, then verify it can fail**

Run:

```powershell
npm run mcp:check
```

Expected: `MCP tool surface matches snapshot`.

Now prove the guard actually bites. Temporarily change `'operationId' => 'list_pings'` to `'list_tasker_pings'` in `plugin/TaskerPlugin.php`, then:

```powershell
npm run plugin:install
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:check
```

Expected: FAIL with the drift error. Revert the operationId, reinstall, regenerate, and confirm `mcp:check` passes again before committing.

- [ ] **Step 7: Commit**

```bash
git add host/scripts/mcp-tools.ps1 docs/mcp-tool-surface.json package.json
git commit -m "test: lock the derived MCP tool surface with a drift check"
```

---

### Task 6: SPA on the host with cookie auth

**Files:**
- Create: `app/` (copied from `c:\Projects\tasker\V2\app`)
- Modify: `app/vite.config.js`
- Modify: `app/package.json`
- Create: `app/src/api/client.js`
- Create: `app/src/api/pings.js`
- Create: `app/src/dev/PingCheck.jsx`
- Modify: `app/src/App.jsx`
- Test: `app/src/api/client.test.js`
- Create: `app/vitest.config.js`
- Modify: `package.json` (add `dev`, `app:test`)

**Interfaces:**
- Consumes: the ping endpoints from Task 4.
- Produces: `apiFetch(path, options)` returning parsed JSON and throwing `ApiError { status, message }`; `listPings()` and `createPing(label)`; a `/dev/ping` route rendering the round trip.

- [ ] **Step 1: Copy the SPA into the fork**

The whole app comes across; Plan C does the de-Supabase work. Here we only add the seam and prove auth.

```powershell
robocopy C:\Projects\tasker\V2\app C:\Projects\tasker-whity\app /E /XD node_modules dist | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed" }
$global:LASTEXITCODE = 0
Set-Location C:\Projects\tasker-whity\app
npm install
```

- [ ] **Step 2: Point Vite at the host and fix the port**

Edit `app/vite.config.js` so the dev server proxies `/api` to the host. This is what makes dev same-origin, so the `SameSite=Lax` cookie behaves exactly as it will in production.

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8010',
        changeOrigin: false,
      },
    },
  },
})
```

Keep any other options already present in the file — merge, do not overwrite wholesale.

- [ ] **Step 3: Write the failing client test**

Create `app/src/api/client.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('apiFetch', () => {
  it('sends cookies and returns the parsed body', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 1 }] }),
    })

    const result = await apiFetch('/api/v1/tasker/pings')

    expect(result).toEqual({ data: [{ id: 1 }] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/tasker/pings',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('always sends the CSRF header the host requires', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ data: [] }) })

    await apiFetch('/api/v1/tasker/pings')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('throws ApiError carrying the status and server message', async () => {
    stubFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Tenant context is required' }),
    })

    await expect(apiFetch('/api/v1/tasker/pings')).rejects.toMatchObject({
      status: 403,
      message: 'Tenant context is required',
    })
  })

  it('throws ApiError even when the error body is not JSON', async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })

    const error = await apiFetch('/api/v1/tasker/pings').catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
  })

  it('serialises a JSON body and sets the content type', async () => {
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({ data: {} }) })

    await apiFetch('/api/v1/tasker/pings', { method: 'POST', body: { label: 'x' } })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.body).toBe('{"label":"x"}')
    expect(options.headers['Content-Type']).toBe('application/json')
  })
})
```

- [ ] **Step 4: Add Vitest and run the test to verify it fails**

Create `app/vitest.config.js`:

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
})
```

Add to `app/package.json` `scripts`: `"test": "vitest run"`.

Run:

```powershell
cd C:\Projects\tasker-whity\app
npm install -D vitest
npm test
```

Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 5: Write the client**

Create `app/src/api/client.js`:

```javascript
/**
 * Same-origin API client for the whity host.
 *
 * In dev, Vite proxies /api to the host, so requests are same-origin in both
 * environments and the SameSite=Lax session cookie is sent automatically.
 * Nothing here ever touches a token: the JWT lives in an httpOnly cookie the
 * browser handles for us.
 *
 * Two host contract details are baked in here rather than left to callers:
 * every request carries X-Requested-With, because the host's CsrfGuard 403s
 * mutating requests without it; and callers pass versioned paths
 * (/api/v1/...), because the router injects /v1 into everything except
 * /api/health, /api/version, /api/openapi.json and /mcp.
 */

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Perform an API request.
 *
 * @param {string} path Absolute API path, e.g. '/api/v1/tasker/pings'.
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 * @returns {Promise<any>} The parsed JSON response body.
 * @throws {ApiError} When the response status is not ok.
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options

  const init = {
    method,
    credentials: 'include',
    headers: {
      // Required by the host's CsrfGuard on every mutating request; harmless
      // on reads, so it is unconditional rather than a per-call decision.
      'X-Requested-With': 'XMLHttpRequest',
      ...headers,
    },
  }

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(path, init)

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      const payload = await response.json()
      if (payload && typeof payload.error === 'string') {
        message = payload.error
      } else if (payload && typeof payload.message === 'string') {
        message = payload.message
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(response.status, message)
  }

  return response.json()
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run:

```powershell
npm test
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Write the ping resource module**

Create `app/src/api/pings.js`:

```javascript
import { apiFetch } from './client'

/**
 * @returns {Promise<Array<{id: number, tenantId: number, label: string, createdAt: string|null}>>}
 */
export async function listPings() {
  const payload = await apiFetch('/api/v1/tasker/pings')
  return payload.data
}

/**
 * @param {string} label
 * @returns {Promise<{id: number, tenantId: number, label: string, createdAt: string|null}>}
 */
export async function createPing(label) {
  const payload = await apiFetch('/api/v1/tasker/pings', {
    method: 'POST',
    body: { label },
  })
  return payload.data
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function login(email, password) {
  return apiFetch('/api/v1/login', {
    method: 'POST',
    body: { email, password },
  })
}
```

`POST /api/v1/login` sets the httpOnly session cookie; because Vite proxies `/api` to the host, the browser treats this as same-origin and stores it exactly as it will in production. `apiFetch` supplies the `X-Requested-With` header the CSRF guard demands, so callers do not pass it themselves.

- [ ] **Step 8: Write the dev check screen**

Create `app/src/dev/PingCheck.jsx`. This is a temporary scaffold-verification screen, deleted in Plan C.

```jsx
import { useState } from 'react'
import { listPings, createPing, login } from '../api/pings'

/**
 * Temporary end-to-end check: log in with the seeded admin, create a ping,
 * and list them back — proving migration → route → cookie auth → SPA.
 * Removed once the real board lands.
 */
export default function PingCheck() {
  const [pings, setPings] = useState([])
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  async function runCheck() {
    setStatus('running')
    setError(null)
    try {
      await login('admin@example.com', 'admin123')
      await createPing(`from the SPA at ${new Date().toISOString()}`)
      setPings(await listPings())
      setStatus('ok')
    } catch (e) {
      setError(`${e.name} ${e.status ?? ''}: ${e.message}`)
      setStatus('failed')
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'monospace' }}>
      <h1>Tasker host check</h1>
      <button onClick={runCheck}>Run end-to-end check</button>
      <p>Status: {status}</p>
      {error && <pre style={{ color: '#C0432D' }}>{error}</pre>}
      <ul>
        {pings.map((p) => (
          <li key={p.id}>
            #{p.id} tenant {p.tenantId} — {p.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 9: Register the dev route**

In `app/src/App.jsx`, add the import and a route inside the existing `<Routes>` element. Place it before any catch-all redirect, and outside any auth guard, since the screen logs in itself.

```jsx
import PingCheck from './dev/PingCheck'
```

```jsx
<Route path="/dev/ping" element={<PingCheck />} />
```

- [ ] **Step 10: Add the root dev scripts**

Add to the root `package.json` `scripts` block:

```json
"dev": "cd app && npm run dev",
"app:test": "cd app && npm test",
"app:build": "cd app && npm run build"
```

- [ ] **Step 11: Verify the full round trip in a browser**

Run:

```powershell
cd C:\Projects\tasker-whity
npm run host:up
npm run plugin:install
npm run dev
```

Open <http://localhost:5174/dev/ping> and click **Run end-to-end check**.

Expected: status `ok`, and the list shows at least one ping with a tenant id. This single click proves migration, tenant-scoped query, RBAC, cookie auth over the Vite proxy, and the SPA seam all work together.

If it fails with 403 on the POST, the seeded admin lacks `tasker:ping:manage` — re-check the grant migration from Task 4 Step 5 against the real `roles`/`permissions` schema.

- [ ] **Step 12: Verify the production path too**

Run:

```powershell
npm run app:build
```

Then open <http://localhost:8010/dev/ping> — Caddy serves the built SPA from `/app/public/spa` at the same origin as the API, with no proxy involved.

Expected: the same check passes. This confirms the production topology, not just the dev proxy.

- [ ] **Step 13: Commit**

```bash
git add app/ package.json
git commit -m "feat: SPA on the host with same-origin cookie auth"
```

---

### Task 7: CI and the pinned-core record

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `host/core.version` (pin to a SHA)
- Modify: `README.md` (record verified versions)

**Interfaces:**
- Consumes: everything above.
- Produces: CI running plugin tests, static analysis, and SPA tests on every push and pull request.

- [ ] **Step 1: Pin core to the exact verified commit**

Floating on `main` means a core change can break the build with no local edit. Now that the stack is green, freeze it.

```powershell
$sha = git -C host\.core rev-parse HEAD
Set-Content -Path host\core.version -Value $sha -Encoding ascii
Write-Host "Pinned core to $sha"
```

- [ ] **Step 2: Write the CI workflow**

Container-based jobs mirror local runs, and no host stack is needed: the plugin suite runs against in-memory SQLite and the SPA suite is pure Vitest. MCP drift and E2E need a live stack and arrive in Plan B and Plan C.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  plugin:
    runs-on: ubuntu-latest
    container: php:8.4-cli
    steps:
      - uses: actions/checkout@v4

      - name: Fetch pinned whity-core (for the SDK path repository)
        run: |
          apt-get update && apt-get install -y git unzip
          git clone https://github.com/AmroKSaleh/whity-core.git host/.core
          git -C host/.core checkout "$(cat host/core.version)"

      - name: Install Composer
        run: |
          curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

      - name: Install plugin dependencies
        working-directory: plugin
        run: composer install --no-interaction --no-progress

      - name: PHPUnit
        working-directory: plugin
        run: php vendor/bin/phpunit

      - name: PHPStan
        working-directory: plugin
        run: php vendor/bin/phpstan analyse

  app:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: app/package-lock.json

      - name: Install
        working-directory: app
        run: npm ci

      - name: Vitest
        working-directory: app
        run: npm test

      - name: Build
        working-directory: app
        run: npm run build
```

- [ ] **Step 3: Verify the plugin job's steps locally**

CI cannot be trusted until its commands are known to work. Reproduce the plugin job exactly:

```powershell
docker run --rm -v "${PWD}:/repo" -w /repo/plugin php:8.4-cli sh -c "
  apt-get update -qq && apt-get install -y -qq git unzip >/dev/null &&
  curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer &&
  composer install --no-interaction --no-progress &&
  php vendor/bin/phpunit &&
  php vendor/bin/phpstan analyse
"
```

Expected: PHPUnit and PHPStan both pass. The repo root is mounted so the `../host/.core/sdk` path repository resolves.

- [ ] **Step 4: Record verified versions in the README**

Append to `README.md`:

```markdown
## Verified against

- whity-core: pinned in `host/core.version`
- whity/plugin-sdk: ^1.9
- PHP 8.4 · PostgreSQL 15 · Node 20

## Foundation checks

- `npm run plugin:test` — PHPUnit incl. tenant-isolation conformance
- `npm run plugin:stan` — PHPStan level 6
- `npm run app:test` — Vitest over the API client
- `npm run mcp:check` — derived MCP tool surface matches `docs/mcp-tool-surface.json` (needs a running host)
- <http://localhost:5174/dev/ping> — full round trip through the dev proxy
- <http://localhost:8010/dev/ping> — same round trip through Caddy, production topology
```

- [ ] **Step 5: Run every check one final time**

Run:

```powershell
npm run host:up
npm run plugin:install
npm run plugin:test
npm run plugin:stan
npm run app:test
npm run mcp:check
```

Expected: all green. Record any command that fails and fix it before committing — this list is Plan A's acceptance gate.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml host/core.version README.md
git commit -m "ci: plugin and app pipelines, pin core to a verified SHA"
```

---

## Plan A acceptance

Plan A is complete when all of the following hold:

1. `npm run host:up` from a clean clone brings up Postgres and FrankenPHP, and `/api/health` returns 200.
2. `npm run plugin:install` deploys the plugin and `/api/plugins` reports `Tasker` as `active`.
3. `npm run plugin:test` passes, including all three tenant-isolation conformance checks.
4. `npm run plugin:stan` is clean at level 6.
5. `npm run mcp:check` confirms `list_pings` and `create_ping` derive with those exact names and correct input schemas.
6. `/dev/ping` completes the round trip on **both** `:5174` (Vite proxy) and `:8010` (Caddy, production topology).
7. `host/core.version` holds a commit SHA, not a branch name.
8. CI passes on a pull request.

At that point every seam the port depends on is proven, and Plan B can write the real seven tables against a known-good foundation.
