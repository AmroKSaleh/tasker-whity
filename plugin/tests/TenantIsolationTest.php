<?php

declare(strict_types=1);

namespace Tasker\Tests;

use Tasker\Migrations\CreateTaskerFlowsTable;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerPingTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
use Tasker\Migrations\CreateTaskerTaskEdgesTable;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\Migrations\CreateTaskerUserPrefsTable;
use Whity\Sdk\Tenant\TenantTableRegistry;
use Whity\Sdk\Testing\TenantIsolationConformanceTestCase;

/**
 * Proves Tasker's tenant isolation with the SDK conformance kit: every table
 * the plugin creates declares tenant_id, every query against a tenant-owned
 * table binds a tenant_id predicate, and the columns physically exist after
 * the migrations run on a real engine.
 */
final class TenantIsolationTest extends TenantIsolationConformanceTestCase
{
    protected function tenantTableRegistry(): TenantTableRegistry
    {
        return TenantTableRegistry::for([
            'tasker_pings' => 'Connectivity probe rows are per-tenant.',
            'tasker_projects' => 'Board projects are per-tenant.',
            'tasker_sections' => 'Board sections are per-tenant.',
            'tasker_groups' => 'Board groups are per-tenant.',
            'tasker_tasks' => 'Board tasks are per-tenant.',
            'tasker_milestones' => 'Task milestones are per-tenant.',
            'tasker_task_discussions' => 'Task AI discussions are per-tenant.',
            'tasker_user_prefs' => 'Per-user Tasker preferences are per-tenant.',
            // D5a Task 5 REVIEW FIX: neither table was registered here when
            // Task 2 created them, so the migration linter never checked
            // either declares tenant_id, and the predicate scanner treated
            // every query FlowsApiHandler runs against them (six, as of this
            // task) as touching an UNKNOWN table -- unpoliced, not passing:
            // deleting `AND tenant_id = :tenant_id` from any of those queries
            // would still have shown green. Registered now, the first task
            // with real handler SQL against either table.
            'tasker_flows' => 'Flows are per-tenant, scoped through their project.',
            'tasker_task_edges' => 'Task I/O edges are per-tenant.',
        ]);
    }

    protected function migrationsDirectory(): string
    {
        return dirname(__DIR__) . '/Migrations';
    }

    /**
     * The SDK's scanner (`TenantPredicateScanner::scanDirectory()`) always
     * recurses a WHOLE directory tree with no exclusion parameter, so a
     * single "plugin root, minus tests/stubs/vendor/Migrations" call is not
     * expressible as one `scanDirectory()` invocation. Instead this walks
     * the plugin root's own immediate children at test-run time and returns
     * every one that is not a known non-source directory, so a NEW
     * top-level directory (e.g. an OU scope resolver or a repository layer
     * added in Plan B) is picked up automatically the next time this test
     * runs, without anyone remembering to edit this list by hand — unlike
     * the previous hardcoded `[.../Api]`, which would have left such a
     * directory completely unpoliced.
     *
     * `Migrations/` is excluded because its own tenant-column conformance is
     * already asserted by {@see testMigrationsDeclareTenantColumnOnTenantTables()}
     * via the separate migration linter; `tests/`, `stubs/` and `vendor/`
     * are excluded because they are not handler/business-logic source (and
     * `vendor/` in particular would pull in every dependency, including the
     * SDK itself, none of which know about Tasker's tenant registry).
     *
     * Trade-off: this only reaches directories, so a loose top-level file
     * (e.g. TaskerPlugin.php, which today contains no SQL at all -- it only
     * resolves a PDO and delegates to Api/PingApiHandler) is not scanned.
     * That is an accepted limitation of `scanDirectory()`'s directory-only
     * API, not a gap introduced here.
     *
     * @return list<string>
     */
    protected function handlerSourceDirectories(): array
    {
        $root = dirname(__DIR__);
        $excluded = ['tests', 'stubs', 'vendor', 'Migrations'];

        $dirs = [];
        foreach (scandir($root) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || $entry[0] === '.') {
                continue;
            }
            if (in_array($entry, $excluded, true)) {
                continue;
            }
            $path = $root . '/' . $entry;
            if (is_dir($path)) {
                $dirs[] = $path;
            }
        }
        sort($dirs);

        return $dirs;
    }

    /**
     * @return list<\Whity\Sdk\MigrationInterface>
     */
    protected function schemaMigrations(): array
    {
        return [
            new CreateTaskerPingTable(),
            new CreateTaskerProjectsTable(),
            new CreateTaskerSectionsTable(),
            new CreateTaskerGroupsTable(),
            new CreateTaskerTasksTable(),
            // D5a Task 5 REVIEW FIX: tasker_flows FK-references tasker_projects
            // (already created above); tasker_task_edges FK-references
            // tasker_tasks (just created) -- so both run only after their
            // respective dependency, matching TenantIsolationOuTest's own
            // migration order for the same two tables.
            new CreateTaskerFlowsTable(),
            new CreateTaskerTaskEdgesTable(),
            new CreateTaskerMilestonesTable(),
            new CreateTaskerTaskDiscussionsTable(),
            new CreateTaskerUserPrefsTable(),
        ];
    }
}
