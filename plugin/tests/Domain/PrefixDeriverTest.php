<?php

declare(strict_types=1);

namespace Tasker\Tests\Domain;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Domain\PrefixDeriver;

final class PrefixDeriverTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, prefix TEXT NULL)');
    }

    public function testTakesInitialsOfUpToFourWords(): void
    {
        self::assertSame('TDE', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
        // NOTE ON A BRIEF DEVIATION: the brief's own fixture used "Gamma" here,
        // whose initial is G, not C -- "Alpha Beta Gamma Delta Epsilon" derives
        // to "ABGD", which can never equal the asserted "ABCD". Swapped for
        // "Charlie" so the fixture's initials actually spell what the
        // assertion says, the same "fix the fixture, not the assertion"
        // resolution the brief itself prescribes for the null-candidate test
        // below. The test's actual point -- five words, only the first four
        // contribute -- is unaffected.
        self::assertSame('ABCD', PrefixDeriver::derive($this->pdo, 7, 'Alpha Beta Charlie Delta Epsilon'));
    }

    public function testUsesTheFirstFourCharactersOfASingleWord(): void
    {
        self::assertSame('TASK', PrefixDeriver::derive($this->pdo, 7, 'Tasker'));
    }

    public function testPadsAnOverShortBaseToAtLeastTwoCharacters(): void
    {
        // "A" -> base "A" is 1 char -> (A + PRJ).slice(0,3) = "APR"
        self::assertSame('APR', PrefixDeriver::derive($this->pdo, 7, 'A'));
    }

    public function testIgnoresNonLetters(): void
    {
        self::assertSame('WR', PrefixDeriver::derive($this->pdo, 7, 'Website 2.0 Redesign!'));
    }

    public function testSuffixesOnCollisionWithinTheTenant(): void
    {
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES (1, 7, 'TDE')");

        // TDE taken -> first free candidate from '', X, Y, Z, A..F
        self::assertSame('TDX', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testCollisionsAreScopedPerTenant(): void
    {
        // Another tenant holding TDE must not force a suffix here.
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES (1, 9, 'TDE')");

        self::assertSame('TDE', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testReturnsNullWhenEveryCandidateIsTaken(): void
    {
        // Covers every distinct candidate PrefixDeriver can generate for base
        // "TDE": '' and suffix 'E' both produce "TDE" (a suffix replaces the
        // base's trailing character, and 'E' is already the base's own last
        // letter), so "TDE2" here is a harmless extra row, not a tenth
        // distinct candidate.
        $id = 1;
        foreach (['TDE', 'TDX', 'TDY', 'TDZ', 'TDA', 'TDB', 'TDC', 'TDD', 'TDE2', 'TDF'] as $p) {
            $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES ({$id}, 7, '{$p}')");
            $id++;
        }

        // Every suffix candidate exhausted -> null, and the caller must cope
        // (a project without a prefix simply has no short ids).
        self::assertNull(PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }
}
