<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Access\IdentifierResolver;
use Tasker\Api\AttentionApiHandler;
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
use Tasker\Migrations\CreateTaskerUserPrefsTable;
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
        // D1b Task 12b: the delete_section/delete_project/list_groups/
        // create_group route-level tests below DO insert a membership row
        // (resolveCallerOu() needs one to resolve a caller identity at all),
        // unlike the environment alias tests above -- cleared per run the
        // same way audit_log/organizational_units already are, so repeated
        // runs against the shared tasker_test database never accumulate
        // stale rows for the same (profile_id, tenant_id) pair.
        $this->pdo->exec('DELETE FROM memberships WHERE tenant_id IN (7, 9)');

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
        // D1b Task 12b: deleteProject()/listGroups()/createGroup() all call
        // defaultProjectIdFor(), which queries this table UNCONDITIONALLY —
        // PHP evaluates every argument before the call, so
        // SessionApiHandler::defaultProjectId() runs even when the route's
        // OWN project_id/section_id was supplied explicitly and the default
        // is never actually used. No prior test in this file reached that
        // code path, so this table's absence went unnoticed until the
        // route-level tests below exercised it for real.
        (new CreateTaskerUserPrefsTable())->up($this->pdo);
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

    /**
     * A membership row for resolveCallerOu() to find (D1b Task 12b). Unlike
     * the Environment alias tests above (which never insert one and so
     * always fail closed to "unrestricted" via a bare null $callerOuId
     * argument passed straight to a handler), the delete_section/
     * delete_project/list_groups/create_group tests below go through the
     * FULL route method — deleteSection(), deleteProject(), etc. — which
     * calls resolveCallerOu() itself and 403s ("Caller membership could not
     * be resolved") without a real row for $request->user->profile_id.
     * $ouId null means unrestricted (tenant-root), matching
     * MembershipRepository's own null-ou_id convention.
     */
    private function makeMembership(int $profileId, int $tenantId, ?int $ouId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO memberships (profile_id, tenant_id, role_id, ou_id, status, created_at)
             VALUES (:profile_id, :tenant_id, 1, :ou_id, \'active\', CURRENT_TIMESTAMP)'
        );
        $stmt->bindValue(':profile_id', $profileId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':ou_id', $ouId, $ouId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->execute();
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
     * Like makeSectionDirect() but with a caller-chosen name/slug (D1b Task
     * 12b) — needed whenever a single project needs MORE THAN ONE section in
     * the same test: makeSectionDirect() always inserts 'Backlog'/'backlog',
     * and (project_id, slug) is UNIQUE on the real schema.
     */
    private function makeSectionDirectNamed(int $tenantId, int $projectId, string $name): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, :name, :slug, CURRENT_TIMESTAMP) RETURNING id'
        );
        $stmt->execute([
            ':tenant_id' => $tenantId,
            ':project_id' => $projectId,
            ':name' => $name,
            ':slug' => strtolower(str_replace(' ', '-', $name)),
        ]);

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

    /**
     * A task fixture for the AttentionApiHandler tests below, layering the
     * three columns readyWork()'s own makeTaskDirect() has no concept of
     * (created_by, status, updated_at) onto it via a plain raw UPDATE --
     * matching this file's own established convention of following
     * makeTaskDirect() with a raw UPDATE for whatever column a given test
     * needs that the shared helper does not accept as a parameter (e.g.
     * every `UPDATE tasker_tasks SET status = 'done' ...` call above),
     * rather than growing makeTaskDirect() itself for a need specific to one
     * new test class.
     */
    private function makeAttentionTaskDirect(
        int $tenantId,
        int $projectId,
        int $sectionId,
        string $text,
        int $createdBy,
        string $status = 'pending',
        ?string $dueDate = null,
        bool $pinned = false,
        ?string $updatedAtExpr = null
    ): int {
        $taskId = $this->makeTaskDirect($tenantId, $projectId, $sectionId, $text, null, $pinned, $dueDate);
        $updatedAtClause = $updatedAtExpr !== null ? ", updated_at = {$updatedAtExpr}" : '';
        $this->pdo->exec(
            "UPDATE tasker_tasks SET created_by = {$createdBy}, status = '{$status}'{$updatedAtClause} WHERE id = {$taskId}"
        );

        return $taskId;
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

    // ==================== TasksApiHandler::moveToProject() (D1b Task 12c) ====================
    //
    // move_task was PORTED here, not merely allowlisted (see
    // parity-allowlist.php's own closed 'move_task' SEMANTIC entry): the
    // original's move_task moves a task to a DIFFERENT project, not the
    // within-project relocation/reorder this plugin's own (now-retired)
    // move()/moveTask() combo used to implement. moveToProject() is OU-aware
    // (belt-and-braces, like moveToGroup()/getOne() — see its own docblock in
    // TasksApiHandler), so ALL of its coverage lives here, never in
    // TasksApiHandlerTest.php (SQLite) — see that file's own docblock.

    public function testMoveToProjectReassignsShortIdIntoTheTargetProjectsSequence(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Seq Source');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SEQ' WHERE id = {$sourceProjectId}");
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Seq Target');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'TAR' WHERE id = {$targetProjectId}");
        $targetSectionId = $this->makeSectionDirect(7, $targetProjectId);
        // The target already has two tasks -- short_id 1 and 2 -- so a
        // moved-in task must become 3, following the TARGET's own sequence,
        // never the source's.
        $existingA = $this->makeTaskDirect(7, $targetProjectId, $targetSectionId, 'Existing A');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$existingA}");
        $existingB = $this->makeTaskDirect(7, $targetProjectId, $targetSectionId, 'Existing B');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 2 WHERE id = {$existingB}");

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Moving task');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 40 WHERE id = {$taskId}");

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetProjectId, $payload['data']['projectId']);
        self::assertSame(3, $payload['data']['shortId'], 'must follow the TARGET project\'s own sequence, not the source\'s');
        self::assertSame('TAR-3', $payload['data']['newShortId']);
        self::assertSame('SEQ-40', $payload['data']['previousShortId']);
    }

    public function testMoveToProjectPreservesTaskContent(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Preserve Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Preserve Target');
        $this->makeSectionDirect(7, $targetProjectId);

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Preserve me', 'high', true, '2026-09-01');
        $this->pdo->exec(
            "UPDATE tasker_tasks SET detail = 'some detail', status = 'done', completed_at = '2026-01-01 00:00:00' WHERE id = {$taskId}"
        );

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Preserve me', $payload['data']['text']);
        self::assertSame('some detail', $payload['data']['detail']);
        self::assertSame('high', $payload['data']['priority']);
        self::assertSame('done', $payload['data']['status']);
        self::assertTrue($payload['data']['pinned']);
        self::assertSame('2026-09-01', $payload['data']['dueDate']);
        self::assertSame('2026-01-01 00:00:00', $payload['data']['completedAt']);
    }

    public function testMoveToProjectClearsGroupId(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Group Clear Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $groupId = $this->makeGroupDirect(7, $sourceSectionId, 'Old group');
        $targetProjectId = $this->makeProjectDirect(7, null, 'Group Clear Target');
        $this->makeSectionDirect(7, $targetProjectId);

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Grouped task', null, false, null, 0, $groupId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertNull($payload['data']['groupId']);
        self::assertTrue($payload['data']['droppedGroup']);
    }

    public function testMoveToProjectPlacesTheTaskInTheSuppliedTargetSection(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Section Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Section Target');
        $this->makeSectionDirect(7, $targetProjectId); // Backlog, deliberately NOT the target below.
        $targetSectionId = $this->makeSectionDirectNamed(7, $targetProjectId, 'In Review');

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Land me precisely');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, $targetSectionId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetSectionId, $payload['data']['sectionId']);
        self::assertFalse($payload['data']['landedInBacklog']);
    }

    /**
     * The case the brief itself flags as most likely to be got wrong: a
     * target_section_id that resolves to a REAL section, just not one
     * belonging to the target project, must NOT be an error.
     *
     * DEVIATION FROM THE BRIEF: the brief (quoting the original's own tool
     * description) says this should leave the task with "no section".
     * tasker_tasks.section_id is `NOT NULL` (see CreateTaskerTasksTable's own
     * docblock) — literal "no section" cannot exist in this schema. This
     * reuses the SAME substitute create_task's own resolveCreateTaskSectionId()/
     * backlogSectionIdFor() already established for the identical constraint:
     * the task lands in the TARGET project's own Backlog section instead —
     * see moveToProject()'s own docblock for the full reasoning.
     */
    public function testMoveToProjectLandsInTheTargetsBacklogWhenTheSuppliedSectionBelongsToADifferentProject(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Foreign Section Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Foreign Section Target');
        $targetBacklogId = $this->makeSectionDirect(7, $targetProjectId);
        $thirdProjectId = $this->makeProjectDirect(7, null, 'Unrelated Third Project');
        $foreignSectionId = $this->makeSectionDirect(7, $thirdProjectId);

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Should land in backlog');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, $foreignSectionId);

        self::assertSame(200, $response->getStatusCode(), 'a foreign target_section_id must NOT be an error');
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetBacklogId, $payload['data']['sectionId']);
        self::assertTrue($payload['data']['landedInBacklog']);
    }

    /**
     * The Backlog-fallback's own failure edge: reachable only for a target
     * project that never went through create_project (which always seeds a
     * Backlog section) — e.g. an imported one. Matches createTask()'s own
     * analogous "Project has no backlog section" 404.
     */
    public function testMoveToProjectReturns404WhenNoSectionIsResolvableAndTheTargetHasNoBacklog(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'No Backlog Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'No Backlog Target'); // No section seeded at all.

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Nowhere to land');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testMoveToProjectRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak');
        $targetProjectId = $this->makeProjectDirect(7, null, 'Caller target project');
        $this->makeSectionDirect(7, $targetProjectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $otherTaskId, $targetProjectId, null);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Belt-and-braces defence (matches moveToGroup()'s own precedent): a
     * caller scoped to OU 2 must not reach OU 3's task simply by supplying
     * its id, even calling the handler directly.
     */
    public function testMoveToProjectRejects404ForASiblingOusTask(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Should not leak');
        $targetProjectId = $this->makeProjectDirect(7, 2, 'Callers own project');
        $this->makeSectionDirect(7, $targetProjectId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, 2, $siblingTaskId, $targetProjectId, null);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * The target-project half of the same belt-and-braces defence: a task
     * the caller CAN see must not be movable into a project the caller
     * cannot see.
     */
    public function testMoveToProjectRejects404ForATargetProjectInASiblingOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $ownProjectId = $this->makeProjectDirect(7, 2, 'Callers own project');
        $ownSectionId = $this->makeSectionDirect(7, $ownProjectId);
        $ownTaskId = $this->makeTaskDirect(7, $ownProjectId, $ownSectionId, 'Movable');
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, 2, $ownTaskId, $siblingProjectId, null);

        self::assertSame(404, $response->getStatusCode());

        $row = $this->pdo->query("SELECT project_id FROM tasker_tasks WHERE id = {$ownTaskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($ownProjectId, (int) $row['project_id'], 'a rejected cross-OU move must not have moved anything');
    }

    /**
     * REGRESSION TEST (D1b Task 12c review round 1): a "move" whose
     * target_project_id resolves to the task's OWN current project — the
     * original's own guidance is "For same-project moves use update_task or
     * move_task_to_group" — must be rejected with 422, not silently
     * renumber/un-group/Backlog-relocate the task. Before this fix,
     * ShortIdAllocator::next() would count the task's OWN row in its
     * MAX(short_id) computation and hand back a NEW, higher number,
     * destroying the task's stable external identity with nothing on this
     * surface able to undo it.
     */
    public function testMoveToProjectRejects422ForASameProjectMove(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Same Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Stay put');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 40 WHERE id = {$taskId}");

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $projectId, null);

        self::assertSame(422, $response->getStatusCode());
        $body = json_decode($response->getBody(), true);
        self::assertStringContainsString('update_task', $body['error']);
        self::assertStringContainsString('move_task_to_group', $body['error']);

        $row = $this->pdo->query("SELECT project_id, short_id, section_id FROM tasker_tasks WHERE id = {$taskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($projectId, (int) $row['project_id']);
        self::assertSame(40, (int) $row['short_id'], 'a rejected same-project move must not renumber the task');
        self::assertSame($sectionId, (int) $row['section_id'], 'a rejected same-project move must not relocate the task to Backlog');
    }

    /**
     * SORT ORDER floor requirement (D1b Task 12c review round 1): the moved
     * task lands at the END of the target section, not carrying over
     * whatever sort_order it happened to have in its source section.
     */
    public function testMoveToProjectPlacesTheTaskAtTheEndOfTheTargetSection(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Sort Order Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Sort Order Target');
        $targetSectionId = $this->makeSectionDirect(7, $targetProjectId);
        $this->makeTaskDirect(7, $targetProjectId, $targetSectionId, 'Already there A', null, false, null, 0);
        $this->makeTaskDirect(7, $targetProjectId, $targetSectionId, 'Already there B', null, false, null, 1);

        // The source's OWN sort_order (5) must not travel across the move.
        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Moving task', null, false, null, 5);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(2, $payload['data']['sortOrder'], 'must land AFTER the target section\'s existing tasks (0, 1), not carry over the source\'s own sort_order (5)');
    }

    /**
     * RESPONSE FIELD floor requirement (D1b Task 12c review round 1):
     * previousShortId/newShortId must fall back to the bare integer, not go
     * silently null, when a project's (nullable) prefix column is unset.
     */
    public function testMoveToProjectFallsBackToBareShortIdWhenAProjectHasNoPrefix(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'No Prefix Source'); // prefix left NULL.
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'No Prefix Target'); // prefix left NULL.
        $this->makeSectionDirect(7, $targetProjectId);

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'No prefix task');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 7 WHERE id = {$taskId}");

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('7', $payload['data']['previousShortId'], 'must fall back to the bare integer, not go silently null, when the source project has no prefix');
        self::assertSame('1', $payload['data']['newShortId'], 'must fall back to the bare integer, not go silently null, when the target project has no prefix');
    }

    /**
     * ATOMICITY floor requirement: if the write fails, the task keeps its
     * original project_id/short_id. Forced deterministically via
     * `default_transaction_read_only` -- every statement (including
     * ShortIdAllocator's own attempt) fails immediately with a NON-race
     * SQLSTATE, so moveToProject() catches it and 500s without ever having
     * committed anything. SELECTs remain allowed under this setting, so the
     * verification query right after needs no special handling.
     */
    public function testMoveToProjectIsAtomicWhenTheUpdateFails(): void
    {
        $sourceProjectId = $this->makeProjectDirect(7, null, 'Atomic Source');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'ATS' WHERE id = {$sourceProjectId}");
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Atomic Target');
        $this->makeSectionDirect(7, $targetProjectId);
        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Should not move');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 9 WHERE id = {$taskId}");

        $this->pdo->exec('SET default_transaction_read_only = on');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToProject(7, null, $taskId, $targetProjectId, null);

        self::assertSame(500, $response->getStatusCode());

        $row = $this->pdo->query("SELECT project_id, short_id FROM tasker_tasks WHERE id = {$taskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($sourceProjectId, (int) $row['project_id'], 'a failed move must leave the task in its ORIGINAL project');
        self::assertSame(9, (int) $row['short_id'], 'a failed move must leave the task with its ORIGINAL short_id');
    }

    // ==================== TaskerPlugin::moveTask() route (D1b Task 12c) ====================
    //
    // Full ROUTE-level dispatch (via registerOusContainer(), same as the
    // D1b Task 12b delete_section/delete_project tests below) — this is
    // parity-allowlist.php['move_task']'s own former dischargedBy proof
    // (the entry it names is now CLOSED, not merely discharged — see that
    // file's own comment), and the only place task_id/target_project_id/
    // target_section_id identifier RESOLUTION (as opposed to
    // moveToProject()'s own belt-and-braces re-check above) can be exercised
    // at all.

    /**
     * parity-allowlist.php's former 'move_task' SEMANTIC entry named this
     * exact method as its dischargedBy proof. Exercises the real, fully
     * wired path: short-id-by-prefix resolution for BOTH task_id and
     * target_project_id, the cross-project move itself, and every field the
     * brief asks the response to report.
     */
    public function testMoveTaskMovesATaskIntoADifferentProject(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $sourceProjectId = $this->makeProjectDirect(7, null, 'Move Source');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SRC' WHERE id = {$sourceProjectId}");
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'Move Target');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'TGT' WHERE id = {$targetProjectId}");
        $this->makeSectionDirect(7, $targetProjectId); // Target's own Backlog.

        $groupId = $this->makeGroupDirect(7, $sourceSectionId, 'Old group');
        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Cross-project task', 'high', true, '2026-09-01', 0, $groupId);
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$taskId}");

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode([
            'task_id' => 'SRC-1',
            'target_project_id' => 'TGT',
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetProjectId, $payload['data']['projectId']);
        self::assertSame(1, $payload['data']['shortId'], 'a fresh target project starts its own sequence at 1');
        self::assertSame('TGT-1', $payload['data']['newShortId']);
        self::assertSame('SRC-1', $payload['data']['previousShortId']);
        self::assertSame('high', $payload['data']['priority']);
        self::assertTrue($payload['data']['pinned']);
        self::assertSame('2026-09-01', $payload['data']['dueDate']);
        self::assertNull($payload['data']['groupId']);
        self::assertTrue($payload['data']['droppedGroup']);
    }

    /**
     * Replaces the old (pre-Task-12c) testMoveResolvesASectionUuidDestinationBeforeDelegatingToMove():
     * proves target_section_id UUID resolution end to end through the NEW
     * cross-project route, the same way the retired test proved it for the
     * old within-project one.
     */
    public function testMoveTaskResolvesATargetSectionUuidBeforeMoving(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $sourceProjectId = $this->makeProjectDirect(7, null, 'UUID Move Source');
        $sourceSectionId = $this->makeSectionDirect(7, $sourceProjectId);
        $targetProjectId = $this->makeProjectDirect(7, null, 'UUID Move Target');
        $this->makeSectionDirect(7, $targetProjectId); // Backlog, deliberately not the target below.
        $targetSectionId = $this->makeSectionDirectNamed(7, $targetProjectId, 'In Review');
        $targetSectionPublicId = (string) $this->pdo
            ->query("SELECT public_id FROM tasker_sections WHERE id = {$targetSectionId}")
            ->fetchColumn();

        $taskId = $this->makeTaskDirect(7, $sourceProjectId, $sourceSectionId, 'Move me by uuid section');
        $taskPublicId = (string) $this->pdo->query("SELECT public_id FROM tasker_tasks WHERE id = {$taskId}")->fetchColumn();

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode([
            'task_id' => $taskPublicId,
            'target_project_id' => (string) $targetProjectId,
            'target_section_id' => $targetSectionPublicId,
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($targetSectionId, $payload['data']['sectionId']);
    }

    /**
     * A destructive/mutating route must never guess its target (the same
     * rule deleteProject()'s own docblock states) — an absent
     * target_project_id is a plain 400, never a fallback to anything, and
     * the task must not move.
     */
    public function testMoveTaskRejects400ForAnAbsentTargetProjectIdAndDoesNotMoveTheTask(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'No Target Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Stays put');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 5 WHERE id = {$taskId}");

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode(['task_id' => (string) $taskId]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(400, $response->getStatusCode());
        $body = json_decode($response->getBody(), true);
        self::assertStringContainsString('target_project_id', $body['error']);

        $row = $this->pdo->query("SELECT project_id, short_id FROM tasker_tasks WHERE id = {$taskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($projectId, (int) $row['project_id']);
        self::assertSame(5, (int) $row['short_id']);
    }

    public function testMoveTaskRejects404ForATaskInASiblingOu(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $this->makeMembership(self::CALLER_ID, 7, 2);

        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SIB' WHERE id = {$siblingProjectId}");
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $siblingTaskId = $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Hidden');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$siblingTaskId}");

        $targetProjectId = $this->makeProjectDirect(7, 2, 'Callers own project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'OWN' WHERE id = {$targetProjectId}");

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode([
            'task_id' => 'SIB-1',
            'target_project_id' => 'OWN',
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testMoveTaskRejects404ForATargetProjectInASiblingOu(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $this->makeMembership(self::CALLER_ID, 7, 2);

        $ownProjectId = $this->makeProjectDirect(7, 2, 'Callers own project');
        $ownSectionId = $this->makeSectionDirect(7, $ownProjectId);
        $ownTaskId = $this->makeTaskDirect(7, $ownProjectId, $ownSectionId, 'Movable');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'OWN' WHERE id = {$ownProjectId}");
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$ownTaskId}");

        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SIB' WHERE id = {$siblingProjectId}");

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode([
            'task_id' => 'OWN-1',
            'target_project_id' => 'SIB',
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(404, $response->getStatusCode());

        $row = $this->pdo->query("SELECT project_id FROM tasker_tasks WHERE id = {$ownTaskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($ownProjectId, (int) $row['project_id'], 'a rejected cross-OU move must not have moved anything');
    }

    /**
     * REGRESSION TEST (D1b Task 12c review round 1), full route: the exact
     * scenario the review named as "plausible on a retry, or when the same
     * project resolves from two identifier forms" — task_id given as its
     * short id (which names the project via its PREFIX) and target_project_id
     * given as that SAME prefix. Both resolve to the same project through
     * two different identifier forms; the route must still reject it.
     */
    public function testMoveTaskRejects422WhenTargetProjectIsTheTasksCurrentProject(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'Same Project Route');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'TDE' WHERE id = {$projectId}");
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Stay put');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 40 WHERE id = {$taskId}");

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/move', (string) json_encode([
            'task_id' => 'TDE-40',
            'target_project_id' => 'TDE',
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTask($request);

        self::assertSame(422, $response->getStatusCode());

        $row = $this->pdo->query("SELECT project_id, short_id FROM tasker_tasks WHERE id = {$taskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame($projectId, (int) $row['project_id']);
        self::assertSame(40, (int) $row['short_id'], 'a rejected same-project move must not renumber the task');
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

    /**
     * PARITY REGRESSION TEST (D1b Task 12). The original app's add_milestone
     * takes `text`, not `summary`, and requires it — so before this, every
     * original-shaped call was rejected by core's InputSchemaValidator for a
     * missing `summary` it had no reason to send. Both spellings must work, and
     * `text` must win when both are present.
     */
    public function testMilestonesCreateAcceptsTheOriginalsTextArgumentAndPrefersItOverSummary(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Milestone parity project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Task with milestones');

        $handler = new MilestonesApiHandler($this->pdo);

        $viaText = $handler->create(7, null, $taskId, json_encode(['text' => 'Written as text']));
        self::assertSame(201, $viaText->getStatusCode());
        self::assertSame('Written as text', json_decode($viaText->getBody(), true)['data']['summary']);

        $bothSent = $handler->create(7, null, $taskId, json_encode(['text' => 'text wins', 'summary' => 'summary loses']));
        self::assertSame(201, $bothSent->getStatusCode());
        self::assertSame('text wins', json_decode($bothSent->getBody(), true)['data']['summary']);

        $neither = $handler->create(7, null, $taskId, json_encode(['sort_order' => 1]));
        self::assertSame(400, $neither->getStatusCode());
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

        $grouped = json_decode($handler->moveToGroup(7, null, $taskId, $groupId, true, null)->getBody(), true);
        self::assertSame($groupId, $grouped['data']['groupId']);

        $ungrouped = json_decode($handler->moveToGroup(7, null, $taskId, null, true, null)->getBody(), true);
        self::assertNull($ungrouped['data']['groupId'], 'explicit group_id:null must un-group, per the original contract');
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
        $response = $handler->moveToGroup(7, null, $taskId, $groupInOtherSection, true, null);

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
        $response = $handler->moveToGroup(7, null, $taskId, $groupInTargetSection, true, $targetSectionId);

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
        $response = $handler->moveToGroup(7, null, $taskId, null, false, $foreignSectionId);

        self::assertSame(422, $response->getStatusCode());
    }

    public function testMoveToGroupRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $otherTaskId = $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $otherTaskId, null, false, null);

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
        $response = $handler->moveToGroup(7, 2, $siblingTaskId, null, false, null);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * D1b Task 12c floor requirement: move_task_to_group still reorders via
     * sort_order, now that the capability was rehomed here from move_task
     * (the live original exposes no MCP reordering tool at all — see
     * parity-allowlist.php['move_task_to_group']). null (the default) must
     * leave sort_order untouched, matching every other optional field here.
     * $groupProvided: false throughout, matching the real route shape of a
     * pure reorder call (`{task_id, sort_order}`, no group_id key at all).
     */
    public function testMoveToGroupStillReordersViaSortOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Reorder Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Reorder me', null, false, null, 1);

        $handler = new TasksApiHandler($this->pdo);

        $reorderResponse = $handler->moveToGroup(7, null, $taskId, null, false, null, 5);
        self::assertSame(200, $reorderResponse->getStatusCode());
        $reordered = json_decode($reorderResponse->getBody(), true);
        self::assertSame(5, $reordered['data']['sortOrder']);

        // Omitting sort_order (null, the default) must leave it untouched.
        $unchanged = json_decode($handler->moveToGroup(7, null, $taskId, null, false, null)->getBody(), true);
        self::assertSame(5, $unchanged['data']['sortOrder'], 'omitting sort_order must leave the previous value in place');
    }

    /**
     * REGRESSION TEST (D1b Task 12c review round 1): a pure reorder call
     * (group_id key ABSENT — $groupProvided: false) on an ALREADY-GROUPED
     * task must leave its group_id untouched. Before this fix,
     * moveToGroup() wrote `group_id = :group_id` unconditionally with
     * $groupId collapsed to null whenever the key was absent, so exactly
     * this call — the drag-and-drop reorder that justified rehoming
     * sort_order onto this tool in the first place — silently un-grouped
     * the task it reordered. This is the direct replacement for
     * testMoveKeepsTheGroupWhenSectionIdIsEchoedUnchanged(), deleted along
     * with the now-retired move() (whole-branch review finding I1's own
     * regression coverage), applied to move_task_to_group's own reorder path.
     */
    public function testMoveToGroupReorderLeavesAnAlreadyGroupedTasksGroupUntouched(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Grouped Reorder Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $groupId = $this->makeGroupDirect(7, $sectionId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Grouped, about to reorder', null, false, null, 1, $groupId);

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->moveToGroup(7, null, $taskId, null, false, null, 9);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame($groupId, $payload['data']['groupId'], 'a pure reorder call must not un-group an already-grouped task');
        self::assertSame(9, $payload['data']['sortOrder']);
    }

    // ==================== TaskerPlugin::moveTaskToGroup() route -- sort_order validation (D1b Task 12c review round 1) ====================

    /**
     * REGRESSION TEST: sort_order used to be cast, not validated
     * (`(int) $decoded['sort_order']`), so a non-numeric value silently
     * coerced to 0/1 instead of 400ing — the one field on this route that
     * didn't either resolve an identifier or validate its shape.
     */
    public function testMoveTaskToGroupRejects400ForANonIntegerSortOrder(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'Bad Sort Order Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Do not reorder me', null, false, null, 3);

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/group', (string) json_encode([
            'task_id' => (string) $taskId,
            'sort_order' => 'abc',
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTaskToGroup($request);

        self::assertSame(400, $response->getStatusCode());

        $row = $this->pdo->query("SELECT sort_order FROM tasker_tasks WHERE id = {$taskId}")->fetch(PDO::FETCH_ASSOC);
        self::assertSame(3, (int) $row['sort_order'], 'a rejected sort_order must not silently coerce to 0 and apply anyway');
    }

    /**
     * REGRESSION TEST: an EXPLICIT `sort_order: null` used to be cast
     * straight to 0 -- a real reorder to the top -- rather than being
     * treated as "leave unchanged", the same way an absent sort_order key
     * already was.
     */
    public function testMoveTaskToGroupTreatsExplicitNullSortOrderAsLeaveUnchanged(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'Null Sort Order Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Keep my position', null, false, null, 3);

        $plugin = new TaskerPlugin();
        $request = $this->hostRequest('POST', '/api/tasker/tasks/group', (string) json_encode([
            'task_id' => (string) $taskId,
            'sort_order' => null,
        ]));
        $request->user = (object) ['profile_id' => self::CALLER_ID];

        $response = $plugin->moveTaskToGroup($request);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sortOrder'], 'explicit null must leave sort_order unchanged, not reset it to 0');
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

    /**
     * REVIEW FIX (Important #1): reproduces the transport shape none of the
     * tests above exercise -- MCP `resources/read`. Every GET route with a
     * non-empty schema is auto-derived into an MCP resource
     * (`Whity\Mcp\Resources\ResourceDeriver`), and
     * `Whity\Mcp\Resources\ResourcesReadHandler::buildRequest()` constructs
     * its synthesized Request from the SDK's OWN `Whity\Sdk\Http\Request`
     * class directly -- never the `Whity\Core\Request` subclass this file's
     * own hostRequest() helper (and the HTTP/tools/call transports) pass.
     * Before toHostRequest() existed, listEnvironments()'s own
     * `instanceof \Whity\Core\Request` guard rejected exactly this shape
     * with a 500 -- the one MCP transport this alias had never actually been
     * driven against. Constructing the SDK type directly here (not
     * hostRequest(), which deliberately always returns the core type)
     * reproduces that gap precisely.
     */
    public function testListEnvironmentsSucceedsWithAnSdkRequestNotJustTheCoreSubclass(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);

        $sdkRequest = new \Whity\Sdk\Http\Request('GET', '/api/tasker/environments');
        self::assertNotInstanceOf(
            \Whity\Core\Request::class,
            $sdkRequest,
            'this test is only meaningful if the SDK type is NOT already the core subclass'
        );

        $plugin = new TaskerPlugin();
        $response = $plugin->listEnvironments($sdkRequest);

        self::assertSame(
            200,
            $response->getStatusCode(),
            'resources/read hands plugin routes a bare Whity\Sdk\Http\Request -- rejecting it (the pre-fix '
                . 'behaviour) 500s every environment alias called over that transport'
        );
        $payload = json_decode($response->getBody(), true);
        self::assertCount(1, $payload['data']);
    }

    /**
     * REVIEW FIX (promoted Minor): core's own routing constrains the OU id
     * with `{id:\d+}`, so a non-numeric value never reaches
     * OusApiHandler::update() over core's own API -- this flat alias has no
     * such pattern, so without a guard a non-numeric environment_id (e.g. an
     * agent passing an Environment NAME where an id is expected) reaches
     * Postgres as an integer comparison, throws, and 500s via
     * OusApiHandler's own catch. Must 400 instead -- this slice's error
     * discipline is that caller input never produces a 500.
     */
    public function testRenameEnvironmentRejectsANonNumericEnvironmentIdWith400NotA500(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);

        $plugin = new TaskerPlugin();
        $response = $plugin->renameEnvironment($this->hostRequest(
            'PATCH',
            '/api/tasker/environments',
            (string) json_encode(['environment_id' => 'engineering', 'name' => 'Should not apply'])
        ));

        self::assertSame(400, $response->getStatusCode());
        self::assertCount(0, $this->auditRowsFor(7), 'a rejected, non-numeric identifier must never reach OusApiHandler at all');
    }

    public function testDeleteEnvironmentRejectsANonNumericEnvironmentIdWith400NotA500(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);

        $previousGet = $_GET;
        $_GET = ['environment_id' => 'engineering'];
        try {
            $plugin = new TaskerPlugin();
            $response = $plugin->deleteEnvironment($this->hostRequest('DELETE', '/api/tasker/environments', ''));
        } finally {
            $_GET = $previousGet;
        }

        self::assertSame(400, $response->getStatusCode());
        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM organizational_units WHERE tenant_id = 7')->fetchColumn();
        self::assertSame(1, $count, 'the OU must survive a rejected, non-numeric delete identifier');
    }

    /**
     * REVIEW: "don't regress" check -- environment_id 0 / "0" must keep
     * 400ing exactly as before this fix, via OusApiHandler's own
     * `if (!$id)` guard (a digit STRING, "0" passes the new ctype_digit()
     * pre-check unchanged and is rejected downstream instead, same
     * observable outcome).
     */
    public function testRenameAndDeleteEnvironmentStillRejectAnIdOfZero(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);

        $plugin = new TaskerPlugin();

        $renameResponse = $plugin->renameEnvironment($this->hostRequest(
            'PATCH',
            '/api/tasker/environments',
            (string) json_encode(['environment_id' => 0, 'name' => 'Should not apply'])
        ));
        self::assertSame(400, $renameResponse->getStatusCode());

        $previousGet = $_GET;
        $_GET = ['environment_id' => '0'];
        try {
            $deleteResponse = $plugin->deleteEnvironment($this->hostRequest('DELETE', '/api/tasker/environments', ''));
        } finally {
            $_GET = $previousGet;
        }
        self::assertSame(400, $deleteResponse->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM organizational_units WHERE tenant_id = 7')->fetchColumn();
        self::assertSame(1, $count, 'the real OU (id 1) must be untouched by either rejected id-0 call');
    }

    // ==================== AttentionApiHandler::rank() (D1b Task 11 round 2: rank_tasks) ====================
    //
    // Both rank() and attention() are OU-scoped project-level reads exactly
    // like TasksApiHandler::readyWork() -- see AttentionApiHandler's own
    // class docblock for why that confines every test below to this
    // Postgres-only file. rank_by was withdrawn in full (see that same
    // docblock) after the live original surface showed it never existed --
    // the real contract orders by priority, then due date, then id.

    public function testRankOrdersByPriorityThenDueDateThenId(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Rank ordering project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        // Priority leads: rush beats medium beats low, regardless of due date.
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Low, due soonest', 'low', false, '2027-01-01');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Rush, due latest', 'rush', false, '2027-06-01');
        // Tied on priority (both medium): due date breaks the tie.
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Medium, due later', 'medium', false, '2027-04-01');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Medium, due sooner', 'medium', false, '2027-02-01');

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, $projectId)->getBody(), true);

        self::assertSame(
            ['Rush, due latest', 'Medium, due sooner', 'Medium, due later', 'Low, due soonest'],
            array_column($payload['data'], 'text')
        );
    }

    /**
     * Round 3 review finding: the fixture above uses pinned = false and
     * default sort_order everywhere, so re-introducing `pinned DESC` or
     * `sort_order` into rank()'s own ORDER BY (get_ready_work's ordering, or
     * this task's own withdrawn 'sorting_order'/'pinned' rank_by options)
     * would silently change nothing it asserts. This fixture pins a LOW
     * priority task with a very negative sort_order — if pinned or
     * sort_order leaked into rank()'s ordering, this task would jump to the
     * front; the live original's rank_tasks orders by priority and due date
     * only, so it must stay last.
     */
    public function testRankIgnoresPinnedStatusAndSortOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Rank ignores pinned project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Rush', 'rush', false, null, 0);
        // Pinned AND an extremely low sort_order -- would rank FIRST if
        // either leaked into rank()'s ordering. It must still rank LAST:
        // low priority beats any pinned/sort_order advantage.
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Low but pinned', 'low', true, null, -100);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, $projectId)->getBody(), true);

        self::assertSame(['Rush', 'Low but pinned'], array_column($payload['data'], 'text'));
    }

    /**
     * Round 3 review finding: proves the final tiebreak is `id` (insertion
     * order here), not `sort_order` -- two tasks tied on BOTH priority and
     * due_date, with sort_order values that would REVERSE the expected
     * order if sort_order were consulted before id.
     */
    public function testRankTieBreaksByIdNotSortOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Rank tiebreak project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        // Created first (lower id), but with a HIGHER sort_order than the
        // second task -- if sort_order were consulted before id, the second
        // task (sort_order 1) would wrongly rank first.
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Created first', 'medium', false, '2027-03-01', 50);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Created second', 'medium', false, '2027-03-01', 1);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, $projectId)->getBody(), true);

        self::assertSame(['Created first', 'Created second'], array_column($payload['data'], 'text'));
    }

    public function testRankExcludesDoneTasks(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Rank excludes done project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $doneTaskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Already done', 'rush');
        $this->pdo->exec("UPDATE tasker_tasks SET status = 'done' WHERE id = {$doneTaskId}");
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Still open');

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, $projectId)->getBody(), true);

        self::assertSame(['Still open'], array_column($payload['data'], 'text'));
    }

    public function testRankRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, 1, 'Parent OU rank project');

        $handler = new AttentionApiHandler($this->pdo);
        $response = $handler->rank(7, 2, $projectId);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testRankRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant rank project');

        $handler = new AttentionApiHandler($this->pdo);
        $response = $handler->rank(7, null, $otherTenantProjectId);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * The live original's own "otherwise this requires confirmed: true to
     * rank across ALL projects" case: a null $projectId reaching
     * AttentionApiHandler::rank() directly (the route-level confirmed gate
     * that decides WHEN to pass null is tested separately, via Reflection,
     * in TaskerPluginTest -- see rankTasks()'s own docblock for why that
     * split exists) must rank across every project in OU scope, not just
     * one.
     */
    public function testRankAcrossAllProjectsWhenProjectIdIsNull(): void
    {
        $projectA = $this->makeProjectDirect(7, null, 'Rank-all project A');
        $sectionA = $this->makeSectionDirect(7, $projectA);
        $projectB = $this->makeProjectDirect(7, null, 'Rank-all project B');
        $sectionB = $this->makeSectionDirect(7, $projectB);
        $this->makeTaskDirect(7, $projectA, $sectionA, 'Task in A', 'low');
        $this->makeTaskDirect(7, $projectB, $sectionB, 'Task in B', 'rush');

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, null)->getBody(), true);

        $texts = array_column($payload['data'], 'text');
        self::assertContains('Task in A', $texts);
        self::assertContains('Task in B', $texts);
        // Priority still governs across the combined set: rush (B) leads.
        self::assertSame('Task in B', $payload['data'][0]['text']);
    }

    public function testRankAcrossAllProjectsExcludesASiblingOusTask(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU rank-all project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $this->makeTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Should not leak');

        $handler = new AttentionApiHandler($this->pdo);
        // Caller restricted to OU 2; the project lives in sibling OU 3.
        $payload = json_decode($handler->rank(7, 2, null)->getBody(), true);

        self::assertSame([], $payload['data']);
    }

    public function testRankAcrossAllProjectsExcludesAnotherTenantsTask(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant rank-all project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $this->makeTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak');

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->rank(7, null, null)->getBody(), true);

        self::assertSame([], $payload['data']);
    }

    // ==================== AttentionApiHandler::attention() (D1b Task 11 round 2: get_my_attention) ====================
    //
    // "My" resolves to created_by (ruling #5: tasker_tasks has no assignee
    // column, only created_by) -- CALLER_ID below stands in for the
    // resolved caller's profile id every test binds tasks to or away from.
    // `pinned` is REMOVED (see AttentionApiHandler's own class docblock):
    // the live original's five buckets never included it -- only `overdue`
    // and `stale` are implementable on this backend today.

    private const CALLER_ID = 42;

    public function testAttentionOverdueBucketIncludesAPastDueTaskAndExcludesADueTomorrowTask(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Overdue project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');
        $tomorrow  = (new \DateTimeImmutable('tomorrow'))->format('Y-m-d');

        $this->makeAttentionTaskDirect(7, $projectId, $sectionId, 'Past due', self::CALLER_ID, 'pending', $yesterday);
        $this->makeAttentionTaskDirect(7, $projectId, $sectionId, 'Due tomorrow', self::CALLER_ID, 'pending', $tomorrow);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame(['Past due'], array_column($payload['data']['overdue'], 'text'));
        self::assertSame([], $payload['data']['stale']);
    }

    public function testAttentionStaleBucketIncludesAnUntouchedInProgressTaskAndExcludesATouchedTodayTask(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Stale project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Gone quiet', self::CALLER_ID, 'in_progress', null, false,
            "CURRENT_TIMESTAMP - INTERVAL '3 days'"
        );
        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Touched today', self::CALLER_ID, 'in_progress', null, false,
            'CURRENT_TIMESTAMP'
        );

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame(['Gone quiet'], array_column($payload['data']['stale'], 'text'));
    }

    /**
     * A pending (not in_progress) task untouched for far longer than 2 days
     * must NOT count as stale -- the stale bucket is specifically
     * in-progress work gone quiet, not merely old.
     */
    public function testAttentionStaleBucketExcludesAnOldButNotInProgressTask(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Old but pending project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Old but never started', self::CALLER_ID, 'pending', null, false,
            "CURRENT_TIMESTAMP - INTERVAL '30 days'"
        );

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame([], $payload['data']['stale']);
    }

    /**
     * Round 3 correction: `pinned` is real for get_my_attention, but as a
     * SORT key within each bucket, not a bucket of its own (see
     * AttentionApiHandler's own class docblock for the full history — round
     * 1 shipped it as a bucket, round 2 deleted it entirely, both wrong).
     * A pinned task less overdue than an unpinned one must still sort
     * FIRST, proving pinned genuinely overrides the bucket's own normal
     * due_date ordering rather than only ever coinciding with it.
     */
    public function testAttentionOverdueBucketSortsPinnedTasksFirst(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Overdue pinned-order project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $fiveDaysAgo = (new \DateTimeImmutable('-5 days'))->format('Y-m-d');
        $oneDayAgo = (new \DateTimeImmutable('-1 day'))->format('Y-m-d');

        // Far more overdue, but NOT pinned -- must still rank second.
        $this->makeAttentionTaskDirect(7, $projectId, $sectionId, 'Very overdue', self::CALLER_ID, 'pending', $fiveDaysAgo, false);
        // Barely overdue, but PINNED -- must rank first despite the later due_date.
        $this->makeAttentionTaskDirect(7, $projectId, $sectionId, 'Barely overdue, pinned', self::CALLER_ID, 'pending', $oneDayAgo, true);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame(['Barely overdue, pinned', 'Very overdue'], array_column($payload['data']['overdue'], 'text'));
    }

    /**
     * Same proof as the overdue test above, for the `stale` bucket's own
     * secondary sort (updated_at) instead of due_date.
     */
    public function testAttentionStaleBucketSortsPinnedTasksFirst(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Stale pinned-order project');
        $sectionId = $this->makeSectionDirect(7, $projectId);

        // Quieter for far longer, but NOT pinned -- must still rank second.
        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Very stale', self::CALLER_ID, 'in_progress', null, false,
            "CURRENT_TIMESTAMP - INTERVAL '10 days'"
        );
        // Barely past the 2-day cutoff, but PINNED -- must rank first
        // despite being touched far more recently.
        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Barely stale, pinned', self::CALLER_ID, 'in_progress', null, true,
            "CURRENT_TIMESTAMP - INTERVAL '3 days'"
        );

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame(['Barely stale, pinned', 'Very stale'], array_column($payload['data']['stale'], 'text'));
    }

    /**
     * A task in every other respect qualifying for overdue AND stale, but
     * created by a DIFFERENT profile, must be excluded from both -- proving
     * ruling #5's created_by filter is real, not merely OU/tenant scoping
     * that happens to look personal.
     */
    public function testAttentionExcludesTasksCreatedBySomeoneElseFromEveryBucket(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Someone elses tasks project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');

        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Not mine', 999, 'in_progress', $yesterday, false,
            "CURRENT_TIMESTAMP - INTERVAL '5 days'"
        );

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame([], $payload['data']['overdue']);
        self::assertSame([], $payload['data']['stale']);
    }

    /**
     * Ruling #8: a completed task must appear in NO bucket, even one that
     * structurally qualifies for both overdue AND stale simultaneously
     * (past due_date, long-untouched updated_at). This is the single most
     * likely way this tool would end up useless in practice, per the
     * ruling's own text -- tested explicitly rather than assumed from the
     * individual bucket predicates. status = 'done' here overrides the
     * fixture's own 'in_progress'/past-due_date setup, which is the whole
     * point of the test.
     */
    public function testAttentionExcludesACompletedTaskFromEveryBucketEvenIfOtherwiseQualifying(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Completed attention project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');

        $this->makeAttentionTaskDirect(
            7, $projectId, $sectionId, 'Finished but flagged', self::CALLER_ID,
            'done', $yesterday, false, "CURRENT_TIMESTAMP - INTERVAL '5 days'"
        );

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectId, self::CALLER_ID)->getBody(), true);

        self::assertSame([], $payload['data']['overdue']);
        self::assertSame([], $payload['data']['stale']);
    }

    /**
     * Ruling #6: omitting project_id means "every project in OU scope", not
     * the caller's default project.
     */
    public function testAttentionWithNoProjectIdSpansEveryProjectInOuScope(): void
    {
        $projectA = $this->makeProjectDirect(7, null, 'Span project A');
        $sectionA = $this->makeSectionDirect(7, $projectA);
        $projectB = $this->makeProjectDirect(7, null, 'Span project B');
        $sectionB = $this->makeSectionDirect(7, $projectB);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');

        $this->makeAttentionTaskDirect(7, $projectA, $sectionA, 'Overdue in A', self::CALLER_ID, 'pending', $yesterday);
        $this->makeAttentionTaskDirect(7, $projectB, $sectionB, 'Overdue in B', self::CALLER_ID, 'pending', $yesterday);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, null, self::CALLER_ID)->getBody(), true);

        $texts = array_column($payload['data']['overdue'], 'text');
        self::assertContains('Overdue in A', $texts);
        self::assertContains('Overdue in B', $texts);
    }

    public function testAttentionWithAProjectIdScopesToThatProjectOnly(): void
    {
        $projectA = $this->makeProjectDirect(7, null, 'Scoped project A');
        $sectionA = $this->makeSectionDirect(7, $projectA);
        $projectB = $this->makeProjectDirect(7, null, 'Scoped project B');
        $sectionB = $this->makeSectionDirect(7, $projectB);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');

        $this->makeAttentionTaskDirect(7, $projectA, $sectionA, 'Overdue in A', self::CALLER_ID, 'pending', $yesterday);
        $this->makeAttentionTaskDirect(7, $projectB, $sectionB, 'Overdue in B', self::CALLER_ID, 'pending', $yesterday);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, $projectA, self::CALLER_ID)->getBody(), true);

        $texts = array_column($payload['data']['overdue'], 'text');
        self::assertContains('Overdue in A', $texts);
        self::assertNotContains('Overdue in B', $texts, 'a supplied project_id must scope OUT other projects, not just add to the span');
    }

    public function testAttentionExcludesASiblingOusTaskWhenSpanningAllProjects(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'Sibling OU attention project');
        $siblingSectionId = $this->makeSectionDirect(7, $siblingProjectId);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');
        $this->makeAttentionTaskDirect(7, $siblingProjectId, $siblingSectionId, 'Should not leak', self::CALLER_ID, 'pending', $yesterday);

        $handler = new AttentionApiHandler($this->pdo);
        // Caller restricted to OU 2; the project lives in sibling OU 3.
        $payload = json_decode($handler->attention(7, 2, null, self::CALLER_ID)->getBody(), true);

        self::assertSame([], $payload['data']['overdue']);
    }

    public function testAttentionExcludesAnotherTenantsTaskWhenSpanningAllProjects(): void
    {
        $otherProjectId = $this->makeProjectDirect(9, null, 'Other tenant attention project');
        $otherSectionId = $this->makeSectionDirect(9, $otherProjectId);
        $yesterday = (new \DateTimeImmutable('yesterday'))->format('Y-m-d');
        $this->makeAttentionTaskDirect(9, $otherProjectId, $otherSectionId, 'Should not leak', self::CALLER_ID, 'pending', $yesterday);

        $handler = new AttentionApiHandler($this->pdo);
        $payload = json_decode($handler->attention(7, null, null, self::CALLER_ID)->getBody(), true);

        self::assertSame([], $payload['data']['overdue']);
    }

    public function testAttentionRejects404ForAnExplicitProjectIdOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, 1, 'Parent OU attention project');

        $handler = new AttentionApiHandler($this->pdo);
        $response = $handler->attention(7, 2, $projectId, self::CALLER_ID);

        self::assertSame(404, $response->getStatusCode());
    }

    // ── D1b Task 12b: contract-parity safety-gate fixes ─────────────────────
    //
    // Full ROUTE-LEVEL dispatch (via registerOusContainer(), same as the
    // Environment alias tests above), not just the ApiHandler classes
    // directly, because the behaviour under test here IS the route method's
    // own composition: reading delete_tasks/confirmed off the QUERY STRING
    // (queryParamBool()) rather than a JSON body, and resolveSection()'s own
    // OU-aware SQL, both of which need a real Postgres connection anyway
    // (OuScopeResolver::whereFragment()'s `= ANY(:scope)` fails at
    // PDO::prepare() under SQLite). These are the parity-allowlist.php
    // `dischargedBy` tests for delete_section/delete_project — the guard
    // that lets those two SEMANTIC entries be removed greps for these exact
    // method names, so each one asserts the REAL behaviour, not a stub.

    /**
     * parity-allowlist.php['delete_section']'s dischargedBy test.
     *
     * Proves the whole floor in one place: refusal survives (asserted by
     * COUNTING rows, not just the status code — a 409 that still let the
     * DELETE run underneath it would pass a status-code-only check and
     * still be the exact bug this closes), explicit false refuses
     * identically to absent, delete_tasks:true really cascades (the FK
     * ON DELETE CASCADE this fix now gates), an empty section still deletes
     * without the flag, and every one of delete_tasks's three states
     * arrives as a QUERY-STRING parameter — the actual MCP transport shape
     * (core empties the DELETE body and flattens every argument into the
     * query string) — not a JSON body.
     */
    public function testDeleteSectionRefusesANonEmptySectionUnlessDeleteTasksIsTrue(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'D12b delete_section project');
        $nonEmptySectionId = $this->makeSectionDirectNamed(7, $projectId, 'Non-empty section');
        $emptySectionId = $this->makeSectionDirectNamed(7, $projectId, 'Empty section');
        $keepSectionId = $this->makeSectionDirectNamed(7, $projectId, 'Keep section'); // keeps the project non-empty throughout

        $this->makeTaskDirect(7, $projectId, $nonEmptySectionId, 'Task A');
        $this->makeTaskDirect(7, $projectId, $nonEmptySectionId, 'Task B');
        $this->makeGroupDirect(7, $nonEmptySectionId, 'Group A');

        $plugin = new TaskerPlugin();

        // delete_tasks ABSENT (defaults false) — the exact call an
        // original-app agent makes routinely, and a REFUSAL against the
        // original. Must refuse here too, not cascade.
        $refuseRequest = $this->hostRequest('DELETE', "/api/tasker/sections?section_id={$nonEmptySectionId}");
        $refuseRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $refuseResponse = $plugin->deleteSection($refuseRequest);

        self::assertSame(409, $refuseResponse->getStatusCode());
        $refuseBody = json_decode($refuseResponse->getBody(), true);
        self::assertStringContainsString('delete_tasks', $refuseBody['error']);
        // Pinned to the RENDERED PHRASE, not a bare digit — a bare '1'/'2'
        // would pass on almost any message, including the status code.
        self::assertStringContainsString('2 task(s)', $refuseBody['error'], 'the refusal must report the task count');
        self::assertStringContainsString('1 group(s)', $refuseBody['error'], 'the refusal must report the group count');

        self::assertSame(2, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_tasks WHERE section_id = {$nonEmptySectionId}")->fetchColumn(), 'the tasks must still exist after a refused delete');
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_groups WHERE section_id = {$nonEmptySectionId}")->fetchColumn(), 'the group must still exist after a refused delete');
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_sections WHERE id = {$nonEmptySectionId}")->fetchColumn(), 'the section itself must still exist after a refused delete');

        // delete_tasks EXPLICITLY false must refuse identically to absent —
        // proves the gate distinguishes "true" from everything else, not
        // just "present vs absent". Sent as `0`, not the string "false":
        // `http_build_query(['delete_tasks' => false])` — the form core's
        // real MCP transport actually puts on the wire — renders `0`, not
        // the word "false"; queryParamBool()'s own falsy-string-set tests
        // already cover "false"/"False"/etc, so this end-to-end test
        // exercises the shape that actually arrives in production instead.
        $explicitFalseRequest = $this->hostRequest('DELETE', "/api/tasker/sections?section_id={$nonEmptySectionId}&delete_tasks=0");
        $explicitFalseRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $explicitFalseResponse = $plugin->deleteSection($explicitFalseRequest);
        self::assertSame(409, $explicitFalseResponse->getStatusCode());

        // delete_tasks:true, arriving as a QUERY PARAMETER — rendered as `1`
        // by http_build_query(), the real wire form, not the string "true" —
        // must proceed AND really cascade.
        $forceRequest = $this->hostRequest('DELETE', "/api/tasker/sections?section_id={$nonEmptySectionId}&delete_tasks=1");
        $forceRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $forceResponse = $plugin->deleteSection($forceRequest);

        self::assertSame(204, $forceResponse->getStatusCode());
        self::assertSame(0, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_sections WHERE id = {$nonEmptySectionId}")->fetchColumn());
        self::assertSame(0, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_tasks WHERE section_id = {$nonEmptySectionId}")->fetchColumn(), 'the FK cascade must really have removed the tasks');
        self::assertSame(0, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_groups WHERE section_id = {$nonEmptySectionId}")->fetchColumn(), 'the FK cascade must really have removed the group');

        // An EMPTY section deletes without the flag at all.
        $emptyRequest = $this->hostRequest('DELETE', "/api/tasker/sections?section_id={$emptySectionId}");
        $emptyRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $emptyResponse = $plugin->deleteSection($emptyRequest);
        self::assertSame(204, $emptyResponse->getStatusCode());

        // $keepSectionId was never touched — sanity check that the project
        // still has a section at all, i.e. none of the above accidentally
        // tripped the SEPARATE "last remaining section" guard instead of
        // (or as well as) the delete_tasks gate under test.
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_sections WHERE id = {$keepSectionId}")->fetchColumn());
    }

    /**
     * parity-allowlist.php['delete_project']'s dischargedBy test.
     *
     * The original REQUIRES confirmed:true before permanently deleting a
     * project and everything under it; this route previously had no gate at
     * all. Proves: confirmed absent refuses (project survives), confirmed
     * EXPLICITLY false refuses identically (not just "present vs absent"),
     * an omitted project_id refuses even WHEN confirmed — never guessing the
     * caller's default project for a destructive target (post-merge review
     * fix), and confirmed:true — arriving as a QUERY-STRING parameter, the
     * real MCP transport shape for a DELETE — actually deletes.
     */
    public function testDeleteProjectRefusesWithoutConfirmedTrue(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'D12b delete_project project');

        $plugin = new TaskerPlugin();

        $refuseRequest = $this->hostRequest('DELETE', "/api/tasker/projects?project_id={$projectId}");
        $refuseRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $refuseResponse = $plugin->deleteProject($refuseRequest);

        self::assertSame(400, $refuseResponse->getStatusCode());
        $refuseBody = json_decode($refuseResponse->getBody(), true);
        self::assertStringContainsString('confirmed', $refuseBody['error']);
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn(), 'the project must survive an unconfirmed delete');

        // Sent as `0`, the real http_build_query() wire form for a PHP
        // false, not the string "false" — queryParamBool()'s own
        // falsy-string-set tests already cover "false" itself.
        $explicitFalseRequest = $this->hostRequest('DELETE', "/api/tasker/projects?project_id={$projectId}&confirmed=0");
        $explicitFalseRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $explicitFalseResponse = $plugin->deleteProject($explicitFalseRequest);
        self::assertSame(400, $explicitFalseResponse->getStatusCode());
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn(), 'confirmed:false must refuse identically to absent, not be treated as truthy');

        // REVIEW FIX (post-merge, item 1): confirmed:true with NO project_id
        // at all must NOT silently fall back to the caller's default
        // project and delete IT — a destructive route must never guess its
        // target. Give the caller a real default first, so a bug here would
        // actually destroy something observable rather than just 404ing for
        // an unrelated reason.
        $sessionHandler = new \Tasker\Api\SessionApiHandler($this->pdo);
        $sessionHandler->setDefaultProject(7, self::CALLER_ID, $projectId);
        $noProjectIdRequest = $this->hostRequest('DELETE', '/api/tasker/projects?confirmed=1');
        $noProjectIdRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $noProjectIdResponse = $plugin->deleteProject($noProjectIdRequest);
        self::assertSame(400, $noProjectIdResponse->getStatusCode());
        $noProjectIdBody = json_decode($noProjectIdResponse->getBody(), true);
        self::assertStringContainsString('project_id', $noProjectIdBody['error']);
        self::assertSame(
            1,
            (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn(),
            'confirmed:true with NO project_id must refuse rather than guess the caller\'s default project and '
                . 'delete it'
        );

        $confirmedRequest = $this->hostRequest('DELETE', "/api/tasker/projects?project_id={$projectId}&confirmed=1");
        $confirmedRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $confirmedResponse = $plugin->deleteProject($confirmedRequest);
        self::assertSame(204, $confirmedResponse->getStatusCode());
        self::assertSame(0, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn());
    }

    /**
     * D1b Task 12b floor requirement: list_groups/create_group resolve a
     * section SLUG when project_id is supplied — the exact path
     * IdentifierResolver::resolveSection() refuses when its parent is null
     * (a slug is unique only within its parent), which is why these two
     * routes' descriptions used to explicitly disclaim slug support. Proves
     * both routes now pass project_id through as that parent.
     */
    public function testListGroupsAndCreateGroupResolveASectionSlugWhenProjectIdIsSupplied(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'D12b slug project');
        $sectionId = $this->makeSectionDirect(7, $projectId); // slug is 'backlog', per makeSectionDirect()
        $this->makeGroupDirect(7, $sectionId, 'Existing group');

        $plugin = new TaskerPlugin();

        $listRequest = $this->hostRequest('GET', "/api/tasker/groups?section_id=backlog&project_id={$projectId}");
        $listRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $listResponse = $plugin->listGroups($listRequest);

        self::assertSame(200, $listResponse->getStatusCode());
        $listPayload = json_decode($listResponse->getBody(), true);
        self::assertCount(1, $listPayload['data'], 'the slug must have resolved to the real section, not 404d');

        $createRequest = $this->hostRequest(
            'POST',
            '/api/tasker/groups',
            (string) json_encode(['section_id' => 'backlog', 'project_id' => $projectId, 'name' => 'New via slug'])
        );
        $createRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $createResponse = $plugin->createGroup($createRequest);

        self::assertSame(201, $createResponse->getStatusCode());
        $created = json_decode($createResponse->getBody(), true);
        self::assertSame($sectionId, $created['data']['sectionId'] ?? $created['data']['section_id'] ?? null);
    }

    /**
     * REVIEW FIX (post-merge, item 3): both route descriptions advertise
     * "Omit to use your default project", but the test above always
     * supplied project_id explicitly — it never actually exercised the
     * default-project path itself. This does: project_id is OMITTED
     * entirely, and the slug only resolves because the caller's stored
     * default project (set via SessionApiHandler, the same mechanism
     * set_default_project uses) is honoured as resolveSection()'s parent.
     */
    public function testListGroupsAndCreateGroupUseTheCallersDefaultProjectWhenProjectIdIsOmitted(): void
    {
        $this->registerOusContainer();
        $this->makeMembership(self::CALLER_ID, 7, null);

        $projectId = $this->makeProjectDirect(7, null, 'D12b default project');
        $sectionId = $this->makeSectionDirect(7, $projectId); // slug is 'backlog'
        $this->makeGroupDirect(7, $sectionId, 'Existing group');

        (new \Tasker\Api\SessionApiHandler($this->pdo))->setDefaultProject(7, self::CALLER_ID, $projectId);

        $plugin = new TaskerPlugin();

        $listRequest = $this->hostRequest('GET', '/api/tasker/groups?section_id=backlog');
        $listRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $listResponse = $plugin->listGroups($listRequest);

        self::assertSame(200, $listResponse->getStatusCode());
        $listPayload = json_decode($listResponse->getBody(), true);
        self::assertCount(
            1,
            $listPayload['data'],
            'omitting project_id entirely must still resolve the slug, via the caller\'s DEFAULT project'
        );

        $createRequest = $this->hostRequest(
            'POST',
            '/api/tasker/groups',
            (string) json_encode(['section_id' => 'backlog', 'name' => 'New via default project'])
        );
        $createRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $createResponse = $plugin->createGroup($createRequest);

        self::assertSame(201, $createResponse->getStatusCode());
        $created = json_decode($createResponse->getBody(), true);
        self::assertSame($sectionId, $created['data']['sectionId'] ?? $created['data']['section_id'] ?? null);
    }

    /**
     * REVIEW FIX (post-merge, item 4): a stored default project that has
     * since moved out of the caller's OU scope must NOT be honoured — the
     * same rule rankTasks() already documents and applies for its own
     * default-project fallback. resolveOptionalParentId() used to pass
     * $defaultValue straight through as listGroups()'s/createGroup()'s
     * resolved parent, skipping the OU re-validation every other
     * defaultProjectIdFor() consumer applies; it now re-resolves the
     * default through IdentifierResolver::resolveProject() (OU-scoped)
     * instead. Not exploitable even before this fix — resolveSection()'s
     * own tenant/OU-scoped section join would still 404 a stale default —
     * but this proves the RIGHT layer now also refuses it, not just a
     * downstream one.
     */
    public function testListGroupsDoesNotHonourADefaultProjectThatHasMovedOutOfTheCallersOuScope(): void
    {
        $this->registerOusContainer();
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, null); // sibling of OU 1, not an ancestor/descendant

        // Caller is restricted to OU 2.
        $this->makeMembership(self::CALLER_ID, 7, 2);

        // The stored default project lives in sibling OU 1 -- out of scope.
        $projectId = $this->makeProjectDirect(7, 1, 'Out of scope default project');
        $this->makeSectionDirect(7, $projectId); // slug 'backlog'

        (new \Tasker\Api\SessionApiHandler($this->pdo))->setDefaultProject(7, self::CALLER_ID, $projectId);

        $plugin = new TaskerPlugin();
        $listRequest = $this->hostRequest('GET', '/api/tasker/groups?section_id=backlog');
        $listRequest->user = (object) ['profile_id' => self::CALLER_ID];
        $listResponse = $plugin->listGroups($listRequest);

        self::assertSame(
            404,
            $listResponse->getStatusCode(),
            'a default project outside the caller\'s OU scope must not be honoured for slug resolution'
        );
    }
}
