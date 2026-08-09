<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\GroupsApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;

/**
 * NOTE ON WHAT MOVED (whole-branch review finding C1): list()/create() used
 * to check only tenant ownership of the parent section; they are now
 * OU-aware, joining tasker_sections to tasker_projects and calling
 * OuScopeResolver::whereFragment() UNCONDITIONALLY — PostgreSQL's
 * `= ANY(:scope)`, which SQLite's PDO::prepare() rejects outright regardless
 * of runtime branching. Every test that exercised list()/create() moved to
 * TenantIsolationOuTest.php (Postgres-backed), alongside new OU-boundary
 * regression tests proving the fix. update()/delete() are UNCHANGED by C1
 * (they take the GROUP's own id directly, not a section id path parameter —
 * explicitly out of C1's scope) and keep their SQLite coverage here; their
 * fixtures now use a raw INSERT instead of handler->create() so they don't
 * need to move too.
 */
final class GroupsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private GroupsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_sections (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id) VALUES (1, 7), (2, 9)");
        (new CreateTaskerGroupsTable())->up($this->pdo);

        $this->handler = new GroupsApiHandler($this->pdo);
    }

    /**
     * Inserts a group directly (bypassing handler->create(), which now
     * requires a real Postgres connection — see this class's own docblock)
     * and returns the id a subsequent handler->update()/delete() call must
     * use: SQLite's own `rowid`, not the `id` column value (see
     * GroupsApiHandler::idColumn()'s own doc for why those diverge under the
     * in-memory SQLite double).
     */
    private function insertGroup(int $tenantId, int $sectionId, string $name): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_groups (public_id, tenant_id, section_id, name, slug, created_at)
             VALUES (:public_id, :tenant_id, :section_id, :name, :slug, CURRENT_TIMESTAMP)'
        );
        $stmt->execute([
            ':public_id' => sprintf('cccccccc-0000-0000-0000-%012d', random_int(1, 999999999999)),
            ':tenant_id' => $tenantId,
            ':section_id' => $sectionId,
            ':name' => $name,
            ':slug' => strtolower(str_replace(' ', '-', $name)),
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    public function testUpdateChangesNameAndSortOrder(): void
    {
        $groupId = $this->insertGroup(7, 1, 'Original');

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Renamed', 'sort_order' => 3]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame(3, $payload['data']['sortOrder']);
    }

    public function testUpdateRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $groupId = $this->insertGroup(9, 2, 'Other tenant group');

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheGroup(): void
    {
        $groupId = $this->insertGroup(7, 1, 'Doomed');

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_groups')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $groupId = $this->insertGroup(9, 2, 'Other tenant group');

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(404, $response->getStatusCode());
    }
}
