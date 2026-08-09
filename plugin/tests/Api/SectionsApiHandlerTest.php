<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SectionsApiHandler;
use Tasker\Migrations\CreateTaskerSectionsTable;

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
}
