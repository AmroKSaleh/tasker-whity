<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Migrations\CreateTaskerMilestonesTable;

/**
 * NOTE ON WHAT MOVED (whole-branch review finding C1): create()'s
 * task-existence check used to be tenant-scoped only; it is now OU-aware,
 * joining tasker_tasks to tasker_projects and calling
 * OuScopeResolver::whereFragment() UNCONDITIONALLY — PostgreSQL's
 * `= ANY(:scope)`, which SQLite's PDO::prepare() rejects outright regardless
 * of runtime branching. The two tests that exercised create() directly
 * (testCreateDefaultsCheckedToFalse, testCreateRejectsATaskOutsideTheCallersTenant)
 * moved to TenantIsolationOuTest.php (Postgres-backed), alongside new
 * OU-boundary regression tests proving the fix. Every OTHER test below only
 * ever used create() as a convenience fixture-builder for some other method
 * under test (toggle/update/delete/listForTask) — those now build their
 * milestone fixture via insertMilestoneDirect() (a raw INSERT bypassing
 * create() entirely) so they stay on SQLite unchanged in every other
 * respect. listForTask() itself remains tenant-scoped only (finding I7) and
 * has no Postgres-only syntax, so it keeps its SQLite coverage as-is.
 */
final class MilestonesApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private MilestonesApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id) VALUES (1, 7), (2, 9)');
        (new CreateTaskerMilestonesTable())->up($this->pdo);

        $this->handler = new MilestonesApiHandler($this->pdo);
    }

    /**
     * Inserts a milestone directly (bypassing handler->create(), which now
     * requires a real Postgres connection for its task-existence check — see
     * this class's own docblock) and returns the id a subsequent
     * handler->update()/delete()/toggle() call must use: SQLite's own
     * `rowid`, not the `id` column value (see
     * MilestonesApiHandler::idColumn()'s own doc for why those diverge under
     * the in-memory SQLite double).
     */
    private function insertMilestoneDirect(int $tenantId, int $taskId, string $summary, int $sortOrder = 0): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_milestones (public_id, tenant_id, task_id, summary, sort_order, created_at)
             VALUES (:public_id, :tenant_id, :task_id, :summary, :sort_order, CURRENT_TIMESTAMP)'
        );
        $stmt->execute([
            ':public_id' => sprintf('eeeeeeee-0000-0000-0000-%012d', random_int(1, 999999999999)),
            ':tenant_id' => $tenantId,
            ':task_id' => $taskId,
            ':summary' => $summary,
            ':sort_order' => $sortOrder,
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    public function testToggleFlipsCheckedState(): void
    {
        $id = $this->insertMilestoneDirect(7, 1, 'Toggle me');

        $first = json_decode($this->handler->toggle(7, $id)->getBody(), true);
        $second = json_decode($this->handler->toggle(7, $id)->getBody(), true);

        self::assertTrue($first['data']['checked']);
        self::assertFalse($second['data']['checked']);
    }

    public function testToggleRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $id = $this->insertMilestoneDirect(9, 2, 'Other tenant');

        $response = $this->handler->toggle(7, $id);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForTaskOrdersBySortOrder(): void
    {
        $this->insertMilestoneDirect(7, 1, 'Second', 2);
        $this->insertMilestoneDirect(7, 1, 'First', 1);

        $payload = json_decode($this->handler->listForTask(7, 1)->getBody(), true);

        self::assertSame('First', $payload['data'][0]['summary']);
        self::assertSame('Second', $payload['data'][1]['summary']);
    }

    /**
     * Regression test for whole-branch review finding I7: listForTask() used
     * to have NO existence check on its parent {taskId} at all — a
     * nonexistent or cross-tenant task returned `200 []` instead of 404.
     */
    public function testListForTaskRejects404ForANonexistentTask(): void
    {
        $response = $this->handler->listForTask(7, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForTaskRejects404ForATaskOutsideTheCallersTenant(): void
    {
        // Task 2 belongs to tenant 9, not the caller's tenant 7.
        $response = $this->handler->listForTask(7, 2);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUpdateChangesSummaryAndDetail(): void
    {
        $id = $this->insertMilestoneDirect(7, 1, 'Original');

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Edited', 'detail' => 'more info']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['summary']);
        self::assertSame('more info', $payload['data']['detail']);
    }

    public function testUpdateRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $id = $this->insertMilestoneDirect(9, 2, 'Other tenant');

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheMilestone(): void
    {
        $id = $this->insertMilestoneDirect(7, 1, 'Doomed');

        $response = $this->handler->delete(7, $id);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_milestones')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $id = $this->insertMilestoneDirect(9, 2, 'Other tenant');

        $response = $this->handler->delete(7, $id);

        self::assertSame(404, $response->getStatusCode());
    }
}
