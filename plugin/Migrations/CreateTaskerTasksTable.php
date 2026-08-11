<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * The plain board task. Deliberately excludes every flow/seed/review/
 * agent-workflow/local-mode/intake column found in the original app's live
 * schema — those are added by their owning later slice via an ordinary
 * ALTER TABLE, not ported here. See the design spec §4 for the full list and
 * the reasoning (cheap additive migration later vs. the entity_tags case,
 * which required avoiding a structural rework).
 *
 * status is free text with NO CHECK constraint, deliberately — deferred
 * custom statuses must stay purely additive. priority IS CHECK-constrained,
 * since its value set is not on any roadmap to grow.
 *
 * section_id is NOT NULL: the original app's own code carries a comment
 * that a null section breaks board rendering. Every project's own creation
 * (Task 3) guarantees a Backlog section exists before any task can be
 * created, closing that class of bug at the schema level.
 *
 * section_id is ON DELETE CASCADE, not RESTRICT: a project delete (Task 3)
 * must cascade all the way through sections to tasks in one statement, and
 * PostgreSQL's cascade/restrict interaction across multiple FK paths to the
 * same row is not something to rely on getting right by accident. The
 * "don't let someone accidentally nuke a non-empty section" protection
 * therefore lives in the API layer instead — SectionsApiHandler::delete()
 * guards against BOTH deleting a project's LAST section AND (D1b Task 12b,
 * contract parity with the original app) deleting a non-empty one, unless
 * the caller explicitly passes delete_tasks: true. Only then does this FK
 * cascade actually run for a section delete; deleting a whole PROJECT still
 * always implies deleting everything under it (ProjectsApiHandler::delete()
 * carries no equivalent per-section guard).
 */
final class CreateTaskerTasksTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tasker_tasks (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                project_id BIGINT NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
                section_id BIGINT NOT NULL REFERENCES tasker_sections(id) ON DELETE CASCADE,
                group_id BIGINT NULL REFERENCES tasker_groups(id) ON DELETE SET NULL,
                text VARCHAR(2000) NOT NULL,
                detail TEXT NULL,
                status VARCHAR(64) NOT NULL DEFAULT 'pending',
                priority VARCHAR(16) NULL,
                due_date DATE NULL,
                pinned BOOLEAN NOT NULL DEFAULT FALSE,
                pinned_at TIMESTAMP NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                completed_at TIMESTAMP NULL,
                short_id INTEGER NULL,
                created_by INTEGER NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_tasks_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_tasks_priority_check CHECK (priority IS NULL OR priority IN ('rush', 'high', 'medium', 'low'))
            )
        ");

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_tenant_id ON tasker_tasks(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_section_id ON tasker_tasks(section_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_project_id ON tasker_tasks(project_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_tasks CASCADE');
    }
}
