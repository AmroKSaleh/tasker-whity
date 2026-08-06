<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;

/**
 * Proves the four OU-descendant visibility cases against a REAL PostgreSQL
 * connection — required because OuScopeResolver::whereFragment() uses
 * PostgreSQL's `= ANY(array)`, which SQLite does not support. Run against the
 * host's own tasker_test database (created fresh per run) rather than the
 * conformance kit's in-memory SQLite double.
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
}
