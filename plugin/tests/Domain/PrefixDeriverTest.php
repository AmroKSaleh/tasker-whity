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

        // TDE taken -> next candidate is 'X' appended to the base ("TDE" +
        // "X"), NOT the base's last char replaced by the suffix. The
        // original app's `base.slice(0, 5 - suffix.length) + suffix` returns
        // the whole (unpadded) base when 5 - suffix.length exceeds the
        // base's own length, so a 3-char base grows to 4 chars on the first
        // collision -- see PrefixDeriver::derive()'s own docblock comment
        // for why this hardcoded 5 is intentional, not a bug.
        self::assertSame('TDEX', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testCollisionsAreScopedPerTenant(): void
    {
        // Another tenant holding TDE must not force a suffix here.
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES (1, 9, 'TDE')");

        self::assertSame('TDE', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testReturnsNullWhenEveryCandidateIsTaken(): void
    {
        // Re-derived against the restored append-based formula (base "TDE",
        // hardcoded 5): '' produces "TDE" (3 chars); every non-empty suffix
        // in '', X, Y, Z, A, B, C, D, E, F appends to the whole 3-char base
        // rather than substituting into it, producing "TDEX", "TDEY", …,
        // "TDEF" (4 chars each). All 10 are distinct -- unlike a
        // substitution-based formula, suffix 'E' does NOT collide with the
        // unsuffixed "TDE" here, because "TDEE" (4 chars) != "TDE" (3
        // chars). Every one of these 10 must be taken to force null.
        $id = 1;
        foreach (['TDE', 'TDEX', 'TDEY', 'TDEZ', 'TDEA', 'TDEB', 'TDEC', 'TDED', 'TDEE', 'TDEF'] as $p) {
            $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES ({$id}, 7, '{$p}')");
            $id++;
        }

        // Every suffix candidate exhausted -> null, and the caller must cope
        // (a project without a prefix simply has no short ids).
        self::assertNull(PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }
}
