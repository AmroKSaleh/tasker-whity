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

        // AuditLogger::record() (whity-core) writes its created_at via the
        // engine SQL function NOW(), which PostgreSQL provides natively but
        // SQLite does not. Registering a NOW() UDF here is a test-only
        // accommodation for the in-memory SQLite double — the same kind of
        // substitution testCreateWritesAnAuditLogEntry() below makes for the
        // audit_log.metadata column (TEXT instead of the real host's JSONB).
        // It changes no production code, and every real deployment runs on
        // PostgreSQL, where NOW() already works natively.
        $this->pdo->sqliteCreateFunction('NOW', static function (): string {
            return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        }, 0);

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

    public function testCreateWritesAnAuditLogEntry(): void
    {
        $this->pdo->exec('
            CREATE TABLE audit_log (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                actor_user_id INTEGER NULL,
                action VARCHAR(100) NOT NULL,
                target_type VARCHAR(100) NULL,
                target_id INTEGER NULL,
                metadata TEXT NOT NULL DEFAULT \'{}\',
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP)
            )
        ');

        $this->handler->create(7, json_encode(['label' => 'audited']));

        $row = $this->pdo->query('SELECT tenant_id, action, target_type, target_id FROM audit_log')->fetch(PDO::FETCH_ASSOC);

        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame('tasker_ping.created', $row['action']);
        self::assertSame('tasker_ping', $row['target_type']);
        self::assertGreaterThan(0, (int) $row['target_id']);
    }

    public function testTagAttachesAnExistingTagToAPing(): void
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

        $created = json_decode($this->handler->create(7, json_encode(['label' => 'taggable']))->getBody(), true);
        $pingId = $created['data']['id'];

        $response = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

        self::assertSame(201, $response->getStatusCode());

        $row = $this->pdo->query('SELECT tenant_id, entity_type, entity_id, tag_id FROM entity_tags')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame('tasker_ping', $row['entity_type']);
        self::assertSame($pingId, (int) $row['entity_id']);
        self::assertSame(42, (int) $row['tag_id']);
    }

    public function testTagIsIdempotentOnAlreadyAttachedTag(): void
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

        $created = json_decode($this->handler->create(7, json_encode(['label' => 'taggable']))->getBody(), true);
        $pingId = $created['data']['id'];

        $first = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));
        $second = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

        self::assertSame(201, $first->getStatusCode());
        self::assertSame(200, $second->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM entity_tags')->fetchColumn();
        self::assertSame(1, $count);
    }

    public function testTagRejectsAPingOutsideTheCallersTenant(): void
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

        $created = json_decode($this->handler->create(9, json_encode(['label' => 'belongs to tenant 9']))->getBody(), true);
        $pingId = $created['data']['id'];

        $response = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

        self::assertSame(404, $response->getStatusCode());
    }
}
