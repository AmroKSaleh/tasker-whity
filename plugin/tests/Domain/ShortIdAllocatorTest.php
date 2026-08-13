<?php

declare(strict_types=1);

namespace Tasker\Tests\Domain;

use PDO;
use PDOException;
use PHPUnit\Framework\TestCase;
use Tasker\Domain\ShortIdAllocator;
use Tasker\Migrations\AddTaskerTaskShortIdUnique;

/**
 * Exercises ShortIdAllocator directly against SQLite — no Postgres-only
 * syntax is involved (MAX()/COALESCE()/a plain UNIQUE INDEX all work
 * identically on both engines), so this suite needs no real database
 * connection, unlike TenantIsolationOuTest's allocation coverage.
 *
 * Added after code review found that nothing exercised withRetry()'s actual
 * retry path on either engine: TenantIsolationOuTest::
 * testShortIdUniqueConstraintRejectsADuplicate proves the unique index
 * exists and bites, but drives a raw UPDATE and never calls the allocator,
 * and testShortIdIsAllocatedSequentiallyPerProject never provokes a
 * conflict (each call's MAX+1 is always genuinely free). Neither would have
 * caught isRaceLoss()'s SQLite branch matching the wrong string.
 */
final class ShortIdAllocatorTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE tasker_tasks (
                id INTEGER PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                short_id INTEGER NULL
            )'
        );
        (new AddTaskerTaskShortIdUnique())->up($this->pdo);
    }

    public function testNextReturnsOneForAProjectWithNoTasksYet(): void
    {
        self::assertSame(1, ShortIdAllocator::next($this->pdo, 7, 1));
    }

    public function testNextReturnsMaxPlusOne(): void
    {
        $this->pdo->exec('INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (7, 1, 1)');
        $this->pdo->exec('INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (7, 1, 4)');

        self::assertSame(5, ShortIdAllocator::next($this->pdo, 7, 1));
    }

    public function testNextIsScopedPerProject(): void
    {
        $this->pdo->exec('INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (7, 1, 9)');

        self::assertSame(1, ShortIdAllocator::next($this->pdo, 7, 2), 'a different project must not see project 1\'s short_ids');
    }

    /**
     * The scenario withRetry() exists for: the candidate MAX+1 computed is
     * correct AT THE TIME it's computed, but another insert claims that
     * exact (project_id, short_id) before this caller's own INSERT commits.
     * A single PDO connection can't run two genuinely concurrent
     * transactions, so the "other" insert is simulated from inside the
     * test's own callback, on its first invocation only, landing in exactly
     * the window withRetry()'s retry loop is meant to recover from: after
     * next() has already computed the (soon to be stolen) candidate, before
     * this callback's own attempt to claim it.
     *
     * This is the test that would have caught the isRaceLoss() SQLite
     * message-matching bug directly: with the old (wrong) index-name check,
     * the PDOException raised below would never have been recognised as a
     * race loss, and withRetry() would have rethrown it on the first
     * attempt instead of recovering.
     */
    public function testWithRetryRecoversWhenAConcurrentInsertStealsTheComputedCandidate(): void
    {
        $attempts = 0;

        $allocated = ShortIdAllocator::withRetry(
            $this->pdo,
            7,
            1,
            function (int $candidate) use (&$attempts): void {
                $attempts++;
                if ($attempts === 1) {
                    // Simulate a concurrent insert winning the race for the
                    // candidate withRetry() just computed (1, on an empty
                    // project) — landing after next() ran, before this
                    // closure's own insert below.
                    $this->pdo->exec(
                        "INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (7, 1, {$candidate})"
                    );
                }

                // This is the caller's real insert, using the SAME
                // candidate withRetry() handed it. On attempt 1 it collides
                // with the just-simulated row above and must throw; on
                // attempt 2, short_id=1 is now taken so next() will have
                // recomputed candidate=2, which is free.
                $stmt = $this->pdo->prepare(
                    'INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (:tenant_id, :project_id, :short_id)'
                );
                $stmt->execute([':tenant_id' => 7, ':project_id' => 1, ':short_id' => $candidate]);
            }
        );

        self::assertSame(2, $allocated, 'losing the race for candidate 1 must recompute and land on 2');
        self::assertSame(2, $attempts, 'exactly one retry should have been needed');

        $shortIds = $this->pdo
            ->query('SELECT short_id FROM tasker_tasks WHERE project_id = 1 ORDER BY short_id')
            ->fetchAll(PDO::FETCH_COLUMN);
        self::assertSame([1, 2], $shortIds, 'both the simulated racer\'s row and this caller\'s eventual row must persist');
    }

    /**
     * A genuinely different failure (here: a NOT NULL violation on a column
     * the unique index has nothing to do with) must propagate IMMEDIATELY,
     * not be swallowed as a "race" and retried into MAX_ATTEMPTS exhaustion.
     * This is exactly the precision isRaceLoss()'s table/column-name check
     * (rather than bare SQLSTATE 23000) exists to preserve — see its own
     * docblock.
     *
     * WHOLE-BRANCH REVIEW consistency fix: a bare expectException(PDOException::class)
     * here (the previous body) cannot tell "propagated on attempt 1" apart
     * from "swallowed as a false race, retried MAX_ATTEMPTS (5) times, and
     * THEN rethrown once retries were exhausted" — isRaceLoss() returning
     * true by mistake for a NOT NULL violation would still end in a
     * PDOException reaching the caller, so that alone proves nothing about
     * the "immediately" this test's own name and docblock claim. Counting
     * the closure's own invocations is what actually distinguishes the two:
     * exactly 1 means no retry happened; anything up to 5 would mean this
     * violation was wrongly treated as a race.
     */
    public function testWithRetryDoesNotTreatAnUnrelatedConstraintViolationAsARace(): void
    {
        $attempts = 0;

        try {
            ShortIdAllocator::withRetry(
                $this->pdo,
                7,
                1,
                function (int $candidate) use (&$attempts): void {
                    $attempts++;
                    // tenant_id is NOT NULL; omitting it violates a different
                    // constraint entirely, unrelated to (project_id, short_id).
                    $stmt = $this->pdo->prepare(
                        'INSERT INTO tasker_tasks (tenant_id, project_id, short_id) VALUES (NULL, :project_id, :short_id)'
                    );
                    $stmt->execute([':project_id' => 1, ':short_id' => $candidate]);
                }
            );

            self::fail('withRetry() must let an unrelated constraint violation propagate, not swallow it');
        } catch (PDOException) {
            // Expected -- the assertion that matters is on $attempts below,
            // not merely that SOME PDOException eventually surfaced.
        }

        self::assertSame(
            1,
            $attempts,
            'an unrelated constraint violation must propagate on the FIRST attempt -- any higher count means '
                . 'isRaceLoss() wrongly treated it as a race and burned retries before giving up'
        );
    }

    public function testNextAllocatesPerTableSoFlowsAndTasksDoNotShareASequence(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_flows (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL, short_id INTEGER)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 40)');
        $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 2)');

        self::assertSame(41, ShortIdAllocator::next($this->pdo, 7, 3));
        self::assertSame(3, ShortIdAllocator::next($this->pdo, 7, 3, 'tasker_flows'));
    }

    public function testIsRaceLossMatchesTheFlowTablesOwnSqliteMessage(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_flows (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL, short_id INTEGER)');
        $this->pdo->exec('CREATE UNIQUE INDEX idx_tasker_flows_project_short_id ON tasker_flows (project_id, short_id)');
        $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 1)');

        try {
            $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (2, 7, 3, 1)');
            self::fail('expected a unique violation');
        } catch (\PDOException $e) {
            self::assertTrue(
                ShortIdAllocator::isRaceLoss($e, 'tasker_flows'),
                'the flow table must get REAL race detection, not a check that silently never matches'
            );
            self::assertFalse(
                ShortIdAllocator::isRaceLoss($e, 'tasker_tasks'),
                'a flow violation must not read as a task violation'
            );
        }
    }
}
