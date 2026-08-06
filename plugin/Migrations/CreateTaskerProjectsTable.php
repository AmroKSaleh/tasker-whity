<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * The board's project table. Deliberately excludes `description` (write-only
 * in the original app — every write site sets it, no read site was found
 * anywhere in the frontend) and `environment_id` (superseded by ou_id, the
 * whity OU that replaces Tasker's own environment concept).
 *
 * `context` defaults to a bare `'{}'` literal, not `'{}'::jsonb`: PostgreSQL
 * assigns an unknown-typed string literal to a jsonb column via that column's
 * own input function with no cast needed (verified: `pg_typeof()` reports
 * `jsonb` either way), and the explicit `::` cast operator is PostgreSQL-only
 * syntax that the conformance kit's in-memory SQLite double's parser rejects
 * outright ("unrecognized token: :"), which broke
 * TenantIsolationTest::testDeclaredTenantTablesExistWithTenantIdOnARealEngine.
 */
final class CreateTaskerProjectsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_projects (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                ou_id INTEGER NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                context JSONB NOT NULL DEFAULT \'{}\',
                prefix VARCHAR(5) NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_projects_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_projects_tenant_slug_unique UNIQUE (tenant_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_projects_tenant_id ON tasker_projects(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_projects_ou_id ON tasker_projects(ou_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_projects CASCADE');
    }
}
