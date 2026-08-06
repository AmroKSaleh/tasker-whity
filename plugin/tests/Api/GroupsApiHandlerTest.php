<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\GroupsApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;

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

    public function testCreateStampsTheCallersTenantAndTheGivenSection(): void
    {
        $response = $this->handler->create(7, 1, json_encode(['name' => 'Backend']));

        self::assertSame(201, $response->getStatusCode());

        $row = $this->pdo->query('SELECT tenant_id, section_id, name, slug FROM tasker_groups')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame(1, (int) $row['section_id']);
        self::assertSame('Backend', $row['name']);
        self::assertSame('backend', $row['slug']);
    }

    public function testCreateRejectsASectionOutsideTheCallersTenant(): void
    {
        // Section 2 belongs to tenant 9, not the caller's tenant 7.
        $response = $this->handler->create(7, 2, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListReturnsOnlyGroupsForTheGivenSectionAndTenant(): void
    {
        $this->handler->create(7, 1, json_encode(['name' => 'A']));
        $this->handler->create(9, 2, json_encode(['name' => 'B']));

        $payload = json_decode($this->handler->list(7, 1)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['name']);
    }

    public function testUpdateChangesNameAndSortOrder(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['name' => 'Original']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Renamed', 'sort_order' => 3]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame(3, $payload['data']['sortOrder']);
    }

    public function testUpdateRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['name' => 'Other tenant group']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheGroup(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['name' => 'Doomed']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_groups')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['name' => 'Other tenant group']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(404, $response->getStatusCode());
    }
}
