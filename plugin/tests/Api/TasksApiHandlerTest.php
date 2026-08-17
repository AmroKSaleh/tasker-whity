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
 * for some other method under test (update/delete/complete/pin/tag/
 * listForSection) — those build their task fixture via insertTaskDirect() (a
 * raw INSERT bypassing create() entirely) so they stay on SQLite unchanged in
 * every other respect. listForSection() itself remains tenant-scoped only
 * (finding I7) and has no Postgres-only syntax, so it keeps its SQLite
 * coverage as-is — and so does its D1b Task 6 successor, listFiltered(),
 * whose own fixtures (below) are built the same insertTaskDirect() way for
 * the same reason.
 *
 * NO SQLite COVERAGE FOR getOne() (D1b Task 8, get_task): the brief for that
 * task sketched a shape/milestones test and a cross-tenant 404 test living in
 * THIS file. getOne() is OU-aware (see its own docblock in TasksApiHandler),
 * which — like create() above — means it calls OuScopeResolver::whereFragment()
 * unconditionally, embedding PostgreSQL's `= ANY(:scope)` in the SQL TEXT
 * regardless of whether the caller's OU is null. Unlike create(), where the
 * OU check is a SEPARATE query from the tenant-scoped SELECT/INSERT (so only
 * the OU-boundary tests needed to move to Postgres), getOne()'s OU-aware join
 * IS the query that fetches the row — there is no tenant-scoped-only variant
 * left to exercise here. Confirmed empirically: this file's own setUp() does
 * not even give tasker_projects an ou_id column. All of getOne()'s coverage
 * — shape, milestones ordering, cross-tenant 404, AND the sibling-OU 404 the
 * brief itself did not ask for but the boundary requires — lives in
 * TenantIsolationOuTest.php instead. See that file's own "TasksApiHandler::
 * getOne()" section for the full reasoning and a survey of every other
 * whereFragment() call site in this codebase confirming none has SQLite
 * coverage either, including calls made with a null caller OU.
 *
 * NO SQLite COVERAGE FOR moveToGroup() EITHER (D1b Task 9, move_task_to_group):
 * the brief for that task sketched this method as tenant-scoped only
 * (`moveToGroup(int $tenantId, int $taskId, ?int $groupId, ?int $sectionId)`),
 * which would have belonged in THIS file, matching this class's other
 * single-task-id mutations. D1b Task 9's own resolution #2 made it OU-aware
 * instead — for the identical BIGSERIAL-guessing reason that made getOne()
 * OU-aware in D1b Task 8, only stronger here because moveToGroup() is a
 * MUTATION, not a read. It calls {@see \Tasker\Api\TasksApiHandler::findVisible()}
 * for its own pre-check, the same OU-aware, PostgreSQL-only join getOne()
 * uses, so every one of its outcomes — the plain group-set/un-group cases,
 * the cross-section/cross-project 422s, the sort_order reorder (D1b Task
 * 12c), the cross-tenant 404, and the sibling-OU 404 the OU-aware shape
 * specifically requires — lives in TenantIsolationOuTest.php's own
 * "TasksApiHandler::moveToGroup()" section, never here.
 *
 * NO SQLite COVERAGE FOR moveToProject() EITHER (D1b Task 12c, move_task,
 * ported to its actual cross-project contract): OU-aware for the same
 * belt-and-braces reason as moveToGroup() (see its own docblock in
 * TasksApiHandler) — it re-derives and checks OU visibility on BOTH the task
 * AND the target project via findVisible()/isProjectVisible(), the same
 * OU-aware, PostgreSQL-only joins getOne()/readyWork() use. This class's own
 * former move() method (within-project section/group/sort_order — the SQLite
 * tests it used to have lived right here) was RETIRED outright in the same
 * task, its capability now covered by moveToGroup(); see git history for
 * both the method and its dedicated SQLite tests. Every one of
 * moveToProject()'s outcomes — short id reassignment into the target's own
 * sequence, field preservation, group clearing, the Backlog-fallback
 * leniency for an omitted/foreign target_section_id, atomicity under a
 * forced write failure, and the sibling-OU 404s — lives in
 * TenantIsolationOuTest.php's own "TasksApiHandler::moveToProject()"
 * section, never here.
 *
 * NO SQLite COVERAGE FOR update()/delete()/complete()/uncomplete()/pin()/
 * unpin()/tag() EITHER, AS OF D1b Task 13: these used to be tenant-scoped
 * only, on the theory that a caller only ever reaches a task id through an
 * OU-scoped list first (see this class's own docblock in TasksApiHandler for
 * the fuller reasoning and why it did not hold). All seven now call
 * findVisible() — the SAME OU-aware, PostgreSQL-only join getOne()/
 * moveToGroup()/moveToProject() already use — either as their existing
 * front-door check (update()/delete()/tag()) or as a new pre-check added
 * before the write (complete()/uncomplete()/pin()/unpin(), which used to
 * write first and infer 404 from rowCount() === 0). Every test that
 * exercised these seven methods directly (testCompleteSetsStatusAndCompletedAt,
 * testCompleteRejectsATaskOutsideTheCallersTenant, testUpdateChangesTextDetailAndPriority,
 * testUpdateRejectsAnInvalidPriority, testUpdateAcceptsEachValidStatus,
 * testUpdateRejectsAnInvalidStatus, testUpdateToDoneStampsCompletedAt,
 * testUpdateAwayFromDoneClearsCompletedAt, testUpdateWithoutAStatusFieldLeavesCompletedAtUntouched,
 * testUpdateRejects404ForATaskOutsideTheCallersTenant, testDeleteRemovesTheTask,
 * testDeleteRejects404ForATaskOutsideTheCallersTenant, testDeleteRemovesTheTasksEntityTagRows,
 * testUncompleteRestoresPendingStatusAndClearsCompletedAt, testPinAndUnpinToggleThePinnedFlag,
 * testTagAttachesAnExistingTagToATask, testTagIsIdempotentOnAlreadyAttachedTag,
 * testTagRejectsATaskOutsideTheCallersTenant, testTagRejectsATagBelongingToADifferentTenant)
 * moved to TenantIsolationOuTest.php, alongside new sibling-OU boundary
 * tests (negative and positive control) neither predecessor covered.
 * testPinnedCoercesAPostgresStyleFalseStringToBooleanFalse() stays here
 * unchanged — it exercises listForSection() (unaffected by this fix), never
 * pin()/unpin() themselves, despite its name.
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
        // D5a Task 11 (TDE-320): production's tasker_tasks carries flow_id via
        // AddTaskerTaskFlowAndContractColumns, and listFiltered()/listForSection()
        // now read it (`flow_id IS NULL` — a flowed task is a flow step, not
        // loose board work). That migration cannot be run against this double:
        // its statements are `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and
        // SQLite has no IF NOT EXISTS form of ADD COLUMN at all — so the column
        // is replicated here by hand instead, the same way tasker_projects and
        // tasker_sections above are hand-rolled minimal doubles rather than real
        // migrations. Without it every listFiltered() call raised "no such
        // column: flow_id", which this handler's own catch-all turns into a 500
        // — five tests in this file failed on a null `data` key, with nothing
        // naming the missing column.
        //
        // flow_id ONLY: the same migration also adds flow_step/output_contract/
        // output_contract_blessed, and no SQLite-tier query reads any of them.
        // Add them here the day one does.
        $this->pdo->exec('ALTER TABLE tasker_tasks ADD COLUMN flow_id INTEGER');

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

    /**
     * WHOLE-BRANCH REVIEW consistency fix: this test's name claims tenant
     * scoping, but its body used to insert only ONE task in the whole
     * fixture — nothing else shared section_id 1, so listFiltered()'s own
     * `tenant_id = :tenant_id` predicate could be deleted from the query
     * entirely and this test would still pass (confirmed empirically before
     * this fix: with that predicate replaced by `1=1`, the count was still
     * 1). Fixed the way this codebase proves tenant isolation elsewhere: a
     * second task sharing the EXACT SAME section_id but a DIFFERENT
     * tenant_id, inserted directly (bypassing the handler, which cannot
     * itself produce this state) is the one fixture shape that only the
     * tenant_id predicate — not the section_id predicate, which alone
     * would also exclude a task in some OTHER section — can be responsible
     * for excluding.
     */
    public function testListForSectionReturnsOnlyThatSectionsTasksForTheCallersTenant(): void
    {
        $this->insertTaskDirect(7, 100, 1, 'A');
        $this->insertTaskDirect(9, 100, 1, 'Same section, different tenant -- must not leak');

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
}
