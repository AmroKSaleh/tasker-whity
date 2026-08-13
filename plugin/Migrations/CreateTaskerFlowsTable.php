<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * D5a Task 2: the flows table. A flow is a named, per-project process that
 * groups a sequence of tasks — connected by typed I/O edges, see
 * {@see CreateTaskerTaskEdgesTable} — into a single unit with quality gates
 * between steps. This migration only creates the table's own columns and
 * indexes; the ordering/contract-enforcement logic every later task in this
 * slice needs is built on top of this storage, not here.
 *
 * Column names are fixed by the slice's own contract and must not drift:
 * id, public_id, tenant_id, project_id, name, context, step_list_open,
 * short_id, created_by, created_at, updated_at.
 *
 * short_id INTEGER (nullable): {@see \Tasker\Domain\ShortIdAllocator} was
 * generalised (D5a Task 1) to serve this table as well as tasker_tasks via a
 * closed ALLOWED_TABLES whitelist. Its SQLite race-detection
 * (isRaceLoss()) matches on the literal strings "tasker_flows.project_id"
 * and "tasker_flows.short_id" in the engine's own error message, so both the
 * table name and these two column names are load-bearing — renaming either
 * silently breaks the allocator's retry path on SQLite (see that method's
 * own docblock for the full history of that exact bug).
 *
 * idx_tasker_flows_project_name is UNIQUE, not just an index: two flows in
 * the same project may not share a name (mirrors the existing
 * tasker_sections(project_id, slug) uniqueness elsewhere in this schema).
 * idx_tasker_flows_project_short_id is UNIQUE for the same reason
 * AddTaskerTaskShortIdUnique exists for tasker_tasks: it is the actual
 * correctness guarantee the allocator's MAX+1-and-retry scheme leans on, not
 * an optimisation.
 */
final class CreateTaskerFlowsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tasker_flows (
                id              BIGSERIAL PRIMARY KEY,
                public_id       UUID        NOT NULL UNIQUE,
                tenant_id       BIGINT      NOT NULL,
                project_id      BIGINT      NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
                name            TEXT        NOT NULL,
                context         JSONB       NOT NULL DEFAULT '{}',
                step_list_open  BOOLEAN     NOT NULL DEFAULT FALSE,
                short_id        INTEGER,
                created_by      BIGINT,
                created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_flows_project_name     ON tasker_flows (project_id, name)');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_flows_project_short_id ON tasker_flows (project_id, short_id)');
        $pdo->exec('CREATE INDEX        IF NOT EXISTS idx_tasker_flows_project          ON tasker_flows (project_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_flows CASCADE');
    }
}
