<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\BoardApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;

final class BoardApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private BoardApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('
            CREATE TABLE organizational_units (
                id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, parent_id INTEGER NULL
            )
        ');
        (new CreateTaskerProjectsTable())->up($this->pdo);
        (new CreateTaskerSectionsTable())->up($this->pdo);
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);
        (new CreateTaskerMilestonesTable())->up($this->pdo);

        $this->pdo->exec("INSERT INTO tasker_projects (id, public_id, tenant_id, ou_id, name, slug, created_by) VALUES (1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 7, NULL, 'Board Project', 'board-project', 1)");
        $this->pdo->exec("INSERT INTO tasker_projects (id, public_id, tenant_id, ou_id, name, slug, created_by) VALUES (2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 9, NULL, 'Other Tenant', 'other-tenant', 1)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug) VALUES (1, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 7, 1, 'Backlog', 'backlog')");
        $this->pdo->exec("INSERT INTO tasker_groups (id, public_id, tenant_id, section_id, name, slug) VALUES (1, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 7, 1, 'Frontend', 'frontend')");
        $this->pdo->exec("INSERT INTO tasker_tasks (id, public_id, tenant_id, project_id, section_id, group_id, text, status, created_by) VALUES (1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 7, 1, 1, 1, 'Ship it', 'pending', 1)");
        $this->pdo->exec("INSERT INTO tasker_milestones (id, public_id, tenant_id, task_id, summary, checked) VALUES (1, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 7, 1, 'Write code', 0)");

        $this->handler = new BoardApiHandler($this->pdo);
    }

    public function testGetComposesSectionsGroupsTasksAndMilestones(): void
    {
        $payload = json_decode($this->handler->get(7, null, 1)->getBody(), true);

        self::assertSame(1, $payload['data']['project']['id']);
        self::assertCount(1, $payload['data']['sections']);
        self::assertSame('Backlog', $payload['data']['sections'][0]['name']);
        self::assertCount(1, $payload['data']['sections'][0]['groups']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks']);
        self::assertSame('Ship it', $payload['data']['sections'][0]['groups'][0]['tasks'][0]['text']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks'][0]['milestones']);
    }

    public function testGet404sForAProjectOutsideTheCallersTenant(): void
    {
        $response = $this->handler->get(7, null, 2);

        self::assertSame(404, $response->getStatusCode());
    }
}
