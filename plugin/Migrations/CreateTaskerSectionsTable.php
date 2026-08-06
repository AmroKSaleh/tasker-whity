<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Sections carry a stored, frozen slug from day one — Plan A's own note not
 * to repeat the retrofit its original codebase needed for this exact field.
 */
final class CreateTaskerSectionsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_sections (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                project_id BIGINT NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                description TEXT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                view_prefs JSONB NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_sections_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_sections_project_slug_unique UNIQUE (project_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_sections_tenant_id ON tasker_sections(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_sections_project_id ON tasker_sections(project_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_sections CASCADE');
    }
}
