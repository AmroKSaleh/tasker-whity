<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SectionsApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;

/**
 * NOTE ON WHAT MOVED (whole-branch review finding C1): list()/create() used
 * to be tenant-scoped only; they are now OU-aware, joining to tasker_projects
 * and calling OuScopeResolver::whereFragment() UNCONDITIONALLY — which uses
 * PostgreSQL's `= ANY(:scope)`, syntax SQLite's PDO::prepare() rejects
 * outright regardless of which branch would be live at runtime. Every test
 * that exercised list()/create() (testCreateAddsASecondSectionToTheProject,
 * testCreateRejects404ForAProjectOutsideTheCallersTenant,
 * testListReturnsSectionsForTheGivenProjectAndTenant) therefore moved to
 * TenantIsolationOuTest.php (Postgres-backed), alongside new OU-boundary
 * regression tests proving the fix. update()/delete() are UNCHANGED by C1
 * (they take the section's own id directly, not a project id path
 * parameter — explicitly out of C1's scope) and keep their SQLite coverage
 * here; testDeleteRemovesANonLastSection's fixture now uses a raw INSERT
 * instead of handler->create() so it doesn't need to move too.
 */
final class SectionsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private SectionsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_projects (id, tenant_id) VALUES (100, 7), (200, 9)');
        (new CreateTaskerSectionsTable())->up($this->pdo);
        // The project's default Backlog section, mirroring what ProjectsApiHandler::create() would have made.
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug, created_at)
            VALUES (1, 'aaaaaaaa-0000-0000-0000-000000000001', 7, 100, 'Backlog', 'backlog', CURRENT_TIMESTAMP)");

        // D1b Task 12b: delete()'s new delete_tasks gate counts rows in both
        // of these before allowing a non-empty section to be removed. Real
        // migrations (not hand-rolled minimal tables), same convention
        // TasksApiHandlerTest/GroupsApiHandlerTest already use to get the
        // real tasker_tasks/tasker_groups shape under SQLite.
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);

        $this->handler = new SectionsApiHandler($this->pdo);
    }

    /**
     * Inserts a section directly (bypassing handler->create(), which now
     * requires a real Postgres connection — see this class's own docblock)
     * and returns the id that a subsequent handler->update()/delete() call
     * must use: SQLite's own `rowid`, NOT the `id` column value bound above
     * (see SectionsApiHandler::idColumn()'s own doc for why those two
     * diverge under the in-memory SQLite double).
     */
    private function insertSection(int $tenantId, int $projectId, string $name): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (:public_id, :tenant_id, :project_id, :name, :slug, CURRENT_TIMESTAMP)"
        );
        $stmt->execute([
            ':public_id' => sprintf('bbbbbbbb-0000-0000-0000-%012d', random_int(1, 999999999999)),
            ':tenant_id' => $tenantId,
            ':project_id' => $projectId,
            ':name' => $name,
            ':slug' => strtolower(str_replace(' ', '-', $name)),
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    /**
     * Fixture for the delete_tasks gate below — note this deliberately does
     * NOT rely on the real ON DELETE CASCADE FK (tasker_tasks.section_id ->
     * tasker_sections.id): SQLite does not enforce FK actions by default, and
     * — separately — a section inserted without an explicit `id` (as
     * insertSection() above does) gets a real, permanent NULL in its `id`
     * column while lastInsertId() reports SQLite's own rowid instead (see
     * SectionsApiHandler::idColumn()'s own docblock), so a REFERENCES
     * tasker_sections(id) constraint could never structurally match these
     * fixtures' section rows anyway. The counting logic under test here
     * (countIn()) filters by section_id directly and has no such dependency.
     * Real cascade-on-delete is proven end-to-end against Postgres instead
     * (TenantIsolationOuTest::testDeleteSectionRefusesANonEmptySectionUnlessDeleteTasksIsTrue()).
     */
    private function insertTaskInSection(int $tenantId, int $projectId, int $sectionId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_tasks (public_id, tenant_id, project_id, section_id, text, created_by, created_at, updated_at)
             VALUES (:public_id, :tenant_id, :project_id, :section_id, :text, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
        );
        $stmt->execute([
            ':public_id' => sprintf('cccccccc-0000-0000-0000-%012d', random_int(1, 999999999999)),
            ':tenant_id' => $tenantId,
            ':project_id' => $projectId,
            ':section_id' => $sectionId,
            ':text' => 'Fixture task',
        ]);
    }

    private function insertGroupInSection(int $tenantId, int $sectionId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_groups (public_id, tenant_id, section_id, name, slug, created_at)
             VALUES (:public_id, :tenant_id, :section_id, :name, :slug, CURRENT_TIMESTAMP)'
        );
        $stmt->execute([
            ':public_id' => sprintf('dddddddd-0000-0000-0000-%012d', random_int(1, 999999999999)),
            ':tenant_id' => $tenantId,
            ':section_id' => $sectionId,
            ':name' => 'Fixture group',
            ':slug' => 'fixture-group',
        ]);
    }

    public function testUpdateChangesNameAndDescription(): void
    {
        $response = $this->handler->update(7, 1, json_encode(['name' => 'Renamed', 'description' => 'New subtitle']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame('New subtitle', $payload['data']['description']);
    }

    public function testUpdateRejects404ForASectionOutsideTheCallersTenant(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug, created_at)
            VALUES (2, 'aaaaaaaa-0000-0000-0000-000000000002', 9, 200, 'Other tenant section', 'other', CURRENT_TIMESTAMP)");

        $response = $this->handler->update(7, 2, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRejectsTheProjectsLastRemainingSection(): void
    {
        $response = $this->handler->delete(7, 1);

        self::assertSame(409, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count);
    }

    public function testDeleteRemovesANonLastSection(): void
    {
        $extraId = $this->insertSection(7, 100, 'Extra section');

        $response = $this->handler->delete(7, $extraId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count);
    }

    /**
     * D1b Task 12b (contract parity, unsafe-direction fix): delete() used to
     * cascade unconditionally, so this same call — a REFUSAL against the
     * original app — silently destroyed every task in the section here.
     * Asserts the survival case by COUNTING rows afterwards, not just
     * reading the status code, per the brief's own instruction: a 409 that
     * still let the DELETE run underneath it would pass a status-code-only
     * assertion and still be the exact bug this fix closes.
     */
    public function testDeleteRefusesANonEmptySectionAndTheTasksSurvive(): void
    {
        $extraId = $this->insertSection(7, 100, 'Has tasks');
        $this->insertTaskInSection(7, 100, $extraId);
        $this->insertTaskInSection(7, 100, $extraId);
        $this->insertGroupInSection(7, $extraId);

        $response = $this->handler->delete(7, $extraId);

        self::assertSame(409, $response->getStatusCode());
        $body = json_decode($response->getBody(), true);
        self::assertStringContainsString('2', $body['error'], 'the refusal message must report how many tasks would be destroyed');
        self::assertStringContainsString('1', $body['error'], 'the refusal message must report how many groups would be destroyed');
        self::assertStringContainsString('delete_tasks', $body['error']);

        self::assertSame(2, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_tasks WHERE section_id = {$extraId}")->fetchColumn());
        self::assertSame(1, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_groups WHERE section_id = {$extraId}")->fetchColumn());
        self::assertSame(2, (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn(), 'the section itself must also survive a refused delete');
    }

    public function testDeleteWithDeleteTasksTrueProceedsPastTheGuardForANonEmptySection(): void
    {
        $extraId = $this->insertSection(7, 100, 'Has tasks');
        $this->insertTaskInSection(7, 100, $extraId);
        $this->insertGroupInSection(7, $extraId);

        $response = $this->handler->delete(7, $extraId, true);

        self::assertSame(204, $response->getStatusCode());
        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count, 'the section itself must be gone once delete_tasks bypasses the guard');
    }

    public function testDeleteAnAlreadyEmptySectionSucceedsWithoutTheFlag(): void
    {
        $extraId = $this->insertSection(7, 100, 'Empty section');

        $response = $this->handler->delete(7, $extraId);

        self::assertSame(204, $response->getStatusCode());
    }
}
