<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\PingApiHandler;
use Tasker\Migrations\CreateTaskerPingTable;

final class PingApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private PingApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        (new CreateTaskerPingTable())->up($this->pdo);

        $this->handler = new PingApiHandler($this->pdo);
    }

    public function testCreateStampsTheCallersTenant(): void
    {
        $response = $this->handler->create(7, json_encode(['label' => 'hello']));

        self::assertSame(201, $response->getStatusCode());

        $row = $this->pdo->query('SELECT tenant_id, label FROM tasker_pings')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame('hello', $row['label']);
    }

    public function testListReturnsOnlyTheCallersTenantRows(): void
    {
        $this->handler->create(7, json_encode(['label' => 'mine']));
        $this->handler->create(9, json_encode(['label' => 'theirs']));

        $payload = json_decode($this->handler->list(7)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('mine', $payload['data'][0]['label']);
        self::assertSame(7, $payload['data'][0]['tenantId']);
    }

    public function testCreateRejectsAnEmptyLabel(): void
    {
        $response = $this->handler->create(7, json_encode(['label' => '   ']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCreateRejectsAMalformedBody(): void
    {
        $response = $this->handler->create(7, 'not json');

        self::assertSame(400, $response->getStatusCode());
    }
}
