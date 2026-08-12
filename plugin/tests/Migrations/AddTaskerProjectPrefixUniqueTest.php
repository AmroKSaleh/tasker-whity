<?php

declare(strict_types=1);

namespace Tasker\Tests\Migrations;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Migrations\AddTaskerProjectPrefixUnique;
use Tasker\Migrations\CreateTaskerProjectsTable;

/**
 * WHOLE-BRANCH REVIEW B2, the migration half.
 *
 * Deliberately on the SQLITE tier, unlike the handler-level 409 tests (which
 * live in TenantIsolationOuTest because ProjectsApiHandler is OU-aware and so
 * Postgres-only). Two reasons:
 *
 *  1. The pre-existing-duplicate path can only be exercised against a table
 *     that ALREADY holds duplicates, and TenantIsolationOuTest drops and
 *     recreates tasker_projects in every setUp() — its table is always clean by
 *     construction, so the refusal branch has nowhere to fire there.
 *  2. It proves the constraint the review required: a PARTIAL unique index runs
 *     on SQLite as well as PostgreSQL, so adding it does not cost the SQLite
 *     tier its ability to run the plugin's migrations.
 */
final class AddTaskerProjectPrefixUniqueTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // The REAL migration, not a hand-rolled fixture table — the point here
        // is partly that these two migrations compose on SQLite.
        (new CreateTaskerProjectsTable())->up($this->pdo);
    }

    private function insertProject(int $id, int $tenantId, string $name, ?string $prefix): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_projects (id, public_id, tenant_id, name, slug, prefix, created_by)
             VALUES (:id, :public_id, :tenant_id, :name, :slug, :prefix, 1)'
        );
        $stmt->execute([
            ':id' => $id,
            ':public_id' => sprintf('00000000-0000-4000-8000-%012d', $id),
            ':tenant_id' => $tenantId,
            ':name' => $name,
            ':slug' => strtolower(str_replace(' ', '-', $name)),
            ':prefix' => $prefix,
        ]);
    }

    public function testTheMigrationRunsOnSqliteAndRejectsADuplicatePrefixInTheSameTenant(): void
    {
        (new AddTaskerProjectPrefixUnique())->up($this->pdo);

        $this->insertProject(1, 7, 'First', 'TDE');

        $this->expectException(\PDOException::class);
        $this->insertProject(2, 7, 'Second', 'TDE');
    }

    public function testTheSamePrefixIsAllowedInADifferentTenant(): void
    {
        (new AddTaskerProjectPrefixUnique())->up($this->pdo);

        $this->insertProject(1, 7, 'Mine', 'TDE');
        $this->insertProject(2, 9, 'Theirs', 'TDE');

        self::assertSame(
            2,
            (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE prefix = 'TDE'")->fetchColumn(),
            'uniqueness is per (tenant_id, prefix), matching PrefixDeriver\'s own tenant scope'
        );
    }

    /**
     * The index is PARTIAL for this reason: PrefixDeriver::derive() legitimately
     * returns null when every candidate is exhausted, and such a project simply
     * has no short ids. That outcome must stay repeatable.
     */
    public function testAnyNumberOfProjectsMayHaveANullPrefix(): void
    {
        (new AddTaskerProjectPrefixUnique())->up($this->pdo);

        $this->insertProject(1, 7, 'No prefix one', null);
        $this->insertProject(2, 7, 'No prefix two', null);
        $this->insertProject(3, 7, 'No prefix three', null);

        self::assertSame(
            3,
            (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_projects WHERE prefix IS NULL')->fetchColumn()
        );
    }

    /**
     * A live database may ALREADY hold duplicates — this bug shipped. A bare
     * CREATE UNIQUE INDEX against them throws an opaque engine error naming
     * only the index, so the migration detects them first and refuses with a
     * message that names every offending row. See the migration's own docblock
     * for why it refuses rather than nulling the losers automatically (doing so
     * silently destroys short ids that already refer to the losing project).
     */
    public function testItRefusesWithAMessageNamingPreExistingDuplicates(): void
    {
        $this->insertProject(1, 7, 'First TDE', 'TDE');
        $this->insertProject(2, 7, 'Second TDE', 'TDE');
        $this->insertProject(3, 7, 'Third TDE', 'TDE');
        $this->insertProject(4, 9, 'Other tenant OTH', 'OTH');
        $this->insertProject(5, 7, 'Innocent', 'INN');

        try {
            (new AddTaskerProjectPrefixUnique())->up($this->pdo);
            self::fail('the migration must refuse to run against pre-existing duplicate prefixes');
        } catch (\RuntimeException $e) {
            $message = $e->getMessage();

            self::assertStringContainsString('tenant_id=7 prefix=TDE', $message);
            self::assertStringContainsString('is held by 3 projects: id 1, 2, 3', $message, 'the message must name the offending rows, not just the constraint');
            self::assertStringNotContainsString('prefix=INN', $message, 'a non-duplicate prefix must not be reported');
            self::assertStringNotContainsString('prefix=OTH', $message, 'the same prefix in a different tenant is not a duplicate');
            self::assertStringContainsString('re-run this migration', $message, 'the failure must tell the operator it is recoverable');
        }

        // And it really is recoverable: the refusal left no index behind, so
        // once an operator resolves the duplicates the migration succeeds.
        $this->pdo->exec('UPDATE tasker_projects SET prefix = NULL WHERE id IN (2, 3)');
        (new AddTaskerProjectPrefixUnique())->up($this->pdo);

        $this->expectException(\PDOException::class);
        $this->insertProject(6, 7, 'Late duplicate', 'TDE');
    }

    public function testDownRemovesTheIndex(): void
    {
        $migration = new AddTaskerProjectPrefixUnique();
        $migration->up($this->pdo);
        $migration->down($this->pdo);

        $this->insertProject(1, 7, 'First', 'TDE');
        $this->insertProject(2, 7, 'Second', 'TDE');

        self::assertSame(
            2,
            (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE prefix = 'TDE'")->fetchColumn(),
            'down() must drop the index, so the duplicate it used to reject is accepted again'
        );
    }
}
