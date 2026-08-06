<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\Tests\Support\SqlitePolyfills;

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

    public function testCreateStampsTenantAndDefaultsStatusToPending(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Ship it']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertSame('Ship it', $payload['data']['text']);
        self::assertNull($payload['data']['priority']);
    }

    public function testCreateRejectsASectionOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 2, 3, json_encode(['text' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testCreateAcceptsAValidPriority(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Urgent', 'priority' => 'rush']));

        $payload = json_decode($response->getBody(), true);
        self::assertSame('rush', $payload['data']['priority']);
    }

    public function testCreateRejectsAnInvalidPriority(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Bad', 'priority' => 'urgent-ish']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCompleteSetsStatusAndCompletedAt(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Finish me']))->getBody(), true);

        $response = $this->handler->complete(7, (int) $created['data']['id']);

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
        $this->handler->create(7, 1, 3, json_encode(['text' => 'A']));

        $payload = json_decode($this->handler->listForSection(7, 1)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['text']);
    }

    public function testUpdateChangesTextDetailAndPriority(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Original']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $taskId, json_encode(['text' => 'Edited', 'detail' => 'more info', 'priority' => 'high']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['text']);
        self::assertSame('more info', $payload['data']['detail']);
        self::assertSame('high', $payload['data']['priority']);
    }

    public function testUpdateRejectsAnInvalidPriority(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Original']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

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
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Movable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 3, 'sort_order' => 5]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sectionId']);
        self::assertSame(5, $payload['data']['sortOrder']);
    }

    public function testMoveRejectsASectionFromADifferentProject(): void
    {
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id) VALUES (200, 7)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (4, 7, 200)");
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Movable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 4]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testDeleteRemovesTheTask(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Doomed']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

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

    public function testUncompleteRestoresPendingStatusAndClearsCompletedAt(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Flip-flop']))->getBody(), true);
        $taskId = (int) $created['data']['id'];
        $this->handler->complete(7, $taskId);

        $response = $this->handler->uncomplete(7, $taskId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertNull($payload['data']['completedAt']);
    }

    public function testPinAndUnpinToggleThePinnedFlag(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Pin me']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $pinned = json_decode($this->handler->pin(7, $taskId)->getBody(), true);
        self::assertTrue($pinned['data']['pinned']);

        $unpinned = json_decode($this->handler->unpin(7, $taskId)->getBody(), true);
        self::assertFalse($unpinned['data']['pinned']);
    }

    public function testTagAttachesAnExistingTagToATask(): void
    {
        $this->createEntityTagsTable();
        $this->createTagsTable();
        $this->insertTag(11, 7);

        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Taggable']))->getBody(), true);
        $response = $this->handler->tag(7, (int) $created['data']['id'], json_encode(['tag_id' => 11]));

        self::assertSame(201, $response->getStatusCode());
    }

    public function testTagIsIdempotentOnAlreadyAttachedTag(): void
    {
        $this->createEntityTagsTable();
        $this->createTagsTable();
        $this->insertTag(11, 7);

        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Taggable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

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

        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Taggable']))->getBody(), true);
        $response = $this->handler->tag(7, (int) $created['data']['id'], json_encode(['tag_id' => 11]));

        self::assertSame(422, $response->getStatusCode());
    }
}
