<?php

declare(strict_types=1);

/**
 * Dev-only bootstrap convenience (Task 5, Finding 3): flips the per-tenant
 * `mcp.enabled` setting to `true` for the seeded "Default Tenant" so a clean
 * clone reaches a working MCP surface through `npm run host:up` alone,
 * without a separate manual PATCH /api/v1/settings call.
 *
 * Runs INSIDE the `bootstrap` compose service, after `seed`, against the
 * same mounted whity-core checkout (`/app`) and the same Postgres the app
 * uses — never over HTTP, because `frankenphp` (the only thing that ever
 * serves HTTP) is not started until `bootstrap` exits 0 (see
 * `frankenphp.depends_on.bootstrap: condition: service_completed_successfully`
 * in host/docker-compose.yml). An HTTP round trip to the documented
 * PATCH /api/v1/settings endpoint is therefore not reachable at this point
 * in the container lifecycle — this script reaches the exact same
 * `tenant_settings` row the same way `SettingsService::setTenant()` would,
 * just called in-process instead of through the HTTP handler that wraps it.
 *
 * Deliberately non-fatal from the caller's point of view: the shell command
 * that invokes this script tolerates a non-zero exit (`|| echo ...`) so a
 * problem here (e.g. no "Default Tenant" row, for a deployment that seeds
 * differently) never blocks `bootstrap` from completing, which would in turn
 * block `frankenphp` from ever starting. If this script fails, MCP simply
 * stays off for the tenant until the manual fallback in the README is run —
 * exactly the pre-Finding-3 behaviour, not a regression.
 *
 * This lives in Tasker's OWN host/scripts/ (not vendored core, not the
 * plugin) precisely so it can reach into settings internals without
 * crossing either of those layering boundaries.
 */

require '/app/vendor/autoload.php';

use Whity\Core\Settings\GlobalSettingsRepository;
use Whity\Core\Settings\SettingsService;
use Whity\Core\Settings\TenantSettingsRepository;
use Whity\Database\Database;

const DEFAULT_TENANT_NAME = 'Default Tenant';

$db = Database::connect();
$pdo = $db->getPdo();

$stmt = $pdo->prepare('SELECT id FROM tenants WHERE name = :name');
$stmt->execute([':name' => DEFAULT_TENANT_NAME]);
$row = $stmt->fetch(\PDO::FETCH_ASSOC);

if ($row === false) {
    fwrite(STDERR, "[enable-tenant-mcp] no '" . DEFAULT_TENANT_NAME . "' row found — did seed run first? Skipping.\n");
    exit(1);
}

$tenantId = (int) $row['id'];

$settings = new SettingsService(
    new GlobalSettingsRepository($pdo),
    new TenantSettingsRepository($pdo),
);
$settings->setTenant($tenantId, 'mcp.enabled', 'true');

echo "[enable-tenant-mcp] mcp.enabled=true set for tenant {$tenantId} (\"" . DEFAULT_TENANT_NAME . "\").\n";
