<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SessionApiHandler;
use Tasker\Migrations\CreateTaskerUserPrefsTable;

final class SessionApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private SessionApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT)');
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, name) VALUES (100, 7, 'Mine'), (200, 9, 'Theirs')");
        (new CreateTaskerUserPrefsTable())->up($this->pdo);

        $this->handler = new SessionApiHandler($this->pdo);
    }

    public function testInitCreatesThePrefsRowOnFirstCallAndIsIdempotent(): void
    {
        $first = $this->handler->init(7, 3);
        self::assertSame(200, $first->getStatusCode());

        $this->handler->init(7, 3);

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_user_prefs')->fetchColumn();
        self::assertSame(1, $count, 'init must not create a second prefs row for the same tenant+profile');
    }

    public function testInitReturnsThePlaybookAndTheCurrentPrefs(): void
    {
        $payload = json_decode($this->handler->init(7, 3)->getBody(), true);

        self::assertArrayHasKey('directives', $payload['data']);
        self::assertNotSame('', trim((string) $payload['data']['directives']));
        self::assertNull($payload['data']['defaultProjectId']);
        self::assertFalse($payload['data']['localMode']);
    }

    public function testSetDefaultProjectAcceptsAProjectInTheCallersTenant(): void
    {
        $this->handler->init(7, 3);

        $response = $this->handler->setDefaultProject(7, 3, 100);

        self::assertSame(200, $response->getStatusCode());
        self::assertSame(100, SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testSetDefaultProjectRejectsAProjectFromAnotherTenant(): void
    {
        $this->handler->init(7, 3);

        $response = $this->handler->setDefaultProject(7, 3, 200);

        self::assertSame(404, $response->getStatusCode());
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testSetDefaultProjectAcceptsNullToClearIt(): void
    {
        $this->handler->init(7, 3);
        $this->handler->setDefaultProject(7, 3, 100);

        $response = $this->handler->setDefaultProject(7, 3, null);

        self::assertSame(200, $response->getStatusCode());
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testDefaultProjectIsPerProfileNotPerTenant(): void
    {
        $this->handler->init(7, 3);
        $this->handler->init(7, 4);
        $this->handler->setDefaultProject(7, 3, 100);

        self::assertSame(100, SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 4));
    }
}
