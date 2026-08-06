<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * AI chat and focus reason only — milestones are extracted into their own
 * table (see CreateTaskerMilestonesTable). D1 lays down this data model
 * without populating it; the AI calling logic that writes here is D2's job.
 *
 * `messages` defaults to a bare `'[]'` literal, not `'[]'::jsonb`: PostgreSQL
 * assigns an unknown-typed string literal to a jsonb column via that column's
 * own input function with no cast needed (verified: `pg_typeof()` reports
 * `jsonb` either way), and the explicit `::` cast operator is PostgreSQL-only
 * syntax that the conformance kit's in-memory SQLite double's parser rejects
 * outright ("unrecognized token: :") — the same fix already established in
 * {@see CreateTaskerProjectsTable} for its `context` column.
 */
final class CreateTaskerTaskDiscussionsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_task_discussions (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                task_id BIGINT NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                messages JSONB NOT NULL DEFAULT \'[]\',
                reason TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_task_discussions_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_task_discussions_task_id_unique UNIQUE (task_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_task_discussions_tenant_id ON tasker_task_discussions(tenant_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_task_discussions CASCADE');
    }
}
