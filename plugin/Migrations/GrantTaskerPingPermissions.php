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
 *
 * Permission names use `tasker_ping:view` / `tasker_ping:manage` (single
 * colon) rather than a `tasker:ping:view`-style three-segment slug: the
 * host's PluginLoader::PERMISSION_PATTERN
 * (`/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/`) accepts exactly one colon, and
 * fails closed (route not registered / permission not seeded) on anything
 * else — verified empirically via the route-registration warning during
 * `migrate run`.
 */
final class GrantTaskerPingPermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker_ping:view', 'tasker_ping:manage'];

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
