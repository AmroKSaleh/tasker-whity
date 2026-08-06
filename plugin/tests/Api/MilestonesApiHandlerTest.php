<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Migrations\CreateTaskerMilestonesTable;

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

    public function testCreateDefaultsCheckedToFalse(): void
    {
        $response = $this->handler->create(7, 1, json_encode(['summary' => 'Write tests']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertFalse($payload['data']['checked']);
    }

    public function testCreateRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 2, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testToggleFlipsCheckedState(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Toggle me']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $first = json_decode($this->handler->toggle(7, $id)->getBody(), true);
        $second = json_decode($this->handler->toggle(7, $id)->getBody(), true);

        self::assertTrue($first['data']['checked']);
        self::assertFalse($second['data']['checked']);
    }

    public function testToggleRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['summary' => 'Other tenant']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->toggle(7, $id);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForTaskOrdersBySortOrder(): void
    {
        $this->handler->create(7, 1, json_encode(['summary' => 'Second', 'sort_order' => 2]));
        $this->handler->create(7, 1, json_encode(['summary' => 'First', 'sort_order' => 1]));

        $payload = json_decode($this->handler->listForTask(7, 1)->getBody(), true);

        self::assertSame('First', $payload['data'][0]['summary']);
        self::assertSame('Second', $payload['data'][1]['summary']);
    }

    public function testUpdateChangesSummaryAndDetail(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Original']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Edited', 'detail' => 'more info']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['summary']);
        self::assertSame('more info', $payload['data']['detail']);
    }

    public function testUpdateRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['summary' => 'Other tenant']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheMilestone(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Doomed']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $id);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_milestones')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['summary' => 'Other tenant']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $id);

        self::assertSame(404, $response->getStatusCode());
    }
}
