<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Per-user Tasker preferences.
 *
 * whity-core has no per-user preference store to reuse:
 * GlobalSettingsRepository and TenantSettingsRepository are global and
 * per-tenant, and NotificationPreferenceRepository is notification-specific.
 * A default project is Tasker domain state anyway — "which project is this
 * user working in" is not a platform concern — so a plugin-owned table is the
 * right home.
 *
 * local_mode is declared now and left unconsumed: D4 owns it. Declaring it
 * here avoids a migration whose only purpose is adding one boolean later.
 */
final class CreateTaskerUserPrefsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_user_prefs (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                profile_id INTEGER NOT NULL,
                default_project_id BIGINT NULL REFERENCES tasker_projects(id) ON DELETE SET NULL,
                local_mode BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_user_prefs_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_user_prefs_tenant_profile_unique UNIQUE (tenant_id, profile_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_user_prefs_tenant_id ON tasker_user_prefs(tenant_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_user_prefs CASCADE');
    }
}
