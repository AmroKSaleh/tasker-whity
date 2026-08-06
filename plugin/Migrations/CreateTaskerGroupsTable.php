<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * No project_id column, deliberately — the original app denormalizes it
 * alongside section_id ("every insert path sets both"), a pair that can
 * silently drift out of sync. This schema derives project scope via
 * section_id's own join.
 */
final class CreateTaskerGroupsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_groups (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                section_id BIGINT NOT NULL REFERENCES tasker_sections(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_groups_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_groups_section_slug_unique UNIQUE (section_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_groups_tenant_id ON tasker_groups(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_groups_section_id ON tasker_groups(section_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_groups CASCADE');
    }
}
