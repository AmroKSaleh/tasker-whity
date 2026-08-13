<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * D5a Task 2: the normalised task-edge table. One row is one typed I/O
 * connection between two tasks in the same flow — the producer
 * (source_task_id)'s output feeds the consumer (target_task_id)'s input.
 *
 * Column names are fixed by the slice's own contract and must not drift:
 * id, public_id, tenant_id, source_task_id, target_task_id, expected_type,
 * contract, created_at.
 *
 * tasker_task_edges_no_self CHECK (source_task_id <> target_task_id): a task
 * may never feed itself. This is a database-level CHECK, not an
 * application-layer guard, so it holds even against a direct INSERT that
 * bypasses every handler.
 *
 * idx_tasker_task_edges_pair is UNIQUE on (target_task_id, source_task_id):
 * the same ordered pair may not be connected twice.
 *
 * Both source_task_id and target_task_id are ON DELETE CASCADE: deleting
 * either endpoint of an edge deletes the edge itself — an edge can never
 * dangle with a source or target that no longer exists.
 *
 * expected_type/contract are nullable: this migration only reserves the
 * columns; a later task in this slice defines their shape and how they are
 * enforced.
 */
final class CreateTaskerTaskEdgesTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tasker_task_edges (
                id             BIGSERIAL PRIMARY KEY,
                public_id      UUID      NOT NULL UNIQUE,
                tenant_id      BIGINT    NOT NULL,
                source_task_id BIGINT    NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                target_task_id BIGINT    NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                expected_type  TEXT,
                contract       JSONB,
                created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT tasker_task_edges_no_self CHECK (source_task_id <> target_task_id)
            )
        ");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_task_edges_pair   ON tasker_task_edges (target_task_id, source_task_id)');
        $pdo->exec('CREATE INDEX        IF NOT EXISTS idx_tasker_task_edges_source ON tasker_task_edges (source_task_id)');
        $pdo->exec('CREATE INDEX        IF NOT EXISTS idx_tasker_task_edges_target ON tasker_task_edges (target_task_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_task_edges CASCADE');
    }
}
