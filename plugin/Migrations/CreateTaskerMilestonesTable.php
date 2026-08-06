<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Retires the original app's task_discussions.steps (jsonb array) +
 * checked_steps (parallel boolean array) + the four row-locking plpgsql
 * functions that existed solely to stop concurrent writers clobbering each
 * other on a read-modify-write cycle. A real table with row-level locking
 * needs none of that. `kind` (question|prerequisite, seed-checklist only) is
 * deliberately excluded — seed territory, deferred to D7 with seeds.
 */
final class CreateTaskerMilestonesTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_milestones (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                task_id BIGINT NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                summary VARCHAR(1000) NOT NULL,
                detail TEXT NULL,
                checked BOOLEAN NOT NULL DEFAULT FALSE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_milestones_public_id_unique UNIQUE (public_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_milestones_tenant_id ON tasker_milestones(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_milestones_task_id ON tasker_milestones(task_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_milestones CASCADE');
    }
}
