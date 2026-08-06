<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

final class GrantTaskerTaskPermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker_task:view', 'tasker_task:edit', 'tasker_task:complete', 'tasker_task:delete'];

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
               AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_id = permissions.id)'
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropCatalogue->execute([':permission' => $permission, ':marker' => self::DESCRIPTION_PREFIX . '%']);
        }
    }
}
