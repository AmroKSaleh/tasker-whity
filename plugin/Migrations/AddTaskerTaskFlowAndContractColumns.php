<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * D5a Task 2: four additive columns on tasker_tasks wiring a task into a
 * flow. No existing row is a flow step, so this is a pure schema change —
 * no data migration.
 *
 * Column names are fixed by the slice's own contract and must not drift:
 * flow_id, flow_step, output_contract, output_contract_blessed.
 *
 * flow_id is ON DELETE SET NULL, not CASCADE: deleting a flow must not
 * delete the tasks that were part of it, only detach them from it — the
 * inverse of {@see CreateTaskerTaskEdgesTable}'s edges, which genuinely
 * cannot survive without both of their endpoints.
 *
 * idx_tasker_tasks_flow_step supports the ordering queries a later task in
 * this slice performs against a flow's own steps.
 */
final class AddTaskerTaskFlowAndContractColumns implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS flow_id                 BIGINT  REFERENCES tasker_flows(id) ON DELETE SET NULL');
        $pdo->exec('ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS flow_step               INTEGER');
        $pdo->exec('ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS output_contract         JSONB');
        $pdo->exec('ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS output_contract_blessed BOOLEAN NOT NULL DEFAULT FALSE');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_flow_step ON tasker_tasks (flow_id, flow_step)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP INDEX IF EXISTS idx_tasker_tasks_flow_step');
        $pdo->exec('ALTER TABLE tasker_tasks DROP COLUMN IF EXISTS output_contract_blessed');
        $pdo->exec('ALTER TABLE tasker_tasks DROP COLUMN IF EXISTS output_contract');
        $pdo->exec('ALTER TABLE tasker_tasks DROP COLUMN IF EXISTS flow_step');
        $pdo->exec('ALTER TABLE tasker_tasks DROP COLUMN IF EXISTS flow_id');
    }
}
