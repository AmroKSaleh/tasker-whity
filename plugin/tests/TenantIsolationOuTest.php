<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\BoardApiHandler;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;

/**
 * Proves the four OU-descendant visibility cases against a REAL PostgreSQL
 * connection — required because OuScopeResolver::whereFragment() uses
 * PostgreSQL's `= ANY(array)`, which SQLite does not support. Run against the
 * host's own tasker_test database (created fresh per run) rather than the
 * conformance kit's in-memory SQLite double.
 *
 * BoardApiHandler::get()'s OU-scope coverage lives here too, for the exact
 * same reason as ProjectsApiHandler/TasksApiHandler::isProjectVisible(): its
 * findProject() calls OuScopeResolver::whereFragment('ou_id') unconditionally
 * (one static SQL template, never a runtime-branched one — see
 * findProject()'s own docblock), so EVERY call to get() — not just the
 * OU-restricted cases — hits `= ANY(:scope)` in the SQL text and cannot run
 * against the SQLite double at all. Confirmed empirically: with that
 * unconditional call in place, both of BoardApiHandlerTest's SQLite-backed
 * cases (including the plain "unrestricted caller" composition case) throw
 * `PDOException: SQLSTATE[HY000]: General error: 1 no such function: ANY`
 * from `PDO::prepare()` itself, before any parameter is ever bound — SQLite
 * resolves function names at prepare time, so `:unrestricted = TRUE` never
 * gets a chance to short-circuit it away. `plugin/tests/Api/BoardApiHandlerTest.php`
 * (SQLite) was therefore removed entirely and ALL of its coverage — board
 * composition (sections/groups/tasks/milestones assembly, ungroupedTasks
 * shape) as well as OU-restricted/cross-tenant visibility — moved here,
 * mirroring the fact that ProjectsApiHandler itself has no SQLite-backed
 * unit test file at all.
 */
final class TenantIsolationOuTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $dsn = getenv('TASKER_TEST_PG_DSN');
        $user = getenv('TASKER_TEST_PG_USER') ?: 'tasker';
        $pass = getenv('TASKER_TEST_PG_PASS') ?: 'tasker_dev';
        $candidates = $dsn !== false
            ? [$dsn]
            : ['pgsql:host=host.docker.internal;port=5433;dbname=tasker', 'pgsql:host=localhost;port=5433;dbname=tasker'];

        $connected = false;
        foreach ($candidates as $candidate) {
            try {
                $this->pdo = new PDO($candidate, $user, $pass);
                $connected = true;
                break;
            } catch (\PDOException) {
                continue;
            }
        }
        if (!$connected) {
            self::markTestSkipped('No reachable Postgres test database among: ' . implode(', ', $candidates));
        }
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec('DROP TABLE IF EXISTS tasker_sections CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_projects CASCADE');
        // This suite runs against the host's own live database (see the
        // class doc), which ALREADY has a real organizational_units table —
        // richer than the 3-column shape this CREATE TABLE IF NOT EXISTS
        // assumed: real name/slug (both NOT NULL) plus a tenant_id FK to a
        // real `tenants` row. The IF NOT EXISTS below is a no-op there; it
        // only matters for a genuinely fresh database with neither table.
        $this->pdo->exec('
            CREATE TABLE IF NOT EXISTS organizational_units (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                parent_id INTEGER NULL REFERENCES organizational_units(id)
            )
        ');
        $this->pdo->exec('DELETE FROM organizational_units WHERE tenant_id IN (7, 9)');

        $this->ensureTestTenant(7);
        $this->ensureTestTenant(9);

        (new CreateTaskerProjectsTable())->up($this->pdo);
        (new CreateTaskerSectionsTable())->up($this->pdo);
        // Drop order matters: tasker_milestones FK-references tasker_tasks,
        // so it must be dropped before tasker_tasks — otherwise `DROP TABLE
        // tasker_tasks CASCADE` only cascade-drops the FK CONSTRAINT on
        // tasker_milestones (Postgres semantics for a referenced table being
        // dropped), leaving the table itself, and any stale rows from a
        // PRIOR test run, in place for the next test.
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_milestones CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_tasks CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_groups CASCADE');
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);
        (new CreateTaskerMilestonesTable())->up($this->pdo);
    }

    /**
     * organizational_units.tenant_id carries a real FK to tenants(id) on the
     * live host schema, so tenant 7/9 (this suite's fixture tenant ids) must
     * exist there before makeOu() can insert anything. Idempotent and scoped
     * to ids well clear of the seeded tenants (0 = System, 1 = Default
     * Tenant), so this is safe to run repeatedly against the shared dev db.
     */
    private function ensureTestTenant(int $tenantId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tenants (id, name, slug) VALUES (:id, :name, :slug) ON CONFLICT (id) DO NOTHING'
        );
        $stmt->execute([
            ':id' => $tenantId,
            ':name' => "Tasker OU Test Tenant {$tenantId}",
            ':slug' => "tasker-ou-test-tenant-{$tenantId}",
        ]);
    }

    private function makeOu(int $id, int $tenantId, ?int $parentId): void
    {
        // name/slug are NOT NULL with UNIQUE (tenant_id, name) / (tenant_id,
        // slug) on the real schema — neither exists in the brief's originally
        // assumed 3-column shape. Values only need to be unique per test run,
        // which the DELETE in setUp() guarantees by clearing tenant 7/9's
        // rows before every test.
        $stmt = $this->pdo->prepare(
            'INSERT INTO organizational_units (id, tenant_id, parent_id, name, slug) VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$id, $tenantId, $parentId, "OU {$id}", "ou-{$tenantId}-{$id}"]);
    }

    private function makeProjectDirect(int $tenantId, ?int $ouId, string $name): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_projects (public_id, tenant_id, ou_id, name, slug, created_by, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :ou_id, :name, :slug, 1, CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->execute([':tenant_id' => $tenantId, ':ou_id' => $ouId, ':name' => $name, ':slug' => strtolower($name)]);

        return (int) $stmt->fetchColumn();
    }

    private function makeSectionDirect(int $tenantId, int $projectId): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, 'Backlog', 'backlog', CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * NOTE ON A BRIEF DEVIATION: the brief's own version of this helper bound
     * `:pinned` through a plain `execute([...])` array call alongside every
     * other parameter. `PDOStatement::execute(array)` binds every value as
     * `PDO::PARAM_STR` regardless of its PHP type (the exact quirk
     * {@see \Tasker\Access\OuScopeResolver::descendantIds()} already
     * documents for a different column) — harmless for the int/string/null
     * columns here, but fatal for `pinned`: PHP's `(string) false` is `''`,
     * and PostgreSQL's boolean parser rejects an empty string
     * (`SQLSTATE[22P02]: invalid input syntax for type boolean: ''`).
     * Confirmed empirically: both `readyWork()` tests below errored on
     * exactly this before `:pinned` was pulled out into its own
     * `bindValue(..., PDO::PARAM_BOOL)` call, matching the same explicit-bool
     * pattern {@see \Tasker\Api\ProjectsApiHandler::list()} already uses for
     * `:unrestricted`.
     *
     * `$groupId` was added (trailing, nullable, defaulted) for the
     * BoardApiHandler tests below, which need a task placed inside a group
     * rather than left ungrouped — every existing call site keeps working
     * unchanged since it's optional and appended last.
     */
    private function makeTaskDirect(
        int $tenantId,
        int $projectId,
        int $sectionId,
        string $text,
        ?string $priority = null,
        bool $pinned = false,
        ?string $dueDate = null,
        int $sortOrder = 0,
        ?int $groupId = null
    ): int {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_tasks (public_id, tenant_id, project_id, section_id, group_id, text, priority, pinned, due_date, sort_order, status, created_by, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, :section_id, :group_id, :text, :priority, :pinned, :due_date, :sort_order, 'pending', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             RETURNING id"
        );
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':group_id', $groupId, $groupId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':text', $text, PDO::PARAM_STR);
        $stmt->bindValue(':priority', $priority, $priority === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':pinned', $pinned, PDO::PARAM_BOOL);
        $stmt->bindValue(':due_date', $dueDate, $dueDate === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':sort_order', $sortOrder, PDO::PARAM_INT);
        $stmt->execute();

        return (int) $stmt->fetchColumn();
    }

    private function makeGroupDirect(int $tenantId, int $sectionId, string $name = 'Frontend'): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_groups (public_id, tenant_id, section_id, name, slug, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :section_id, :name, :slug, CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->execute([
            ':tenant_id' => $tenantId,
            ':section_id' => $sectionId,
            ':name' => $name,
            ':slug' => strtolower($name),
        ]);

        return (int) $stmt->fetchColumn();
    }

    private function makeMilestoneDirect(int $tenantId, int $taskId, string $summary, bool $checked = false): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_milestones (public_id, tenant_id, task_id, summary, checked, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :task_id, :summary, :checked, CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':task_id', $taskId, PDO::PARAM_INT);
        $stmt->bindValue(':summary', $summary, PDO::PARAM_STR);
        // bindValue(..., PDO::PARAM_BOOL), not a plain execute() array — the
        // same reason `:pinned` above needs it: PDOStatement::execute(array)
        // binds every value as PDO::PARAM_STR, and PHP's (string) false is
        // '', which PostgreSQL's boolean parser rejects.
        $stmt->bindValue(':checked', $checked, PDO::PARAM_BOOL);
        $stmt->execute();

        return (int) $stmt->fetchColumn();
    }

    public function testUserInParentOuSeesProjectInChildOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $childProjectId = $this->makeProjectDirect(7, 2, 'child project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 1)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($childProjectId, $ids);
    }

    public function testUserInChildOuDoesNotSeeProjectInParentOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $parentProjectId = $this->makeProjectDirect(7, 1, 'parent project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 2)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertNotContains($parentProjectId, $ids, 'visibility must never flow upward');
    }

    public function testUserInOneBranchDoesNotSeeASiblingBranchsProject(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'sibling project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 2)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertNotContains($siblingProjectId, $ids);
    }

    public function testNullOuCallerSeesEveryProjectInTheTenant(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $rootId = $this->makeProjectDirect(7, null, 'root project');
        $childId = $this->makeProjectDirect(7, 2, 'deep project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, null)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($rootId, $ids);
        self::assertContains($childId, $ids);
    }

    public function testNullOuIdProjectIsVisibleToEveryone(): void
    {
        $this->makeOu(1, 7, null);
        $rootId = $this->makeProjectDirect(7, null, 'tenant-root project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 1)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($rootId, $ids, 'a project with no ou_id is visible tenant-wide');
    }

    public function testCreateRejectsAnEmptyName(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->create(7, null, 1, json_encode(['name' => '  ']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCreateRejectsAnOuIdOutsideTheCallersScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller is scoped to OU 2; OU 3 is a sibling, outside their scope.
        $response = $handler->create(7, 2, 1, json_encode(['name' => 'Sneaky', 'ou_id' => 3]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testCreateWithoutOuIdDefaultsToTheCallersOwnOuNotTenantRoot(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller restricted to OU 2 creates a project WITHOUT an ou_id in the body.
        $created = json_decode(
            $handler->create(7, 2, 1, json_encode(['name' => 'Scoped by default']))->getBody(),
            true
        );

        self::assertSame(2, $created['data']['ouId'], 'omitting ou_id must scope to the caller\'s own OU, not tenant-root');

        // A sibling OU (3) must never see it — proves omitting ou_id cannot
        // widen visibility the way a bare `ou_id: null` default used to.
        $siblingPayload = json_decode($handler->list(7, 3)->getBody(), true);
        $siblingIds = array_column($siblingPayload['data'], 'id');
        self::assertNotContains($created['data']['id'], $siblingIds);
    }

    public function testUpdateRejectsWideningAnOuScopedProjectToNull(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, 2, 'Scoped project');

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller scoped to OU 2 already owns this project, but must not be
        // able to unilaterally widen it to tenant-wide visibility.
        $response = $handler->update(7, 2, $projectId, json_encode(['ou_id' => null]));

        self::assertSame(422, $response->getStatusCode());

        $row = $this->pdo->query("SELECT ou_id FROM tasker_projects WHERE id = {$projectId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame(2, (int) $row['ou_id'], 'a rejected update must not silently widen the project\'s ou_id');
    }

    public function testUnrestrictedCallerCanStillCreateAndUpdateWithNullOuId(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);

        $created = json_decode(
            $handler->create(7, null, 1, json_encode(['name' => 'Root project', 'ou_id' => null]))->getBody(),
            true
        );
        self::assertNull($created['data']['ouId']);

        $response = $handler->update(7, null, (int) $created['data']['id'], json_encode(['ou_id' => null]));
        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertNull($payload['data']['ouId'], 'a tenant-root caller must still be able to leave/set a project tenant-wide');
    }

    public function testUpdateChangesNameAndPrefix(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Original Name');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['name' => 'Renamed', 'prefix' => 'REN']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame('REN', $payload['data']['prefix']);
    }

    public function testUpdateRejectsAnInvalidPrefix(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Prefix test');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['prefix' => 'toolongprefix']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testUpdateRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $parentProjectId = $this->makeProjectDirect(7, 1, 'Parent project');

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller scoped to child OU 2 cannot update a project that lives in parent OU 1.
        $response = $handler->update(7, 2, $parentProjectId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUpdateRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $otherTenantProjectId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheProjectAndItsBacklogSection(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $created = json_decode($handler->create(7, null, 1, json_encode(['name' => 'Doomed project']))->getBody(), true);
        $projectId = (int) $created['data']['id'];

        $response = $handler->delete(7, null, $projectId);

        self::assertSame(204, $response->getStatusCode());

        $projectCount = (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();
        $sectionCount = (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_sections WHERE project_id = {$projectId}")->fetchColumn();
        self::assertSame(0, $projectCount);
        self::assertSame(0, $sectionCount, 'the default Backlog section must cascade-delete with its project');
    }

    public function testDeleteRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->delete(7, null, $otherTenantProjectId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testReadyWorkExcludesDoneTasks(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Ready work project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $doneTaskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Already done');
        $this->pdo->exec("UPDATE tasker_tasks SET status = 'done' WHERE id = {$doneTaskId}");
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Still open');

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->readyWork(7, null, $projectId)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('Still open', $payload['data'][0]['text']);
    }

    public function testReadyWorkOrdersPinnedAndHigherPriorityFirst(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Ranking project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Low priority', 'low');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Rush, unpinned', 'rush');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Pinned, no priority', null, true);

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->readyWork(7, null, $projectId)->getBody(), true);

        self::assertSame('Pinned, no priority', $payload['data'][0]['text'], 'pinned always sorts first, regardless of priority');
        self::assertSame('Rush, unpinned', $payload['data'][1]['text']);
        self::assertSame('Low priority', $payload['data'][2]['text']);
    }

    public function testReadyWorkRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, 1, 'Parent OU project');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->readyWork(7, 2, $projectId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * readyWork()'s ORDER BY has four keys: pinned DESC, priority CASE,
     * due_date ASC NULLS LAST, sort_order ASC. The two tests above only
     * exercise the first two; this one holds pinned/priority EQUAL across
     * all three tasks and proves the remaining two keys actually apply:
     * an earlier due_date ranks first, a null due_date ranks last (NULLS
     * LAST, not the default ascending-treats-null-as-smallest), and among
     * fully-tied rows sort_order breaks the tie.
     */
    public function testReadyWorkOrdersByDueDateThenSortOrderWhenPinnedAndPriorityAreEqual(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Due date tiebreak project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $this->makeTaskDirect(7, $projectId, $sectionId, 'No due date', null, false, null, 0);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Due later, sort 5', null, false, '2027-01-01', 5);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Due later, sort 1', null, false, '2027-01-01', 1);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Due soonest', null, false, '2026-01-01', 0);

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->readyWork(7, null, $projectId)->getBody(), true);

        self::assertSame('Due soonest', $payload['data'][0]['text'], 'the earliest due_date ranks first');
        self::assertSame('Due later, sort 1', $payload['data'][1]['text'], 'among equal due_dates, the lower sort_order ranks first');
        self::assertSame('Due later, sort 5', $payload['data'][2]['text']);
        self::assertSame('No due date', $payload['data'][3]['text'], 'a null due_date ranks LAST, not first');
    }

    /**
     * Regression test for a Critical review finding: `toPublicTask()` used
     * to read `pinned` via a naive `(bool) $row['pinned']` cast, which would
     * misreport an unpinned task as pinned if pdo_pgsql ever returns the
     * column as the string "f" (a naive `(bool) 'f'` is `true` in PHP).
     * Exercising `pin()` then `unpin()` against REAL PostgreSQL — not the
     * SQLite double, which can't reproduce this — also happens to be the
     * only way to prove `unpin()` (pinned = false) doesn't itself throw:
     * `setPinned()` used to bind `:pinned` through a plain array-`execute()`
     * call, which binds every value as PDO::PARAM_STR, and PHP's
     * `(string) false` is `''` — which PostgreSQL's boolean parser rejects
     * outright, so `unpin()` 500'd on every call before that fix too. Both
     * bugs are covered by this one round trip.
     */
    public function testUnpinReportsPinnedAsBooleanFalseOverRealPostgres(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Pin coercion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Pin toggle');

        $handler = new TasksApiHandler($this->pdo);

        $pinned = $handler->pin(7, $taskId);
        self::assertSame(200, $pinned->getStatusCode());
        $pinnedPayload = json_decode($pinned->getBody(), true);
        self::assertTrue($pinnedPayload['data']['pinned']);

        $unpinned = $handler->unpin(7, $taskId);
        self::assertSame(200, $unpinned->getStatusCode(), 'unpin() must not 500 when binding pinned = false against Postgres');
        $unpinnedPayload = json_decode($unpinned->getBody(), true);
        self::assertFalse($unpinnedPayload['data']['pinned'], 'a real boolean false, not a truthy string representation of it');
    }

    /**
     * BoardApiHandler::get()'s composition — sections, groups, each group's
     * tasks, each task's milestones, and ungroupedTasks for tasks with no
     * group_id — proven here rather than a SQLite unit test; see this
     * class's own docblock for why findProject()'s unconditional
     * OuScopeResolver::whereFragment() call rules that out entirely, not
     * just for the OU-restricted cases below.
     */
    public function testGetComposesSectionsGroupsTasksAndMilestones(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Board project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $groupId = $this->makeGroupDirect(7, $sectionId);
        $groupedTaskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Ship it', null, false, null, 0, $groupId);
        $this->makeMilestoneDirect(7, $groupedTaskId, 'Write code');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Loose task');

        $handler = new BoardApiHandler($this->pdo);
        $payload = json_decode($handler->get(7, null, $projectId)->getBody(), true);

        self::assertSame($projectId, $payload['data']['project']['id']);
        self::assertCount(1, $payload['data']['sections']);
        self::assertSame('Backlog', $payload['data']['sections'][0]['name']);
        self::assertCount(1, $payload['data']['sections'][0]['groups']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks']);
        self::assertSame('Ship it', $payload['data']['sections'][0]['groups'][0]['tasks'][0]['text']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks'][0]['milestones']);
        self::assertSame('Write code', $payload['data']['sections'][0]['groups'][0]['tasks'][0]['milestones'][0]['summary']);
        self::assertCount(1, $payload['data']['sections'][0]['ungroupedTasks'], 'the un-grouped task must surface under ungroupedTasks, not be dropped');
        self::assertSame('Loose task', $payload['data']['sections'][0]['ungroupedTasks'][0]['text']);
    }

    public function testGet404sForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new BoardApiHandler($this->pdo);
        $response = $handler->get(7, null, $otherTenantProjectId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testGetShowsAParentOuCallerAChildOusProjectBoard(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $childProjectId = $this->makeProjectDirect(7, 2, 'Child OU project');
        $sectionId = $this->makeSectionDirect(7, $childProjectId);
        $this->makeTaskDirect(7, $childProjectId, $sectionId, 'Visible to the parent');

        $handler = new BoardApiHandler($this->pdo);
        $payload = json_decode($handler->get(7, 1, $childProjectId)->getBody(), true);

        self::assertSame($childProjectId, $payload['data']['project']['id']);
        self::assertSame('Visible to the parent', $payload['data']['sections'][0]['ungroupedTasks'][0]['text']);
    }

    public function testGet404sForASiblingOuCallersBoard(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');

        $handler = new BoardApiHandler($this->pdo);
        // Caller scoped to OU 2; the project lives in sibling OU 3.
        $response = $handler->get(7, 2, $siblingProjectId);

        self::assertSame(404, $response->getStatusCode());
    }
}
