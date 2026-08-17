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
 *
 * ── PORTABILITY: WHY THE EXISTENCE CHECK EXISTS (whole-branch review fix) ──
 *
 * THIS MIGRATION USED TO BE UNRUNNABLE ON SQLite, IN BOTH DIRECTIONS. It was
 * written as `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`, and SQLite
 * has NO `IF NOT EXISTS` form of ADD COLUMN and no `IF EXISTS` form of DROP
 * COLUMN — both are outright syntax errors there
 * (`General error: 1 near "EXISTS"`), not merely unsupported niceties. That
 * broke an explicit Global Constraint of this plan ("the SQLite tier must be
 * able to run them"), which is why both prior ALTER-style migrations comply
 * deliberately — see {@see AddTaskerProjectPrefixUnique}, which documents the
 * reasoning twice and picks a partial index BECAUSE SQLite supports it.
 *
 * The cost was not theoretical, and it was recorded TWICE in this slice
 * without the two records ever being joined: `TasksApiHandlerTest` hand-rolled
 * a divergent `flow_id INTEGER` column because it could not run this
 * migration, and `TenantIsolationTest::schemaMigrations()` omitted this
 * migration entirely — filed as "a coverage gap" when the real reason adding
 * it would have failed is right here. Both are fixed alongside this file.
 *
 * SO IDEMPOTENCE IS EXPRESSED IN PHP, NOT IN SQL: ask the engine which columns
 * tasker_tasks already has, then run only the statements still needed. Two
 * consequences worth keeping in mind if this file is edited again:
 *
 *   - EVERY `ALTER TABLE` BELOW IS A COMPLETE, STATIC SQL LITERAL. Nothing is
 *     assembled from a column name at runtime — the map's key names the column
 *     to LOOK FOR and its value is the whole statement, so the plan's
 *     one-static-template rule holds per statement exactly as it does for the
 *     handlers' own two-literal OU branches. A driver branch is not a
 *     caller-value branch.
 *   - The check is DRIVER-AWARE, not `IF NOT EXISTS`-shaped, because there is
 *     no portable SQL spelling of it. The alternative — running each ALTER and
 *     catching a duplicate-column error — was rejected: PostgreSQL aborts the
 *     ENTIRE transaction block on the first failing statement, so if a
 *     migration runner ever wraps this in one (whity-core's does not today,
 *     but that is not this file's promise to make), every subsequent statement
 *     including the retry would fail with "current transaction is aborted".
 *     {@see \Tasker\Domain\ShortIdAllocator} documents that same Postgres trap
 *     from the other side.
 */
final class AddTaskerTaskFlowAndContractColumns implements MigrationInterface
{
    /**
     * column name => the COMPLETE statement that adds it, in dependency order.
     *
     * @var array<string, string>
     */
    private const ADD_COLUMN = [
        'flow_id'                 => 'ALTER TABLE tasker_tasks ADD COLUMN flow_id BIGINT REFERENCES tasker_flows(id) ON DELETE SET NULL',
        'flow_step'               => 'ALTER TABLE tasker_tasks ADD COLUMN flow_step INTEGER',
        'output_contract'         => 'ALTER TABLE tasker_tasks ADD COLUMN output_contract JSONB',
        'output_contract_blessed' => 'ALTER TABLE tasker_tasks ADD COLUMN output_contract_blessed BOOLEAN NOT NULL DEFAULT FALSE',
    ];

    /**
     * The same four, REVERSED — dropped in the opposite order they were added,
     * matching this file's own previous down().
     *
     * @var array<string, string>
     */
    private const DROP_COLUMN = [
        'output_contract_blessed' => 'ALTER TABLE tasker_tasks DROP COLUMN output_contract_blessed',
        'output_contract'         => 'ALTER TABLE tasker_tasks DROP COLUMN output_contract',
        'flow_step'               => 'ALTER TABLE tasker_tasks DROP COLUMN flow_step',
        'flow_id'                 => 'ALTER TABLE tasker_tasks DROP COLUMN flow_id',
    ];

    public function up(\PDO $pdo): void
    {
        $existing = self::existingColumns($pdo);

        foreach (self::ADD_COLUMN as $column => $sql) {
            if (!in_array($column, $existing, true)) {
                $pdo->exec($sql);
            }
        }

        // Created LAST, and dropped FIRST in down(): SQLite refuses to drop a
        // column that any index still mentions, and this one covers two of them.
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_flow_step ON tasker_tasks (flow_id, flow_step)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP INDEX IF EXISTS idx_tasker_tasks_flow_step');

        $existing = self::existingColumns($pdo);

        foreach (self::DROP_COLUMN as $column => $sql) {
            if (in_array($column, $existing, true)) {
                $pdo->exec($sql);
            }
        }
    }

    /**
     * Every column tasker_tasks currently has, lowercased.
     *
     * Read ONCE per direction rather than re-queried per column: no column
     * appears twice in either map above, so a single snapshot answers all four
     * questions, and one catalog read is cheaper than four.
     *
     * `to_regclass('tasker_tasks')` on the PostgreSQL side rather than an
     * `information_schema.columns` filter on `table_schema`, deliberately: it
     * resolves the table name through the connection's OWN `search_path`,
     * which is precisely how the `ALTER TABLE` statements above will resolve
     * it. A `table_schema = current_schema()` filter would answer a subtly
     * DIFFERENT question, and gets it wrong for the SDK's own test harness
     * shape ({@see \Whity\Sdk\Testing\RealEnginePdo} runs every Postgres test
     * inside a private schema with `public` still on the path). An absent table
     * yields no rows, so the first ALTER then fails with the engine's own
     * "relation does not exist" — the correct, loud answer for a migration run
     * out of order (this one must follow {@see CreateTaskerFlowsTable}, whose
     * table flow_id references).
     *
     * @return list<string>
     */
    private static function existingColumns(\PDO $pdo): array
    {
        $driver = (string) $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME);

        // TWO complete literals selected by the DRIVER, never one template with
        // a name interpolated into it.
        $stmt = $driver === 'sqlite'
            ? $pdo->query("PRAGMA table_info('tasker_tasks')")
            : $pdo->query(
                "SELECT attname AS name
                 FROM pg_attribute
                 WHERE attrelid = to_regclass('tasker_tasks') AND attnum > 0 AND NOT attisdropped"
            );

        if ($stmt === false) {
            return [];
        }

        $columns = [];
        /** @var array<string, mixed> $row */
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $name = $row['name'] ?? null;
            if (is_string($name) || is_int($name)) {
                $columns[] = strtolower((string) $name);
            }
        }

        return $columns;
    }
}
