<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Access\IdentifierResolver;
use Tasker\Api\BoardApiHandler;
use Tasker\Api\GroupsApiHandler;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\SectionsApiHandler;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\AddTaskerTaskShortIdUnique;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\TaskerPlugin;

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
        // REGRESSION FIX (whole-branch review finding C2): this defaulted to
        // `dbname=tasker` — the live, SHARED host database — so running this
        // suite locally while `npm run host:up` is up would DESTROY Tasker's
        // real data (every test DROPs/DELETEs its fixture tables). The
        // default now points at a disposable `tasker_test` database instead.
        // The TASKER_TEST_PG_DSN/_USER/_PASS env var override mechanism is
        // unchanged — CI sets these explicitly to point at its own Postgres
        // service (see .github/workflows/ci.yml); a local run against the
        // real `tasker` db remains possible by setting TASKER_TEST_PG_DSN
        // explicitly, it is simply no longer the silent default.
        $dsn = getenv('TASKER_TEST_PG_DSN');
        $user = getenv('TASKER_TEST_PG_USER') ?: 'tasker';
        $pass = getenv('TASKER_TEST_PG_PASS') ?: 'tasker_dev';
        $candidates = $dsn !== false
            ? [$dsn]
            : ['pgsql:host=host.docker.internal;port=5433;dbname=tasker_test', 'pgsql:host=localhost;port=5433;dbname=tasker_test'];

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
        // REGRESSION FIX (whole-branch review finding C2): this suite used to
        // assume it was always running against the host's own live,
        // already-migrated database, so `tenants`/`organizational_units`
        // already existed with the host's real (richer) shape. That
        // assumption breaks CI's whole point here: a genuinely fresh
        // `postgres:15` service container has NEITHER table, and no host
        // migrations are run against it (CI only needs Postgres + pdo_pgsql,
        // nothing else). Both tables are now created here, matching the
        // real host schema closely enough (NOT NULL name/slug, the same
        // uniqueness constraints) that this is a genuine no-op against the
        // shared dev database (where both already exist in this exact
        // shape) AND makes this suite fully self-sufficient against a bare
        // Postgres server with no pre-existing schema at all.
        $this->pdo->exec('
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                slug VARCHAR(255) UNIQUE,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ');
        $this->pdo->exec('
            CREATE TABLE IF NOT EXISTS organizational_units (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                parent_id INTEGER NULL REFERENCES organizational_units(id),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                description TEXT DEFAULT \'\',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT tasker_test_ou_tenant_name_unique UNIQUE (tenant_id, name),
                CONSTRAINT tasker_test_ou_tenant_slug_unique UNIQUE (tenant_id, slug)
            )
        ');
        // D1b Task 10: added `description` above (missing from this fixture
        // until now — a real gap against the live host schema, see
        // host/.core/database/migrations/005_create_organizational_units.php
        // — surfaced because OusApiHandler::create()/update() unconditionally
        // write that column; every prior test in this file happened to only
        // ever touch organizational_units via makeOu()'s own explicit INSERT,
        // which never mentioned description, so the gap had no coverage to
        // catch it before the Environment alias tests below started calling
        // OusApiHandler for real.
        //
        // ADD COLUMN IF NOT EXISTS covers a table that already exists from a
        // PRIOR run of this suite (CREATE TABLE IF NOT EXISTS above is a
        // no-op against it) predating this fixture change.
        $this->pdo->exec("ALTER TABLE organizational_units ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''");
        $this->pdo->exec('DELETE FROM organizational_units WHERE tenant_id IN (7, 9)');

        // D1b Task 10: the append-only audit trail core's AuditLogger writes
        // to (host/.core/database/migrations/016_create_audit_log.php),
        // needed by the Environment alias tests below, which prove
        // create/rename/delete_environment really do dispatch core's ou.*
        // hooks by subscribing a real AuditLogger and reading this table
        // back — not by asserting on the hook dispatch mechanism in isolation.
        $this->pdo->exec("
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                actor_user_id INTEGER NULL,
                action VARCHAR(100) NOT NULL,
                target_type VARCHAR(100) NULL,
                target_id INTEGER NULL,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ");
        $this->pdo->exec('DELETE FROM audit_log WHERE tenant_id IN (7, 9)');

        // D1b Task 10: OusApiHandler::delete() unconditionally counts active
        // memberships::ou_id before allowing a delete (host/.core's real
        // ADR-0005-§3 shape, host/.core/database/migrations/030_create_memberships.php).
        // A minimal local shape (no profiles/roles FKs, matching this file's
        // own "close enough to real schema" convention for tenants/
        // organizational_units above) is enough: the environment alias tests
        // below never insert a membership row, so the count is always 0 and
        // the delete is always permitted -- but the table must EXIST or
        // that COUNT query itself throws.
        $this->pdo->exec('
            CREATE TABLE IF NOT EXISTS memberships (
                id SERIAL PRIMARY KEY,
                profile_id INTEGER NOT NULL,
                tenant_id INTEGER NOT NULL,
                role_id INTEGER NOT NULL,
                ou_id INTEGER NULL,
                status VARCHAR(32) NOT NULL DEFAULT \'active\',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ');

        $this->ensureTestTenant(7);
        $this->ensureTestTenant(9);

        (new CreateTaskerProjectsTable())->up($this->pdo);
        (new CreateTaskerSectionsTable())->up($this->pdo);
        // Drop order matters: tasker_milestones and tasker_task_discussions
        // both FK-reference tasker_tasks, so both must be dropped before
        // tasker_tasks — otherwise `DROP TABLE tasker_tasks CASCADE` only
        // cascade-drops the FK CONSTRAINT on the referencing table (Postgres
        // semantics for a referenced table being dropped), leaving the table
        // itself, and any stale rows from a PRIOR test run, in place for the
        // next test.
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_milestones CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_task_discussions CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_tasks CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_groups CASCADE');
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);
        // Registered here too, not just in TaskerPlugin::getMigrations():
        // without it, tasker_tasks carries no UNIQUE (project_id, short_id)
        // constraint on this suite's disposable tasker_test database, and
        // testShortIdUniqueConstraintRejectsADuplicate below would find
        // nothing to reject.
        (new AddTaskerTaskShortIdUnique())->up($this->pdo);
        (new CreateTaskerMilestonesTable())->up($this->pdo);
        (new CreateTaskerTaskDiscussionsTable())->up($this->pdo);
    }

    /**
     * D1b Task 10: unconditional cleanup for the two pieces of PROCESS-GLOBAL
     * state the Environment alias tests below touch —
     * \Whity\Core\Tenant\TenantContext's static tenant id (setTenantId()
     * LOCKS after the first call; a second call anywhere else in this same
     * PHPUnit process would throw) and the two \Whity\register_service()
     * container entries they register. Runs after EVERY test in this class
     * (not just the environment ones) so a leak can never depend on which
     * tests happen to run before/after which — the same reason
     * TaskerPluginTest::tearDown() unconditionally resets $_GET regardless of
     * whether the specific test that ran touched it.
     */
    protected function tearDown(): void
    {
        \Whity\Core\Tenant\TenantContext::reset();
        unset($GLOBALS['whity_services'][\Whity\Database\Database::class]);
        unset($GLOBALS['whity_services'][\Whity\Core\Hooks\HookManager::class]);
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

    // ==================== ProjectsApiHandler::getOne() (D1b Task 8: get_project) ====================

    public function testGetProjectOmitsTaskDetailUnlessIncludeNotesIsSet(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Notes Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId    = $this->makeTaskDirect(7, $projectId, $sectionId, 'Has detail');
        $this->pdo->exec("UPDATE tasker_tasks SET detail = 'the long detail' WHERE id = {$taskId}");

        $handler = new ProjectsApiHandler($this->pdo);

        $without = json_decode($handler->getOne(7, null, $projectId, false)->getBody(), true);
        $task = $without['data']['sections'][0]['tasks'][0];
        self::assertArrayNotHasKey('detail', $task, 'detail must be omitted by default — it can be very large');

        $with = json_decode($handler->getOne(7, null, $projectId, true)->getBody(), true);
        self::assertSame('the long detail', $with['data']['sections'][0]['tasks'][0]['detail']);
    }

    public function testGetProjectIncludesTasksOfEveryStatus(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Full read project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $doneTaskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Already done');
        $this->pdo->exec("UPDATE tasker_tasks SET status = 'done' WHERE id = {$doneTaskId}");
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Still open');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->getOne(7, null, $projectId, false)->getBody(), true);

        // Unlike list_tasks (which excludes done by default), get_project is a
        // full project read a UI renders -- a done task must not disappear.
        self::assertCount(2, $payload['data']['sections'][0]['tasks']);
    }

    public function testGetProjectIs404OutsideOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');

        $handler = new ProjectsApiHandler($this->pdo);

        self::assertSame(404, $handler->getOne(7, 2, $sibling, false)->getStatusCode());
    }

    public function testGetProjectRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->getOne(7, null, $otherTenantProjectId, false);

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

    // ==================== SectionsApiHandler (whole-branch review finding C1) ====================
    //
    // list()/create() moved here from the old (now removed) SQLite-backed
    // cases in SectionsApiHandlerTest.php: both now call
    // OuScopeResolver::whereFragment() unconditionally, which SQLite's
    // PDO::prepare() rejects outright. Plus new OU-boundary regression tests.

    public function testSectionsCreateAddsASecondSectionToTheProject(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Section project');
        $this->makeSectionDirect(7, $projectId);

        $handler = new SectionsApiHandler($this->pdo);
        $response = $handler->create(7, null, $projectId, json_encode(['name' => 'In Progress']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('In Progress', $payload['data']['name']);
        self::assertSame('in-progress', $payload['data']['slug']);
    }

    public function testSectionsCreateRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new SectionsApiHandler($this->pdo);
        $response = $handler->create(7, null, $otherTenantProjectId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testSectionsListReturnsSectionsForTheGivenProjectAndTenant(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Section project');
        $this->makeSectionDirect(7, $projectId);

        $handler = new SectionsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, null, $projectId)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('Backlog', $payload['data'][0]['name']);
    }

    /**
     * Regression test proving the C1 fix: {projectId} is a path parameter,
     * not a discovered value -- an OU-restricted caller must not be able to
     * list a sibling OU's project's sections by simply iterating project ids.
     */
    public function testSectionsListRejects404ForAProjectInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $this->makeSectionDirect(7, $siblingProjectId);

        $handler = new SectionsApiHandler($this->pdo);
        // Caller scoped to OU 2; the project lives in sibling OU 3.
        $response = $handler->list(7, 2, $siblingProjectId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Same as above, for create_section: an OU-restricted caller must not be
     * able to CREATE a section under a sibling OU's project either.
     */
    public function testSectionsCreateRejects404ForAProjectInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');

        $handler = new SectionsApiHandler($this->pdo);
        $response = $handler->create(7, 2, $siblingProjectId, json_encode(['name' => 'Should not leak']));

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== GroupsApiHandler (whole-branch review finding C1) ====================

    public function testGroupsCreateStampsTheCallersTenantAndTheGivenSection(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Group project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->create(7, null, $sectionId, json_encode(['name' => 'Backend']));

        self::assertSame(201, $response->getStatusCode());
        $row = $this->pdo->query(
            "SELECT tenant_id, section_id, name, slug FROM tasker_groups WHERE section_id = {$sectionId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame($sectionId, (int) $row['section_id']);
        self::assertSame('Backend', $row['name']);
        self::assertSame('backend', $row['slug']);
    }

    public function testGroupsCreateRejects404ForASectionOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);

        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->create(7, null, $otherSectionId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testGroupsListReturnsOnlyGroupsForTheGivenSectionAndTenant(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Group project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $this->makeGroupDirect(7, $sectionId, 'A');

        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $this->makeGroupDirect(9, $otherSectionId, 'B');

        $handler = new GroupsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, null, $sectionId)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['name']);
    }

    public function testGroupsListRejects404ForASectionOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);

        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->list(7, null, $otherSectionId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testGroupsListRejects404ForANonexistentSection(): void
    {
        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->list(7, null, 999999);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Regression test proving the C1 fix: {sectionId} is a path parameter --
     * an OU-restricted caller must not be able to list a sibling OU's
     * section's groups by iterating section ids.
     */
    public function testGroupsListRejects404ForASectionInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);

        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->list(7, 2, $siblingSectionId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testGroupsCreateRejects404ForASectionInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);

        $handler = new GroupsApiHandler($this->pdo);
        $response = $handler->create(7, 2, $siblingSectionId, json_encode(['name' => 'Should not leak']));

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== TasksApiHandler::create() (whole-branch review finding C1) ====================
    //
    // TASK REVIEW (D1b Task 6): a first draft of this task removed create()'s
    // own OU-aware section check entirely, reasoning that
    // TaskerPlugin::createTask() now resolves section_id via
    // IdentifierResolver::resolveSection() (itself OU-aware) before create()
    // ever runs, making the check here redundant. That reasoning was true
    // TODAY but not load-bearing: SectionsApiHandler::create()/
    // GroupsApiHandler::create() keep their OWN internal OU check for the
    // exact same "the route also resolves it first" reason, and readyWork()
    // (this very file, below) keeps its own isProjectVisible() despite
    // getReadyWork() pre-resolving the project too — so removing it here
    // alone broke that established belt-and-braces precedent. Restored.

    public function testTasksCreateStampsTenantAndDefaultsStatusToPending(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Task project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, null, $sectionId, 3, json_encode(['text' => 'Ship it']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertSame('Ship it', $payload['data']['text']);
        self::assertNull($payload['data']['priority']);
    }

    public function testTasksCreateRejects404ForASectionOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, null, $otherSectionId, 3, json_encode(['text' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testTasksCreateAcceptsAValidPriority(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Task project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, null, $sectionId, 3, json_encode(['text' => 'Urgent', 'priority' => 'rush']));

        $payload = json_decode($response->getBody(), true);
        self::assertSame('rush', $payload['data']['priority']);
    }

    public function testTasksCreateRejectsAnInvalidPriority(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Task project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, null, $sectionId, 3, json_encode(['text' => 'Bad', 'priority' => 'urgent-ish']));

        self::assertSame(400, $response->getStatusCode());
    }

    /**
     * D1b Task 6: create() gained detail/due_date INSERT handling (the
     * create_task interface contract requires both). Proven here rather than
     * TasksApiHandlerTest.php since create() itself still needs Postgres.
     */
    public function testTasksCreateAcceptsDetailAndDueDate(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Task project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, null, $sectionId, 3, json_encode([
            'text' => 'With extras',
            'detail' => 'Cold-reader context',
            'due_date' => '2026-09-01',
        ]));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Cold-reader context', $payload['data']['detail']);
        self::assertSame('2026-09-01', $payload['data']['dueDate']);
    }

    /**
     * Regression test proving the C1 fix: {sectionId} is a path parameter --
     * an OU-restricted caller must not be able to create a task under a
     * sibling OU's section by iterating section ids.
     */
    public function testTasksCreateRejects404ForASectionInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->create(7, 2, $siblingSectionId, 3, json_encode(['text' => 'Should not leak']));

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== TasksApiHandler::getOne() (D1b Task 8: get_task) ====================
    //
    // getOne() is OU-aware (D1b Task 8 brief resolution #2: tasker_tasks.id is
    // a sequential BIGSERIAL, so a tenant-scoped-only lookup would let an
    // OU-restricted caller reach a sibling OU's task simply by counting
    // upward through ids -- the same reasoning that made create()'s own
    // section check and MilestonesApiHandler::taskVisible() real). ALL of its
    // coverage lives here, in the Postgres tier, not in TasksApiHandlerTest.php
    // (SQLite) -- unlike create(), where only the OU-boundary cases moved
    // here and the plain shape/CRUD tests stayed on SQLite. getOne() has NO
    // SQLite-safe path at all, not even with a null caller OU:
    // OuScopeResolver::whereFragment() embeds PostgreSQL's `= ANY(:scope)` in
    // the SQL TEXT unconditionally (never a runtime-branched query, per this
    // whole fix's own static-SQL-template rule), so SQLite's PDO::prepare()
    // rejects it before any parameter -- including :unrestricted -- is ever
    // bound. Every other OU-aware method in this codebase (ProjectsApiHandler
    // ::findScoped(), BoardApiHandler::findProject(), TasksApiHandler's own
    // create()/isProjectVisible(), MilestonesApiHandler::taskVisible(),
    // TaskDiscussionsApiHandler::taskVisible()) is Postgres-only for exactly
    // the same reason, confirmed by grepping this codebase for every
    // whereFragment() call site: none has SQLite coverage, including the
    // ones exercised with a null caller OU.

    public function testTasksGetOneReturnsTheTaskWithItsMilestonesOrderedBySortOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Get task project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'With milestones');
        $this->makeMilestoneDirect(7, $taskId, 'Second step');
        $this->pdo->exec("UPDATE tasker_milestones SET sort_order = 2 WHERE task_id = {$taskId}");
        $firstId = $this->makeMilestoneDirect(7, $taskId, 'First step');
        $this->pdo->exec("UPDATE tasker_milestones SET sort_order = 1 WHERE id = {$firstId}");

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->getOne(7, null, $taskId)->getBody(), true);

        self::assertSame('With milestones', $payload['data']['text']);
        self::assertCount(2, $payload['data']['milestones']);
        self::assertSame('First step', $payload['data']['milestones'][0]['summary'], 'milestones must be ordered by sort_order, not insertion order');
        self::assertSame('Second step', $payload['data']['milestones'][1]['summary']);
    }

    public function testTasksGetOneRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->getOne(7, null, $otherTaskId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * The stronger of the two boundary tests the brief asks for -- a
     * cross-tenant 404 alone would not catch a missing OU check, since a
     * missing tenant_id predicate and a missing OU predicate are different
     * bugs. Proves the D1b Task 8 brief resolution #2 fix directly: without
     * getOne()'s own OU-aware join, a caller scoped to OU 2 could reach OU
     * 3's task simply by supplying its id.
     */
    public function testTasksGetOneRejects404ForASiblingOusTask(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Should not leak');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->getOne(7, 2, $siblingTaskId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * D1b Task 6, task review finding #2: TaskerPlugin::moveTask() must
     * resolve section_id/group_id destination identifiers through
     * IdentifierResolver (UUID/id, exactly like every other identifier in
     * this task's routes) BEFORE delegating to TasksApiHandler::move(),
     * which itself only ever does a plain `(int)` cast on whatever it is
     * handed. This proves the two-step composition end to end against real
     * Postgres: resolve a section's UUID to its real id (the same call
     * moveTask() itself makes), then feed that resolved id to move() — a
     * genuine UUID destination round-trips correctly, not just casts to 0
     * and 422s. moveTask() itself cannot be exercised directly (it calls
     * resolvePdo(), which needs the live host container — see
     * TaskerPluginTest's own note on this); this is the closest equivalent.
     */
    public function testMoveResolvesASectionUuidDestinationBeforeDelegatingToMove(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Move by UUID project');
        $sourceSectionId = $this->makeSectionDirect(7, $projectId);
        // makeSectionDirect() always stamps slug='backlog' (see its own
        // docblock), so the second section in the SAME project (move() only
        // allows moving within one project) needs a distinct slug, inserted
        // directly to avoid the (project_id, slug) unique violation.
        $targetStmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, 'In Progress', 'in-progress', CURRENT_TIMESTAMP) RETURNING id"
        );
        $targetStmt->execute([':tenant_id' => 7, ':project_id' => $projectId]);
        $targetSectionId = (int) $targetStmt->fetchColumn();
        $targetPublicId = (string) $this->pdo
            ->query("SELECT public_id FROM tasker_sections WHERE id = {$targetSectionId}")
            ->fetchColumn();
        $taskId = $this->makeTaskDirect(7, $projectId, $sourceSectionId, 'Move me by uuid');

        $resolvedSectionId = IdentifierResolver::resolveSection($this->pdo, 7, null, $targetPublicId);
        self::assertSame($targetSectionId, $resolvedSectionId, 'the UUID must resolve to the real target section id');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->move(7, $taskId, json_encode(['section_id' => $resolvedSectionId]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetSectionId, $payload['data']['sectionId']);
    }

    // ==================== ShortIdAllocator (Task 2: short_id allocation) ====================

    public function testShortIdIsAllocatedSequentiallyPerProject(): void
    {
        $projectA = $this->makeProjectDirect(7, null, 'Project A');
        $projectB = $this->makeProjectDirect(7, null, 'Project B');
        $sectionA = $this->makeSectionDirect(7, $projectA);
        $sectionB = $this->makeSectionDirect(7, $projectB);

        $handler = new TasksApiHandler($this->pdo);

        $first  = json_decode($handler->create(7, null, $sectionA, 1, json_encode(['text' => 'A1']))->getBody(), true);
        $second = json_decode($handler->create(7, null, $sectionA, 1, json_encode(['text' => 'A2']))->getBody(), true);
        $other  = json_decode($handler->create(7, null, $sectionB, 1, json_encode(['text' => 'B1']))->getBody(), true);

        self::assertSame(1, $first['data']['shortId']);
        self::assertSame(2, $second['data']['shortId']);

        // Counters are per project, so B starts at 1 again.
        self::assertSame(1, $other['data']['shortId']);
    }

    public function testShortIdUniqueConstraintRejectsADuplicate(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Constraint Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId    = $this->makeTaskDirect(7, $projectId, $sectionId, 'First');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$taskId}");

        $second = $this->makeTaskDirect(7, $projectId, $sectionId, 'Second');

        // Proves the constraint exists and bites — without it, the allocator's
        // retry would be pointless because nothing would ever reject a race.
        $this->expectException(\PDOException::class);
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$second}");
    }

    // ==================== MilestonesApiHandler::create() (whole-branch review finding C1) ====================

    public function testMilestonesCreateDefaultsCheckedToFalse(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Milestone project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Task with milestones');

        $handler = new MilestonesApiHandler($this->pdo);
        $response = $handler->create(7, null, $taskId, json_encode(['summary' => 'Write tests']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertFalse($payload['data']['checked']);
    }

    public function testMilestonesCreateRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Other tenant task');

        $handler = new MilestonesApiHandler($this->pdo);
        $response = $handler->create(7, null, $otherTaskId, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Regression test proving the C1 fix: {taskId} is a path parameter -- an
     * OU-restricted caller must not be able to add a milestone to a sibling
     * OU's task by iterating task ids.
     */
    public function testMilestonesCreateRejects404ForATaskInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Sibling OU task');

        $handler = new MilestonesApiHandler($this->pdo);
        $response = $handler->create(7, 2, $siblingTaskId, json_encode(['summary' => 'Should not leak']));

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== TaskDiscussionsApiHandler (whole-branch review finding C1) ====================
    //
    // get()/put() moved here from the old (now removed) SQLite-backed
    // TaskDiscussionsApiHandlerTest.php: both now call
    // OuScopeResolver::whereFragment() unconditionally.

    public function testDiscussionGetOnATaskWithNoDiscussionYetReturnsAnEmptyShape(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $payload = json_decode($handler->get(7, null, $taskId)->getBody(), true);

        self::assertSame([], $payload['data']['messages']);
        self::assertNull($payload['data']['reason']);
    }

    public function testDiscussionGetRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Other tenant task');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $response = $handler->get(7, null, $otherTaskId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Regression test proving the C1 fix: {id}=task is a path parameter --
     * an OU-restricted caller must not be able to read a sibling OU's
     * task's discussion by iterating task ids.
     */
    public function testDiscussionGetRejects404ForATaskInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Sibling OU task');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $response = $handler->get(7, 2, $siblingTaskId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDiscussionPutCreatesTheDiscussionRowOnFirstWrite(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $body = json_encode(['messages' => [['role' => 'user', 'content' => 'hi']], 'reason' => 'testing']);
        $response = $handler->put(7, null, $taskId, $body);

        self::assertSame(200, $response->getStatusCode());

        $row = $this->pdo->query(
            "SELECT task_id, reason FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame($taskId, (int) $row['task_id']);
        self::assertSame('testing', $row['reason']);
    }

    public function testDiscussionPutUpdatesAnExistingDiscussionRowRatherThanDuplicating(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $handler->put(7, null, $taskId, json_encode(['messages' => [], 'reason' => 'first']));
        $handler->put(7, null, $taskId, json_encode(['messages' => [], 'reason' => 'second']));

        $count = (int) $this->pdo->query(
            "SELECT COUNT(*) FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetchColumn();
        self::assertSame(1, $count);

        $row = $this->pdo->query(
            "SELECT reason FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame('second', $row['reason']);
    }

    public function testDiscussionPutRejectsAMalformedOrNonObjectBodyAndDoesNotOverwriteExistingData(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $handler->put(7, null, $taskId, json_encode([
            'messages' => [['role' => 'user', 'content' => 'keep me']],
            'reason' => 'keep this reason',
        ]));

        $malformed = $handler->put(7, null, $taskId, 'not valid json at all');
        self::assertSame(400, $malformed->getStatusCode());

        $nonObject = $handler->put(7, null, $taskId, json_encode([1, 2, 3]));
        self::assertSame(400, $nonObject->getStatusCode());

        $row = $this->pdo->query(
            "SELECT messages, reason FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame('keep this reason', $row['reason']);
        self::assertSame([['role' => 'user', 'content' => 'keep me']], json_decode((string) $row['messages'], true));
    }

    public function testDiscussionPutRejectsANonScalarReasonAndDoesNotOverwriteExistingData(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $handler->put(7, null, $taskId, json_encode(['messages' => [], 'reason' => 'original reason']));

        $body = json_encode([
            'messages' => [['role' => 'user', 'content' => 'should not be saved']],
            'reason' => ['nested' => 'object'],
        ]);
        $response = $handler->put(7, null, $taskId, $body);

        self::assertSame(400, $response->getStatusCode());

        $row = $this->pdo->query(
            "SELECT messages, reason FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame('original reason', $row['reason']);
        self::assertSame([], json_decode((string) $row['messages'], true));
    }

    /**
     * Regression test for the whole-branch review's data-loss guard finding:
     * a structurally-valid PUT body whose `messages` field is present but
     * the WRONG TYPE (a string, not an array) must be rejected (400) BEFORE
     * touching the database -- not silently coerced to `[]`, which would
     * overwrite an existing conversation's real messages.
     */
    public function testDiscussionPutRejectsANonArrayMessagesFieldAndDoesNotOverwriteExistingData(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Discussion project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Discuss me');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $handler->put(7, null, $taskId, json_encode([
            'messages' => [['role' => 'user', 'content' => 'keep me']],
            'reason' => 'keep this reason',
        ]));

        $response = $handler->put(7, null, $taskId, json_encode(['messages' => 'hello']));

        self::assertSame(400, $response->getStatusCode());

        $row = $this->pdo->query(
            "SELECT messages, reason FROM tasker_task_discussions WHERE task_id = {$taskId}"
        )->fetch(PDO::FETCH_ASSOC);
        self::assertSame('keep this reason', $row['reason']);
        self::assertSame([['role' => 'user', 'content' => 'keep me']], json_decode((string) $row['messages'], true));
    }

    public function testDiscussionPutRejects404ForATaskInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Sibling OU task');

        $handler = new TaskDiscussionsApiHandler($this->pdo);
        $response = $handler->put(7, 2, $siblingTaskId, json_encode(['messages' => []]));

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== BoardApiHandler defensive fallback (whole-branch review finding I1) ====================

    /**
     * A task whose group_id points at a group that EXISTS but belongs to a
     * DIFFERENT project (not part of the groups BoardApiHandler::get()
     * fetches for the requested project) must still render -- under
     * ungroupedTasks for its own section -- rather than being silently
     * dropped from the response entirely. This state should not be
     * reachable through move() going forward (its own I1 fix validates
     * group_id against the task's own project/section), but the defensive
     * fallback protects against it regardless of how it arose.
     */
    public function testBoardFallsBackToUngroupedForATaskWithAGroupIdFromADifferentProject(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Project A');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Orphaned group ref');

        $otherProjectId = $this->makeProjectDirect(7, null, 'Project B');
        $otherSectionId = $this->makeSectionDirect(7, $otherProjectId);
        $otherGroupId = $this->makeGroupDirect(7, $otherSectionId, 'Foreign group');

        $this->pdo->exec("UPDATE tasker_tasks SET group_id = {$otherGroupId} WHERE id = {$taskId}");

        $handler = new BoardApiHandler($this->pdo);
        $payload = json_decode($handler->get(7, null, $projectId)->getBody(), true);

        self::assertCount(
            1,
            $payload['data']['sections'][0]['ungroupedTasks'],
            'a group_id from a different project must not silently drop the task from the response'
        );
        self::assertSame('Orphaned group ref', $payload['data']['sections'][0]['ungroupedTasks'][0]['text']);
    }

    // ==================== Duplicate-name -> 409, not 500 (whole-branch review finding I2) ====================

    public function testProjectsCreateRejects409ForADuplicateNameInTheSameTenant(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $first = $handler->create(7, null, 1, json_encode(['name' => 'Duplicate Project']));
        self::assertSame(201, $first->getStatusCode());

        $second = $handler->create(7, null, 1, json_encode(['name' => 'Duplicate Project']));

        self::assertSame(409, $second->getStatusCode());
    }

    public function testSectionsCreateRejects409ForADuplicateNameInTheSameProject(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Section dup project');
        $this->makeSectionDirect(7, $projectId); // the default Backlog, a distinct name.

        $handler = new SectionsApiHandler($this->pdo);
        $first = $handler->create(7, null, $projectId, json_encode(['name' => 'Sprint 1']));
        self::assertSame(201, $first->getStatusCode());

        $second = $handler->create(7, null, $projectId, json_encode(['name' => 'Sprint 1']));

        self::assertSame(409, $second->getStatusCode());
    }

    /**
     * The always-reproducible case the finding calls out specifically:
     * every project auto-creates a "Backlog" section
     * ({@see ProjectsApiHandler::create()}), so creating a section literally
     * named "Backlog" in that SAME project always collides on the
     * (project_id, slug) unique constraint.
     */
    public function testSectionsCreateRejects409ForTheBacklogAutoCollision(): void
    {
        $projectHandler = new ProjectsApiHandler($this->pdo);
        $created = json_decode(
            $projectHandler->create(7, null, 1, json_encode(['name' => 'Backlog collision project']))->getBody(),
            true
        );
        $projectId = (int) $created['data']['id'];

        $sectionHandler = new SectionsApiHandler($this->pdo);
        $response = $sectionHandler->create(7, null, $projectId, json_encode(['name' => 'Backlog']));

        self::assertSame(409, $response->getStatusCode());
    }

    public function testGroupsCreateRejects409ForADuplicateNameInTheSameSection(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Group dup project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $handler = new GroupsApiHandler($this->pdo);
        $first = $handler->create(7, null, $sectionId, json_encode(['name' => 'Frontend']));
        self::assertSame(201, $first->getStatusCode());

        $second = $handler->create(7, null, $sectionId, json_encode(['name' => 'Frontend']));

        self::assertSame(409, $second->getStatusCode());
    }

    // ==================== Tenant-root ou_id assignment validation (whole-branch review finding I5) ====================

    public function testProjectsCreateRejects422ForATenantRootCallerAssigningANonexistentOuId(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->create(7, null, 1, json_encode(['name' => 'Bad OU assignment', 'ou_id' => 999999]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testProjectsCreateRejects422ForATenantRootCallerAssigningAForeignTenantsOuId(): void
    {
        $this->makeOu(50, 9, null); // An OU that genuinely exists, but in a DIFFERENT tenant.

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->create(7, null, 1, json_encode(['name' => 'Foreign OU assignment', 'ou_id' => 50]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testProjectsUpdateRejects422ForATenantRootCallerAssigningANonexistentOuId(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Update OU project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['ou_id' => 999999]));

        self::assertSame(422, $response->getStatusCode());
    }

    // ==================== IdentifierResolver (Task 1 of the D1b plan) ====================
    //
    // resolveProject()/resolveTask() call OuScopeResolver::whereFragment(),
    // which emits Postgres-only `= ANY(:scope)` — unrunnable under SQLite at
    // PDO::prepare() time, before any binding. classify() itself is pure and
    // covered on SQLite in IdentifierResolverTest; everything here that
    // touches the database belongs against real Postgres instead.

    public function testResolveProjectAcceptsEveryIdentifierFormWithinScope(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Tasker Dev Env');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'TDE', slug = 'tasker-dev-env' WHERE id = {$projectId}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();

        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, $projectId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, (string) $projectId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, $publicId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, 'TDE'));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, 'tasker-dev-env'));
    }

    public function testResolveProjectRefusesEveryFormAcrossATenantBoundary(): void
    {
        $foreign = $this->makeProjectDirect(9, null, 'Foreign Project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'FGN', slug = 'foreign-project' WHERE id = {$foreign}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$foreign}")->fetchColumn();

        // Caller is tenant 7. Every form must miss.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, $foreign));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, $publicId));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, 'FGN'));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, 'foreign-project'));
    }

    public function testResolveProjectRefusesEveryFormAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling Branch Project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SBP', slug = 'sibling-branch-project' WHERE id = {$sibling}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$sibling}")->fetchColumn();

        // Caller restricted to OU 2 must not reach OU 3's project by ANY form.
        // This is the assertion that matters most in the whole slice: it is
        // what replaces the structural OU check that flattening removed.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, $sibling));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, $publicId));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, 'SBP'));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, 'sibling-branch-project'));
    }

    public function testResolveProjectFallsBackToTheDefaultOnlyWhenInScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $mine    = $this->makeProjectDirect(7, 2, 'Mine');
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');

        // Empty identifier + an in-scope default resolves to it.
        self::assertSame($mine, IdentifierResolver::resolveProject($this->pdo, 7, 2, null, $mine));

        // A stale default pointing outside scope must NOT be honoured — the
        // stored id is re-checked through the same scoped query.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, null, $sibling));

        // No identifier and no default is simply a miss.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, null, null));
    }

    public function testResolveTaskAcceptsAShortIdAndRefusesItAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SIB' WHERE id = {$sibling}");
        $sectionId = $this->makeSectionDirect(7, $sibling);
        $taskId    = $this->makeTaskDirect(7, $sibling, $sectionId, 'Hidden task');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 31 WHERE id = {$taskId}");

        // Tenant-root sees it.
        self::assertSame($taskId, IdentifierResolver::resolveTask($this->pdo, 7, null, 'SIB-31'));

        // A caller in sibling OU 2 must not, because the PROJECT is out of scope.
        self::assertNull(IdentifierResolver::resolveTask($this->pdo, 7, 2, 'SIB-31'));
    }

    // Task review finding #1: resolveSection()/resolveGroup() (via
    // resolveStructural()) never referenced $callerOuId at all -- an
    // OU-restricted caller passing a sibling OU's section/group id or UUID
    // resolved it anyway. Fixed to join through to tasker_projects and apply
    // OuScopeResolver::whereFragment('p.ou_id'), the same shape as
    // taskByColumn(). These cases prove it, and finding #2 is the reason
    // there was no test to catch the original gap in the first place.

    public function testResolveSectionAcceptsIdAndUuidWithinScope(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Section resolve project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_sections WHERE id = {$sectionId}")->fetchColumn();

        self::assertSame($sectionId, IdentifierResolver::resolveSection($this->pdo, 7, null, $sectionId));
        self::assertSame($sectionId, IdentifierResolver::resolveSection($this->pdo, 7, null, $publicId));
    }

    public function testResolveSectionRefusesIdAndUuidAcrossATenantBoundary(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_sections WHERE id = {$otherSectionId}")->fetchColumn();

        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, null, $otherSectionId));
        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, null, $publicId));
    }

    public function testResolveSectionRefusesIdAndUuidAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_sections WHERE id = {$siblingSectionId}")->fetchColumn();

        // Caller restricted to OU 2 must not reach OU 3's section by id or UUID.
        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, 2, $siblingSectionId));
        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, 2, $publicId));
    }

    public function testResolveSectionBySlugRequiresTheParentAndRefusesAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $mineProjectId = $this->makeProjectDirect(7, 2, 'Mine slug project');
        $mineSectionId = $this->makeSectionDirect(7, $mineProjectId); // slug 'backlog'

        // Within scope, with the parent supplied, a slug resolves.
        self::assertSame($mineSectionId, IdentifierResolver::resolveSection($this->pdo, 7, 2, 'backlog', $mineProjectId));

        // Without a parent, a slug is genuinely ambiguous -- refuse rather than guess.
        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, 2, 'backlog', null));

        // A sibling OU's project (also named 'backlog') must not resolve even
        // though the parent id is supplied -- the OU join still applies.
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling slug project');
        $this->makeSectionDirect(7, $siblingProjectId); // slug 'backlog' too, different project
        self::assertNull(IdentifierResolver::resolveSection($this->pdo, 7, 2, 'backlog', $siblingProjectId));
    }

    public function testResolveGroupAcceptsIdAndUuidWithinScope(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Group resolve project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $groupId = $this->makeGroupDirect(7, $sectionId, 'Backend');
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_groups WHERE id = {$groupId}")->fetchColumn();

        self::assertSame($groupId, IdentifierResolver::resolveGroup($this->pdo, 7, null, $groupId));
        self::assertSame($groupId, IdentifierResolver::resolveGroup($this->pdo, 7, null, $publicId));
    }

    public function testResolveGroupRefusesIdAndUuidAcrossATenantBoundary(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherGroupId = $this->makeGroupDirect(9, $otherSectionId, 'Other group');
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_groups WHERE id = {$otherGroupId}")->fetchColumn();

        self::assertNull(IdentifierResolver::resolveGroup($this->pdo, 7, null, $otherGroupId));
        self::assertNull(IdentifierResolver::resolveGroup($this->pdo, 7, null, $publicId));
    }

    public function testResolveGroupRefusesIdAndUuidAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingGroupId = $this->makeGroupDirect(7, $siblingSectionId, 'Sibling group');
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_groups WHERE id = {$siblingGroupId}")->fetchColumn();

        // Caller restricted to OU 2 must not reach OU 3's group by id or UUID,
        // via the two-hop join (group -> section -> project) either.
        self::assertNull(IdentifierResolver::resolveGroup($this->pdo, 7, 2, $siblingGroupId));
        self::assertNull(IdentifierResolver::resolveGroup($this->pdo, 7, 2, $publicId));
    }

    // ==================== Task 4: flattened project routes ====================

    public function testUpdateProjectAcceptsAPrefixInsteadOfAnId(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Prefix Update');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'PU' WHERE id = {$projectId}");

        $handler = new ProjectsApiHandler($this->pdo);
        $resolved = IdentifierResolver::resolveProject($this->pdo, 7, null, 'PU');
        self::assertSame($projectId, $resolved);

        $response = $handler->update(7, null, $resolved, json_encode(['name' => 'Renamed By Prefix']));
        self::assertSame(200, $response->getStatusCode());

        $name = (string) $this->pdo->query("SELECT name FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();
        self::assertSame('Renamed By Prefix', $name);
    }

    /**
     * The judgement call this task leaves open: environment_id must behave
     * as a genuine alias for ou_id, not a parallel, half-wired field —
     * proven here by exercising it through the exact same
     * ouIsInCallersScope() boundary the pre-existing ou_id tests above
     * already cover (testCreateRejectsAnOuIdOutsideTheCallersScope et al.).
     */
    public function testCreateAcceptsEnvironmentIdAsAnAliasForOuId(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);

        $handler = new ProjectsApiHandler($this->pdo);
        $created = json_decode(
            $handler->create(7, null, 1, json_encode(['name' => 'Via alias', 'environment_id' => 2]))->getBody(),
            true
        );

        self::assertSame(2, $created['data']['ouId']);
    }

    public function testCreateRejectsAnEnvironmentIdOutsideTheCallersScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller is scoped to OU 2; OU 3 is a sibling, outside their scope.
        $response = $handler->create(7, 2, 1, json_encode(['name' => 'Sneaky alias', 'environment_id' => 3]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testUpdateAcceptsEnvironmentIdAsAnAliasForOuId(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, null, 'Retarget via alias');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['environment_id' => 2]));

        self::assertSame(200, $response->getStatusCode());
        $row = $this->pdo->query("SELECT ou_id FROM tasker_projects WHERE id = {$projectId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame(2, (int) $row['ou_id']);
    }

    public function testCreateRejectsANonNumericEnvironmentId(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->create(7, null, 1, json_encode(['name' => 'Bad alias', 'environment_id' => 'not-a-number']));

        self::assertSame(400, $response->getStatusCode());
    }

    /**
     * The update()-side twin of testCreateRejectsAnEnvironmentIdOutsideTheCallersScope():
     * update() is the path that can orphan an EXISTING project (widen or
     * relocate a project a caller already owns), so this needs its own
     * coverage rather than assuming create()'s coverage of the shared
     * extractOuIdInput()/ouIsInCallersScope() plumbing is enough.
     */
    public function testUpdateRejectsAnEnvironmentIdOutsideTheCallersScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $projectId = $this->makeProjectDirect(7, 2, 'Scoped via alias');

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller is scoped to OU 2; OU 3 is a sibling, outside their scope.
        $response = $handler->update(7, 2, $projectId, json_encode(['environment_id' => 3]));

        self::assertSame(422, $response->getStatusCode());
        $row = $this->pdo->query("SELECT ou_id FROM tasker_projects WHERE id = {$projectId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame(2, (int) $row['ou_id'], 'a rejected update must not silently relocate the project');
    }

    public function testUpdateRejectsANonNumericEnvironmentId(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Bad alias update');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['environment_id' => 'not-a-number']));

        self::assertSame(400, $response->getStatusCode());
    }

    // ==================== ProjectsApiHandler::updateContext() (D1b Task 9: update_project_context) ====================
    //
    // ProjectsApiHandler has no SQLite-backed unit test file at all (see this
    // class's own header docblock) — every one of its methods needs a real
    // PostgreSQL connection (RETURNING id, OuScopeResolver::whereFragment()'s
    // `= ANY(:scope)`), and updateContext() additionally needs the jsonb `||`
    // operator, itself PostgreSQL-only. All of its coverage lives here.

    /**
     * The brief's own Step 1 test (D1b Task 9), adapted to the real 5-arg
     * handler signature. NAMING NOTE (D1b Task 9 review): this asserts the
     * handler's behaviour given an EXPLICIT `$merge` of `true` then `false`
     * — it does not exercise any default, since both calls pass `$merge`
     * outright. The "absent `replace` defaults to merge" claim belongs to
     * {@see \Tasker\Tests\TaskerPluginTest::testMergeFromReplaceDefaultsToMergeWhenReplaceIsAbsent()}
     * instead, which is what actually computes that default (see
     * {@see \Tasker\TaskerPlugin::mergeFromReplace()}'s own docblock) — this
     * test was originally named as if it covered the default too, before
     * that extraction existed, which would have left both tests LOOKING
     * like they covered the default while neither one actually did.
     */
    public function testUpdateContextMergesWhenToldToAndReplacesWhenToldTo(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Context Project');
        $handler = new ProjectsApiHandler($this->pdo);

        $handler->updateContext(7, null, $projectId, ['goal' => 'First goal', 'why' => 'Because'], true);
        $merged = json_decode($handler->updateContext(7, null, $projectId, ['goal' => 'Second goal'], true)->getBody(), true);

        self::assertSame('Second goal', $merged['data']['context']['goal']);
        self::assertSame('Because', $merged['data']['context']['why'], 'merge must preserve keys not being written');

        $replaced = json_decode($handler->updateContext(7, null, $projectId, ['goal' => 'Only goal'], false)->getBody(), true);
        self::assertArrayNotHasKey('why', $replaced['data']['context'], 'merge=false must discard everything not in the new document');
        self::assertSame('Only goal', $replaced['data']['context']['goal']);
    }

    /**
     * D1b Task 9 brief resolution #6: the merge uses jsonb `||`, which is a
     * SHALLOW merge — a nested object is replaced wholesale, not deep-merged
     * key-by-key. Pins that behaviour directly, since a caller could
     * otherwise reasonably assume the opposite.
     */
    public function testUpdateContextMergeIsShallowNotDeep(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Shallow Merge Project');
        $handler = new ProjectsApiHandler($this->pdo);

        $handler->updateContext(7, null, $projectId, ['scope' => ['in' => ['a'], 'out' => ['b']]], true);
        $merged = json_decode(
            $handler->updateContext(7, null, $projectId, ['scope' => ['in' => ['a', 'c']]], true)->getBody(),
            true
        );

        self::assertSame(['a', 'c'], $merged['data']['context']['scope']['in']);
        self::assertArrayNotHasKey(
            'out',
            $merged['data']['context']['scope'],
            'jsonb || replaces the WHOLE "scope" value, it does not merge nested keys — a deep merge would keep "out"'
        );
    }

    public function testUpdateContextRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->updateContext(7, null, $otherTenantProjectId, ['goal' => 'Should fail'], true);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUpdateContextRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller is scoped to OU 2; OU 3 is a sibling, outside their scope.
        $response = $handler->updateContext(7, 2, $siblingProjectId, ['goal' => 'Should fail'], true);

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== TasksApiHandler::moveToGroup() (D1b Task 9: move_task_to_group) ====================
    //
    // moveToGroup() is OU-aware (D1b Task 9 brief resolution #2 — see that
    // method's own docblock in TasksApiHandler and TasksApiHandlerTest's own
    // note on why it has no SQLite coverage). All of its coverage lives here.

    public function testMoveToGroupSetsTheGroupThenExplicitNullUngroups(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Group Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $groupId = $this->makeGroupDirect(7, $sectionId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Groupable');

        $handler = new TasksApiHandler($this->pdo);

        $grouped = json_decode($handler->moveToGroup(7, null, $taskId, $groupId, null)->getBody(), true);
        self::assertSame($groupId, $grouped['data']['groupId']);

        $ungrouped = json_decode($handler->moveToGroup(7, null, $taskId, null, null)->getBody(), true);
        self::assertNull($ungrouped['data']['groupId'], 'group_id null must un-group, per the original contract');
    }

    public function testMoveToGroupRejectsAGroupIdFromADifferentSection(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Cross Section Project');
        $taskSectionId = $this->makeSectionDirect(7, $projectId);
        $otherSectionStmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), 7, :project_id, 'Other', 'other', CURRENT_TIMESTAMP) RETURNING id"
        );
        $otherSectionStmt->execute([':project_id' => $projectId]);
        $otherSectionId = (int) $otherSectionStmt->fetchColumn();
        $groupInOtherSection = $this->makeGroupDirect(7, $otherSectionId, 'Elsewhere');
        $taskId = $this->makeTaskDirect(7, $projectId, $taskSectionId, 'Movable');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $taskId, $groupInOtherSection, null);

        self::assertSame(422, $response->getStatusCode());
    }

    /**
     * When section_id is supplied alongside group_id, the group is validated
     * against — and the task is actually moved into — the NEW section, and
     * the write is atomic: both columns land in the same UPDATE.
     */
    public function testMoveToGroupMovesTheTasksSectionWhenSectionIdIsSupplied(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Move With Group Project');
        $sourceSectionId = $this->makeSectionDirect(7, $projectId);
        $targetSectionStmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), 7, :project_id, 'Target', 'target', CURRENT_TIMESTAMP) RETURNING id"
        );
        $targetSectionStmt->execute([':project_id' => $projectId]);
        $targetSectionId = (int) $targetSectionStmt->fetchColumn();
        $groupInTargetSection = $this->makeGroupDirect(7, $targetSectionId, 'Target Group');
        $taskId = $this->makeTaskDirect(7, $projectId, $sourceSectionId, 'Moving with its new group');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $taskId, $groupInTargetSection, $targetSectionId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetSectionId, $payload['data']['sectionId']);
        self::assertSame($groupInTargetSection, $payload['data']['groupId']);
    }

    public function testMoveToGroupRejectsASectionIdFromADifferentProject(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Own Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $otherProjectId = $this->makeProjectDirect(7, null, 'Other Project');
        $foreignSectionId = $this->makeSectionDirect(7, $otherProjectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Movable');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $taskId, null, $foreignSectionId);

        self::assertSame(422, $response->getStatusCode());
    }

    public function testMoveToGroupRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $otherTaskId, null, null);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * The stronger of the two boundary tests, mirroring
     * testTasksGetOneRejects404ForASiblingOusTask() above: a caller scoped to
     * OU 2 must not be able to mutate OU 3's task simply by supplying its id.
     */
    public function testMoveToGroupRejects404ForASiblingOusTask(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Should not leak');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, 2, $siblingTaskId, null, null);

        self::assertSame(404, $response->getStatusCode());
    }

    // ==================== Environment (OU) aliases (D1b Task 10) ====================
    //
    // WHY THIS IS A REAL, END-TO-END TEST (not the fallback ruling #5
    // anticipated): the brief's Step 2 assumed core's AuditLogger subscriber
    // is likely NOT reachable in this test tier, because index.php's
    // bootstrap is the only place a HookManager is normally wired up and
    // subscribed. Investigated directly before concluding that: it turns out
    // to BE reachable, via a seam that has nothing to do with faking
    // anything --
    //
    //   \Whity\Database\Database::withFactory(Closure $factory): self is a
    //   PUBLIC, documented test seam ("Primarily a test seam (inject a
    //   mock-PDO factory)" -- its own docblock) that wraps an arbitrary PDO,
    //   including this test's own real $this->pdo. Combined with
    //   \Whity\Core\Tenant\TenantContext::setTenantId()/reset() (both public)
    //   and a REAL \Whity\Core\Hooks\HookManager + \Whity\Core\Audit\AuditLogger
    //   pair wired via AuditLogger's own subscribe() method (exactly what
    //   host/.core/public/index.php itself calls at boot), this reproduces
    //   the production container wiring closely enough that
    //   TaskerPlugin::createEnvironment()/renameEnvironment()/
    //   deleteEnvironment() run FOR REAL, unmodified, through ousHandler(),
    //   \Whity\app(), the real core OusApiHandler, and the real ou.* hook
    //   dispatch -- landing on a real audit_log row. No fake subscriber, no
    //   hand-dispatched hook: every collaborator below is the genuine core
    //   class, and the ONLY thing this test constructs that index.php itself
    //   doesn't is the Database wrapper (via its own documented test seam)
    //   and the tenant id (which a real request would resolve from a JWT).
    //
    // This needed three supporting changes, made alongside these tests:
    //   - plugin/composer.json: added host/.core's Core/Hooks, Core/Tenant,
    //     Core/Request.php, Core/Response.php, Database/{Database,
    //     ConnectionException}.php, Http/{InputLimits,JsonBody,PaginationParams}.php
    //     and Api/OusApiHandler.php to the existing autoload-dev classmap
    //     (which already carried Core/Audit, Core/Taxonomy, Core/Identity for
    //     the exact same reason), plus a "files" entry for
    //     host/.core/src/helpers.php so \Whity\app()/register_service() exist
    //     at all -- neither is defined anywhere on this plugin's own
    //     autoload path otherwise.
    //   - This file's setUp(): organizational_units gained the `description`
    //     column it was missing (a genuine drift from the real migration
    //     schema -- see setUp()'s own comment) because OusApiHandler::create()/
    //     update() write it unconditionally; and a matching audit_log table.
    //   - tearDown() (new): unconditionally resets TenantContext and clears
    //     the two container registrations these tests add, so this
    //     process-global state can never leak into a later test in the same
    //     PHPUnit run regardless of pass/fail/exception.
    //
    // What this does NOT prove: that host/.core/public/index.php's OWN
    // bootstrap wires HookManager/AuditLogger together correctly at
    // production boot (that file is never patched or executed by this
    // suite) -- only that IF it does (which reading it, at
    // host/.core/public/index.php:314-337, confirms it does), this plugin's
    // route methods participate correctly. Confirming the former end-to-end
    // against a live worker is what host/scripts/mcp-tools.ps1's sibling
    // smoke-test path is for, and npm run host:up cannot currently reach
    // that in this environment (known defect).

    /**
     * Wires the SAME container seam ousHandler()/resolvePdo() consume in
     * production -- \Whity\app()-resolved Database + HookManager services --
     * against this test's own $this->pdo, with a REAL AuditLogger subscribed
     * to the REAL HookManager exactly as host/.core/public/index.php:336-337
     * does. Every environment alias test below calls this once, then invokes
     * the plugin's route method directly; tearDown() clears both
     * registrations afterwards.
     */
    private function registerOusContainer(): void
    {
        \Whity\Core\Tenant\TenantContext::reset();
        \Whity\Core\Tenant\TenantContext::setTenantId(7);

        $hookManager = new \Whity\Core\Hooks\HookManager(null, null);
        (new \Whity\Core\Audit\AuditLogger($this->pdo, new \Psr\Log\NullLogger()))->subscribe($hookManager);

        \Whity\register_service(
            \Whity\Database\Database::class,
            \Whity\Database\Database::withFactory(fn (): PDO => $this->pdo)
        );
        \Whity\register_service(\Whity\Core\Hooks\HookManager::class, $hookManager);
    }

    private function hostRequest(string $method, string $path, string $body = ''): \Whity\Core\Request
    {
        return new \Whity\Core\Request($method, $path, ['content-type' => 'application/json'], $body);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function auditRowsFor(int $tenantId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT action, target_type, target_id FROM audit_log WHERE tenant_id = :tenant_id ORDER BY id'
        );
        $stmt->execute([':tenant_id' => $tenantId]);

        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * The brief's Step 2, delivered as originally specified: create_environment
     * really does dispatch core's ou.created hook, and core's real,
     * subscribed AuditLogger really does turn it into an audit_log row --
     * proving the hook path ran rather than a silent direct INSERT.
     */
    public function testCreateEnvironmentDispatchesTheOuCreatedHookAndAuditLogsIt(): void
    {
        $this->registerOusContainer();

        $plugin = new TaskerPlugin();
        $response = $plugin->createEnvironment($this->hostRequest(
            'POST',
            '/api/tasker/environments',
            (string) json_encode(['name' => 'Engineering'])
        ));

        self::assertSame(201, $response->getStatusCode());
        $created = json_decode($response->getBody(), true);
        $ouId = (int) $created['data']['id'];

        $rows = $this->auditRowsFor(7);
        self::assertCount(1, $rows);
        self::assertSame('ou.created', $rows[0]['action']);
        self::assertSame('ou', $rows[0]['target_type']);
        self::assertSame($ouId, (int) $rows[0]['target_id']);
    }

    /**
     * rename_environment's identifier travels as `environment_id` in the
     * body (this alias has no {id} path parameter); this proves BOTH that
     * the translation into OusApiHandler::update()'s `$params['id']` shape
     * actually works end to end (the OU is genuinely renamed in the
     * database, not just left alone by a silently-ignored parameter) AND
     * that the rename dispatches ou.updated into the audit trail.
     */
    public function testRenameEnvironmentUpdatesTheRowAndAuditLogsOuUpdated(): void
    {
        $this->registerOusContainer();
        // makeOu()'s first argument IS the row's id (an explicit INSERT, not
        // an autoincrement read-back) -- see makeOu()'s own definition above.
        $ouId = 1;
        $this->makeOu($ouId, 7, null);

        $plugin = new TaskerPlugin();
        $response = $plugin->renameEnvironment($this->hostRequest(
            'PATCH',
            '/api/tasker/environments',
            (string) json_encode(['environment_id' => $ouId, 'name' => 'Renamed OU'])
        ));

        self::assertSame(200, $response->getStatusCode());

        $row = $this->pdo->query("SELECT name FROM organizational_units WHERE id = {$ouId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame(
            'Renamed OU',
            $row['name'],
            'the environment_id -> $params[\'id\'] translation must actually reach OusApiHandler::update(), '
                . 'not be silently dropped'
        );

        $rows = $this->auditRowsFor(7);
        self::assertCount(1, $rows);
        self::assertSame('ou.updated', $rows[0]['action']);
        self::assertSame($ouId, (int) $rows[0]['target_id']);
    }

    /**
     * MUST read environment_id via identifierFromRequest(), never the body
     * alone -- this test deliberately sends the identifier ONLY in the query
     * string with an EMPTY body, mirroring exactly what core's MCP transport
     * does for every DELETE call (see deleteEnvironment()'s own docblock). A
     * body-only implementation would 400 here.
     */
    public function testDeleteEnvironmentReadsTheQueryStringIdentifierAndAuditLogsOuDeleted(): void
    {
        $this->registerOusContainer();
        $ouId = 1;
        $this->makeOu($ouId, 7, null);

        $previousGet = $_GET;
        $_GET = ['environment_id' => (string) $ouId];
        try {
            $plugin = new TaskerPlugin();
            $response = $plugin->deleteEnvironment($this->hostRequest('DELETE', '/api/tasker/environments', ''));
        } finally {
            $_GET = $previousGet;
        }

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query("SELECT COUNT(*) FROM organizational_units WHERE id = {$ouId}")->fetchColumn();
        self::assertSame(0, $count, 'the OU must actually be gone -- proving the query-string identifier reached OusApiHandler::delete()');

        $rows = $this->auditRowsFor(7);
        self::assertCount(1, $rows);
        self::assertSame('ou.deleted', $rows[0]['action']);
        self::assertSame($ouId, (int) $rows[0]['target_id']);
    }

    public function testListEnvironmentsReturnsTheTenantsOusWithNoAuditSideEffect(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);

        $plugin = new TaskerPlugin();
        $response = $plugin->listEnvironments($this->hostRequest('GET', '/api/tasker/environments'));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertCount(2, $payload['data']);

        self::assertCount(0, $this->auditRowsFor(7), 'a read must never write an audit row');
    }

    /**
     * Global constraint: caller identity or tenant context that cannot be
     * resolved must fail closed with 403 -- exercised here by simply never
     * calling registerOusContainer()/TenantContext::setTenantId(), so
     * requireTenantId() sees the same unresolved state a request with no
     * valid tenant claim would.
     */
    public function testEnvironmentRoutesFailClosedWithoutAResolvedTenant(): void
    {
        \Whity\Core\Tenant\TenantContext::reset();

        $plugin = new TaskerPlugin();
        $response = $plugin->listEnvironments($this->hostRequest('GET', '/api/tasker/environments'));

        self::assertSame(403, $response->getStatusCode());
    }
}
