<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Adds UNIQUE (project_id, short_id) — the constraint the original app
 * deliberately could NOT add.
 *
 * Its own migration comment explains why: earlier races had already produced
 * duplicate short_ids, so a unique index would have blocked creation, and it
 * settled for a per-project advisory lock inside a trigger instead.
 *
 * We start clean, so we take the stronger guarantee. With the constraint in
 * place, ShortIdAllocator can allocate MAX+1 and retry on conflict — the
 * database enforces correctness rather than a lock we might forget to take,
 * and it works identically under SQLite, which supports neither
 * pg_advisory_xact_lock nor SELECT ... FOR UPDATE.
 */
final class AddTaskerTaskShortIdUnique implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_tasks_project_short_id
             ON tasker_tasks (project_id, short_id)'
        );
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP INDEX IF EXISTS idx_tasker_tasks_project_short_id');
    }
}
