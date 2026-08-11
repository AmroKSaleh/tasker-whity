<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\Tests\Support\SqlitePolyfills;

/**
 * NOTE ON WHAT MOVED (whole-branch review finding C1): create()'s
 * section-existence check used to be tenant-scoped only; it is now OU-aware,
 * joining tasker_sections to tasker_projects and calling
 * OuScopeResolver::whereFragment() UNCONDITIONALLY — PostgreSQL's
 * `= ANY(:scope)`, which SQLite's PDO::prepare() rejects outright regardless
 * of runtime branching. The four tests that exercised create() directly
 * (testCreateStampsTenantAndDefaultsStatusToPending,
 * testCreateRejectsASectionOutsideTheCallersTenant,
 * testCreateAcceptsAValidPriority, testCreateRejectsAnInvalidPriority) moved
 * to TenantIsolationOuTest.php (Postgres-backed), alongside new OU-boundary
 * regression tests proving the fix, and (D1b Task 6) a new test proving
 * create()'s newly-added detail/due_date fields round-trip correctly. Every
 * OTHER test below only ever used create() as a convenience fixture-builder
 * for some other method under test (update/move/delete/complete/pin/tag/
 * listForSection) — those build their task fixture via insertTaskDirect() (a
 * raw INSERT bypassing create() entirely) so they stay on SQLite unchanged in
 * every other respect. listForSection() itself remains tenant-scoped only
 * (finding I7) and has no Postgres-only syntax, so it keeps its SQLite
 * coverage as-is — and so does its D1b Task 6 successor, listFiltered(),
 * whose own fixtures (below) are built the same insertTaskDirect() way for
 * the same reason.
 */
final class TasksApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private TasksApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        // Pinned whity-core classes this handler constructs directly
        // (AuditLogger, EntityTagRepository) hardcode NOW() in their own SQL;
        // see SqlitePolyfills for why this in-memory SQLite double needs the
        // shim and real PostgreSQL deployments never do.
        SqlitePolyfills::registerNowFunction($this->pdo);

        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('CREATE TABLE tasker_sections (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL)');
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id) VALUES (100, 7)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (1, 7, 100), (2, 9, 100)");
        (new CreateTaskerTasksTable())->up($this->pdo);

        $this->handler = new TasksApiHandler($this->pdo);
    }

    /**
     * Inserts a task directly (bypassing handler->create(), which requires a
     * real Postgres connection for its section-existence check — see this
     * class's own docblock) and returns the id a subsequent handler call
     * must use: SQLite's own `rowid`, not the `id` column value (see
     * TasksApiHandler::idColumn()'s own doc for why those diverge under the
     * in-memory SQLite double).
     *
     * $status is appended last, defaulting to 'pending', so every existing
     * call site keeps working unchanged — added for D1b Task 6's
     * listFiltered() fixtures, which need an 'in_progress'/'done' row
     * without going through complete() (which only ever produces 'done').
     */
    private function insertTaskDirect(
        int $tenantId,
        int $projectId,
        int $sectionId,
        string $text,
        ?string $priority = null,
        ?int $groupId = null,
        string $status = 'pending'
    ): int {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_tasks
                (public_id, tenant_id, project_id, section_id, group_id, text, priority, status, created_by, created_at, updated_at)
             VALUES
                (:public_id, :tenant_id, :project_id, :section_id, :group_id, :text, :priority, :status, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        );
        $stmt->bindValue(':public_id', sprintf('dddddddd-0000-0000-0000-%012d', random_int(1, 999999999999)));
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':group_id', $groupId, $groupId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':text', $text, PDO::PARAM_STR);
        $stmt->bindValue(':priority', $priority, $priority === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':status', $status, PDO::PARAM_STR);
        $stmt->execute();

        return (int) $this->pdo->lastInsertId();
    }

    /**
     * Fixture for whity-core's `tags` table (see
     * host/.core/database/migrations/063_create_taxonomy_tables.php), minus
     * the FK REFERENCES clauses the in-memory SQLite double doesn't need.
     * Only the columns TagRepository::find() selects are required.
     */
    private function createTagsTable(): void
    {
        $this->pdo->exec('
            CREATE TABLE tags (
                id INTEGER NOT NULL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                name VARCHAR(128) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP)
            )
        ');
    }

    /**
     * Insert one `tags` row owned by $tenantId with the given $id, so
     * TasksApiHandler::tag()'s TagRepository::find($tenantId, $id) lookup
     * succeeds. $id is supplied explicitly (never relying on autoincrement).
     */
    private function insertTag(int $id, int $tenantId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tags (id, tenant_id, group_id, name) VALUES (:id, :tenant_id, 1, :name)'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId, ':name' => 'tag-' . $id]);
    }

    /**
     * Fixture for whity-core's `entity_tags` table (see Task 1's own
     * PingApiHandlerTest for the identical shape).
     */
    private function createEntityTagsTable(): void
    {
        $this->pdo->exec('
            CREATE TABLE entity_tags (
                tenant_id INTEGER NOT NULL,
                entity_type VARCHAR(128) NOT NULL,
                entity_id BIGINT NOT NULL,
                tag_id BIGINT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                PRIMARY KEY (entity_type, entity_id, tag_id)
            )
        ');
    }

    /**
     * D1b Task 6: list_tasks generalises listForSection() into project/
     * section/group/status filters. The original's documented contract is
     * "Defaults to excluding DONE tasks. Pass 'all' to include everything" —
     * NOT "pending only". in_progress is a live status (the directive
     * playbook tells agents to set it when they start work), so it must
     * appear in the default result too — a bug in this test's first version
     * (calling listFiltered() with the literal string 'pending' to stand in
     * for "the default") never created an in_progress fixture, so it never
     * caught listFiltered() silently narrowing the default down to a plain
     * `status = 'pending'` predicate. Now exercises the REAL default (no
     * 5th argument at all) against all three statuses at once.
     */
    public function testListFilteredExcludesDoneByDefaultAndIncludesItOnAll(): void
    {
        $this->insertTaskDirect(7, 100, 1, 'Open');
        $this->insertTaskDirect(7, 100, 1, 'In progress', null, null, 'in_progress');
        $this->insertTaskDirect(7, 100, 1, 'Done', null, null, 'done');

        $default = json_decode($this->handler->listFiltered(7, null, 1, null)->getBody(), true);
        $defaultTexts = array_column($default['data'], 'text');
        self::assertCount(2, $default['data']);
        self::assertContains('Open', $defaultTexts);
        self::assertContains('In progress', $defaultTexts, 'in_progress must appear by default -- only done is excluded');
        self::assertNotContains('Done', $defaultTexts);

        $all = json_decode($this->handler->listFiltered(7, null, 1, null, 'all')->getBody(), true);
        self::assertCount(3, $all['data']);
    }

    /**
     * The other half of the same contract: an EXPLICIT status value is a
     * plain equality filter (unchanged by the fix above), not "everything
     * except done" — passing 'pending' explicitly must exclude in_progress
     * too, exactly like passing 'in_progress' explicitly excludes pending.
     */
    public function testListFilteredByExplicitStatusMatchesOnlyThatStatus(): void
    {
        $this->insertTaskDirect(7, 100, 1, 'Open');
        $this->insertTaskDirect(7, 100, 1, 'In progress', null, null, 'in_progress');

        $pending = json_decode($this->handler->listFiltered(7, null, 1, null, 'pending')->getBody(), true);
        self::assertCount(1, $pending['data']);
        self::assertSame('Open', $pending['data'][0]['text']);

        $inProgress = json_decode($this->handler->listFiltered(7, null, 1, null, 'in_progress')->getBody(), true);
        self::assertCount(1, $inProgress['data']);
        self::assertSame('In progress', $inProgress['data'][0]['text']);
    }

    public function testListFilteredByProjectSpansEverySectionOfThatProject(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        $this->insertTaskDirect(7, 100, 1, 'In section 1');
        $this->insertTaskDirect(7, 100, 3, 'In section 3');

        $payload = json_decode($this->handler->listFiltered(7, 100, null, null, 'all')->getBody(), true);

        self::assertCount(2, $payload['data']);
    }

    public function testCompleteSetsStatusAndCompletedAt(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Finish me');

        $response = $this->handler->complete(7, $taskId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('done', $payload['data']['status']);
        self::assertNotNull($payload['data']['completedAt']);
    }

    public function testCompleteRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->complete(9, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForSectionReturnsOnlyThatSectionsTasksForTheCallersTenant(): void
    {
        $this->insertTaskDirect(7, 100, 1, 'A');

        $payload = json_decode($this->handler->listForSection(7, 1)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['text']);
    }

    /**
     * Regression test for whole-branch review finding I7: listForSection()
     * used to have NO existence check on its parent {sectionId} at all — a
     * nonexistent or cross-tenant section returned `200 []` instead of 404.
     */
    public function testListForSectionRejects404ForANonexistentSection(): void
    {
        $response = $this->handler->listForSection(7, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForSectionRejects404ForASectionOutsideTheCallersTenant(): void
    {
        // Section 2 belongs to tenant 9, not the caller's tenant 7.
        $response = $this->handler->listForSection(7, 2);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUpdateChangesTextDetailAndPriority(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Original');

        $response = $this->handler->update(7, $taskId, json_encode(['text' => 'Edited', 'detail' => 'more info', 'priority' => 'high']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['text']);
        self::assertSame('more info', $payload['data']['detail']);
        self::assertSame('high', $payload['data']['priority']);
    }

    public function testUpdateRejectsAnInvalidPriority(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Original');

        $response = $this->handler->update(7, $taskId, json_encode(['priority' => 'urgent-ish']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testUpdateRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->update(9, 999, json_encode(['text' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testMoveChangesSectionAndSortOrder(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Movable');

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 3, 'sort_order' => 5]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sectionId']);
        self::assertSame(5, $payload['data']['sortOrder']);
    }

    /**
     * Regression test for whole-branch review finding I1: changing
     * section_id WITHOUT supplying group_id in the same request must clear
     * the task's group_id — the old group has no relationship to the new
     * section, and leaving it in place made BoardApiHandler::get() render
     * the task under the OLD section while listForSection() for the NEW
     * section returned it (the two read paths disagreed).
     */
    public function testMoveToADifferentSectionWithoutGroupIdClearsTheGroup(): void
    {
        $this->createGroupsTable();
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        // Group 10 lives in section 1 -- the task's OLD section.
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (10, 7, 1)');
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Grouped, about to move', null, 10);

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 3]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sectionId']);
        self::assertNull($payload['data']['groupId'], 'a group from the OLD section must not silently survive a move to a new section');
    }

    /**
     * CARRY-OVER BUG FIX (D1b Task 6): $sectionChanging used to be set from
     * `array_key_exists('section_id', $decoded)` alone -- SUPPLIED, not
     * CHANGED. A reorder that echoes the task's CURRENT section_id (exactly
     * what a drag-and-drop client sends) was silently treated as a section
     * change, which cleared group_id via the sibling `elseif` branch and
     * un-grouped an already-grouped task.
     */
    public function testMoveKeepsTheGroupWhenSectionIdIsEchoedUnchanged(): void
    {
        $this->createGroupsTable();
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (1, 7, 1)');
        // Pre-grouped in section 1, group 1 -- built directly rather than via
        // create() + a first move() call (create() needs Postgres for its
        // own OU-aware section check; see this class's own docblock), since
        // the point of THIS test is the second move() call below.
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Grouped', null, 1);

        // A reorder that echoes the CURRENT section must not un-group.
        $payload = json_decode($this->handler->move(7, $taskId, json_encode(['section_id' => 1, 'sort_order' => 5]))->getBody(), true);

        self::assertSame(1, $payload['data']['groupId'], 'echoing the current section_id must not clear group_id');
        self::assertSame(5, $payload['data']['sortOrder']);
    }

    public function testMoveRejectsASectionFromADifferentProject(): void
    {
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id) VALUES (200, 7)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (4, 7, 200)");
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Movable');

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 4]));

        self::assertSame(422, $response->getStatusCode());
    }

    /**
     * Fixture for `tasker_groups`, minus the FK/UNIQUE clauses the SQLite
     * double doesn't need — only the columns move()'s group-validation query
     * selects/filters on are required.
     */
    private function createGroupsTable(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_groups (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, section_id INTEGER NOT NULL)');
    }

    public function testMoveAcceptsAGroupIdFromTheSameSection(): void
    {
        $this->createGroupsTable();
        // Group 10 lives in section 1, which is the task's own (unchanged) section.
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (10, 7, 1)');
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Groupable');

        $response = $this->handler->move(7, $taskId, json_encode(['group_id' => 10]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(10, $payload['data']['groupId']);
    }

    /**
     * Regression test for whole-branch review finding I1: a group_id
     * explicitly supplied in the SAME request as a section_id change must be
     * validated against the TARGET (new) section, not the task's old one.
     */
    public function testMoveAcceptsAGroupIdFromTheNewSectionInTheSameRequest(): void
    {
        $this->createGroupsTable();
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        // Group 30 lives in section 3 -- the NEW target section, not the task's current one (1).
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (30, 7, 3)');
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Moving with its new group');

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 3, 'group_id' => 30]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sectionId']);
        self::assertSame(30, $payload['data']['groupId']);
    }

    /**
     * Mirrors testMoveRejectsASectionFromADifferentProject(), but for
     * group_id: a group_id belonging to a DIFFERENT section than the
     * request's target section_id must be rejected (422), even when that
     * section belongs to the same project.
     */
    public function testMoveRejectsAGroupIdFromADifferentSectionThanTheTarget(): void
    {
        $this->createGroupsTable();
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        // Group 20 lives in section 3, but the request's target section stays 1 (unchanged).
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (20, 7, 3)');
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Movable');

        $response = $this->handler->move(7, $taskId, json_encode(['group_id' => 20]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testDeleteRemovesTheTask(): void
    {
        // delete() now also calls EntityTagRepository::detachAll() (D1b
        // Task 6's carry-over fix), which issues a DELETE against
        // entity_tags unconditionally — that table must exist even when
        // this particular task was never tagged.
        $this->createEntityTagsTable();
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Doomed');

        $response = $this->handler->delete(7, $taskId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_tasks')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->delete(9, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * CARRY-OVER FIX (D1b Task 6): deleting a tagged task used to orphan its
     * entity_tags rows (entity_tags carries no FK to tasker_tasks). Now
     * cleaned up via core's EntityTagRepository::detachAll().
     */
    public function testDeleteRemovesTheTasksEntityTagRows(): void
    {
        $this->pdo->exec('
            CREATE TABLE entity_tags (
                tenant_id INTEGER NOT NULL, entity_type VARCHAR(128) NOT NULL, entity_id BIGINT NOT NULL,
                tag_id BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                PRIMARY KEY (entity_type, entity_id, tag_id)
            )
        ');
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Tagged then deleted');
        $this->pdo->exec("INSERT INTO entity_tags (tenant_id, entity_type, entity_id, tag_id) VALUES (7, 'tasker_task', {$taskId}, 11)");

        $this->handler->delete(7, $taskId);

        $orphans = (int) $this->pdo->query("SELECT COUNT(*) FROM entity_tags WHERE entity_type = 'tasker_task' AND entity_id = {$taskId}")->fetchColumn();
        self::assertSame(0, $orphans);
    }

    public function testUncompleteRestoresPendingStatusAndClearsCompletedAt(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Flip-flop');
        $this->handler->complete(7, $taskId);

        $response = $this->handler->uncomplete(7, $taskId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertNull($payload['data']['completedAt']);
    }

    public function testPinAndUnpinToggleThePinnedFlag(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Pin me');

        $pinned = json_decode($this->handler->pin(7, $taskId)->getBody(), true);
        self::assertTrue($pinned['data']['pinned']);

        $unpinned = json_decode($this->handler->unpin(7, $taskId)->getBody(), true);
        self::assertFalse($unpinned['data']['pinned']);
    }

    /**
     * Regression test for a Critical review finding: `toPublicTask()` used
     * to read `pinned` via a naive `(bool) $row['pinned']` cast. Real
     * pdo_pgsql can return a boolean column as the STRING "f" for false —
     * and PHP's `(bool) 'f'` is `true`, since any non-empty string is
     * truthy — which would report EVERY unpinned task as pinned over the
     * real API. SQLite's own in-memory double genuinely stores 0/1 (int),
     * so it never reproduces this on its own; this test forces the exact
     * Postgres-shaped value onto the column via a raw UPDATE (SQLite has no
     * real column-type enforcement, so it happily stores the literal
     * string "f"), then reads it back through the same `listForSection()` →
     * `toPublicTask()` path production traffic uses, proving the fix
     * ({@see \Tasker\Api\TasksApiHandler::dbTruthy()}) — not SQLite's
     * happen-to-be-int storage — is what makes this correct.
     */
    public function testPinnedCoercesAPostgresStyleFalseStringToBooleanFalse(): void
    {
        $taskId = $this->insertTaskDirect(7, 100, 1, 'String-bool row');

        // rowid is safe to hardcode as $taskId here: this test's own PDO is
        // always the in-memory SQLite double (see setUp()), never Postgres.
        $this->pdo->exec("UPDATE tasker_tasks SET pinned = 'f' WHERE rowid = {$taskId}");

        $payload = json_decode($this->handler->listForSection(7, 1)->getBody(), true);

        self::assertFalse(
            $payload['data'][0]['pinned'],
            'a naive (bool) cast on the string "f" (pdo_pgsql\'s real false representation) evaluates to true'
        );
    }

    public function testTagAttachesAnExistingTagToATask(): void
    {
        $this->createEntityTagsTable();
        $this->createTagsTable();
        $this->insertTag(11, 7);
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Taggable');

        $response = $this->handler->tag(7, $taskId, json_encode(['tag_id' => 11]));

        self::assertSame(201, $response->getStatusCode());
    }

    public function testTagIsIdempotentOnAlreadyAttachedTag(): void
    {
        $this->createEntityTagsTable();
        $this->createTagsTable();
        $this->insertTag(11, 7);
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Taggable');

        $first = $this->handler->tag(7, $taskId, json_encode(['tag_id' => 11]));
        $second = $this->handler->tag(7, $taskId, json_encode(['tag_id' => 11]));

        self::assertSame(201, $first->getStatusCode());
        self::assertSame(200, $second->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM entity_tags')->fetchColumn();
        self::assertSame(1, $count);
    }

    public function testTagRejectsATaskOutsideTheCallersTenant(): void
    {
        $this->createEntityTagsTable();

        $response = $this->handler->tag(9, 999, json_encode(['tag_id' => 11]));

        self::assertSame(404, $response->getStatusCode());
    }

    /**
     * Mirrors Task 1's PingApiHandlerTest::testTagRejectsATagBelongingToADifferentTenant():
     * a caller must never be able to attach a tag_id that exists but belongs
     * to a DIFFERENT tenant — the tag-ownership check must reject this BEFORE
     * any attempt to write the association. No entity_tags table is created
     * here deliberately: if the ownership check didn't reject first, the
     * INSERT would throw on the missing table and surface as a 500, not
     * silently pass this test as a 422.
     */
    public function testTagRejectsATagBelongingToADifferentTenant(): void
    {
        $this->createTagsTable();
        $this->insertTag(11, 9);
        $taskId = $this->insertTaskDirect(7, 100, 1, 'Taggable');

        $response = $this->handler->tag(7, $taskId, json_encode(['tag_id' => 11]));

        self::assertSame(422, $response->getStatusCode());
    }
}
