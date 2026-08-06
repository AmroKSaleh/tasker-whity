<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SectionsApiHandler;
use Tasker\Migrations\CreateTaskerSectionsTable;

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

    public function testCreateAddsASecondSectionToTheProject(): void
    {
        $response = $this->handler->create(7, 100, json_encode(['name' => 'In Progress']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('In Progress', $payload['data']['name']);
        self::assertSame('in-progress', $payload['data']['slug']);
    }

    public function testCreateRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 200, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListReturnsSectionsForTheGivenProjectAndTenant(): void
    {
        $payload = json_decode($this->handler->list(7, 100)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('Backlog', $payload['data'][0]['name']);
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
        $created = json_decode($this->handler->create(7, 100, json_encode(['name' => 'Extra section']))->getBody(), true);
        $extraId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $extraId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count);
    }
}
