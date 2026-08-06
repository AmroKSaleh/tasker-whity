<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;

final class TaskDiscussionsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private TaskDiscussionsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id) VALUES (1, 7), (2, 9)');
        (new CreateTaskerTaskDiscussionsTable())->up($this->pdo);

        $this->handler = new TaskDiscussionsApiHandler($this->pdo);
    }

    public function testGetOnATaskWithNoDiscussionYetReturnsAnEmptyShape(): void
    {
        $payload = json_decode($this->handler->get(7, 1)->getBody(), true);

        self::assertSame([], $payload['data']['messages']);
        self::assertNull($payload['data']['reason']);
    }

    public function testGetRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->get(7, 2);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testPutCreatesTheDiscussionRowOnFirstWrite(): void
    {
        $body = json_encode(['messages' => [['role' => 'user', 'content' => 'hi']], 'reason' => 'testing']);

        $response = $this->handler->put(7, 1, $body);

        self::assertSame(200, $response->getStatusCode());

        $row = $this->pdo->query('SELECT task_id, messages, reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(1, (int) $row['task_id']);
        self::assertSame('testing', $row['reason']);
    }

    public function testPutUpdatesAnExistingDiscussionRowRatherThanDuplicating(): void
    {
        $this->handler->put(7, 1, json_encode(['messages' => [], 'reason' => 'first']));
        $this->handler->put(7, 1, json_encode(['messages' => [], 'reason' => 'second']));

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_discussions')->fetchColumn();
        self::assertSame(1, $count);

        $row = $this->pdo->query('SELECT reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame('second', $row['reason']);
    }

    public function testPutRejectsAMalformedOrNonObjectBodyAndDoesNotOverwriteExistingData(): void
    {
        $this->handler->put(7, 1, json_encode([
            'messages' => [['role' => 'user', 'content' => 'keep me']],
            'reason' => 'keep this reason',
        ]));

        $malformed = $this->handler->put(7, 1, 'not valid json at all');
        self::assertSame(400, $malformed->getStatusCode());

        $nonObject = $this->handler->put(7, 1, json_encode([1, 2, 3]));
        self::assertSame(400, $nonObject->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_discussions')->fetchColumn();
        self::assertSame(1, $count);

        $row = $this->pdo->query('SELECT messages, reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame('keep this reason', $row['reason']);
        self::assertSame([['role' => 'user', 'content' => 'keep me']], json_decode((string) $row['messages'], true));
    }

    public function testPutRejectsANonScalarReasonAndDoesNotOverwriteExistingData(): void
    {
        $this->handler->put(7, 1, json_encode(['messages' => [], 'reason' => 'original reason']));

        $body = json_encode([
            'messages' => [['role' => 'user', 'content' => 'should not be saved']],
            'reason' => ['nested' => 'object'],
        ]);
        $response = $this->handler->put(7, 1, $body);

        self::assertSame(400, $response->getStatusCode());

        $row = $this->pdo->query('SELECT messages, reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame('original reason', $row['reason']);
        self::assertSame([], json_decode((string) $row['messages'], true));
    }
}
