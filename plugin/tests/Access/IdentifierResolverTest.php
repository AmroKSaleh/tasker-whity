<?php

declare(strict_types=1);

namespace Tasker\Tests\Access;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Access\IdentifierResolver;

final class IdentifierResolverTest extends TestCase
{
    private PDO $pdo;

    /**
     * resolveMilestone() makes no OuScopeResolver call at all -- milestones
     * are addressed by (id|public_id, task_id, tenant_id) only, never by
     * ou_id -- so unlike resolveProject()/resolveTask()/resolveSection()/
     * resolveGroup() it is genuinely testable against SQLite. A minimal
     * fixture table is enough; the real migration's BIGSERIAL/UUID column
     * types are PostgreSQL-specific and irrelevant to what's under test here.
     */
    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('
            CREATE TABLE tasker_milestones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_id TEXT NOT NULL,
                tenant_id INTEGER NOT NULL,
                task_id INTEGER NOT NULL,
                summary TEXT NOT NULL,
                checked INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            )
        ');
    }

    private function makeMilestone(int $tenantId, int $taskId, string $summary, int $sortOrder = 0): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO tasker_milestones (public_id, tenant_id, task_id, summary, sort_order) VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([self::uuid(), $tenantId, $taskId, $summary, $sortOrder]);

        return (int) $this->pdo->lastInsertId();
    }

    private function publicIdOf(int $milestoneId): string
    {
        $stmt = $this->pdo->prepare('SELECT public_id FROM tasker_milestones WHERE id = ?');
        $stmt->execute([$milestoneId]);

        return (string) $stmt->fetchColumn();
    }

    private static function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
    /**
     * Precedence is fixed and documented: integer, UUID, short id, prefix,
     * slug. The first match wins. Ambiguity resolves silently rather than
     * erroring, so that a caller who works today keeps working.
     */
    public function testClassifiesEachIdentifierForm(): void
    {
        self::assertSame('empty', IdentifierResolver::classify(null));
        self::assertSame('empty', IdentifierResolver::classify(''));
        self::assertSame('empty', IdentifierResolver::classify('   '));

        self::assertSame('integer', IdentifierResolver::classify(42));
        self::assertSame('integer', IdentifierResolver::classify('42'));

        self::assertSame('uuid', IdentifierResolver::classify('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));

        self::assertSame('short_id', IdentifierResolver::classify('TDE-31'));
        self::assertSame('short_id', IdentifierResolver::classify('AB-1'));
        self::assertSame('short_id', IdentifierResolver::classify('ABCDE-9999'));

        self::assertSame('prefix', IdentifierResolver::classify('TDE'));
        self::assertSame('prefix', IdentifierResolver::classify('AB'));

        self::assertSame('slug', IdentifierResolver::classify('website-redesign'));
        self::assertSame('slug', IdentifierResolver::classify('backlog'));
    }

    public function testRejectsAMalformedShortIdRatherThanTreatingItAsASlug(): void
    {
        // TDE-abc looks like a short id and is not one. Silently falling
        // through to a slug lookup would turn a typo into a confusing 404;
        // this is the one case that earns a 400.
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-abc'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-0031x'));
    }

    public function testLowercasePrefixShapedInputIsASlugNotAPrefix(): void
    {
        // Prefixes are uppercase by construction (^[A-Z]{2,5}$). "tde" is a
        // plausible slug, so it must not be mistaken for prefix TDE.
        self::assertSame('slug', IdentifierResolver::classify('tde'));
    }

    public function testAnOverlongUppercaseTokenIsASlugNotAPrefix(): void
    {
        // 6+ uppercase letters cannot be a prefix (cap is 5).
        self::assertSame('slug', IdentifierResolver::classify('ABCDEF'));
    }

    public function testNegativeAndZeroIntegersAreNotValidIdentifiers(): void
    {
        self::assertSame('slug', IdentifierResolver::classify('-5'));
        self::assertSame('integer', IdentifierResolver::classify('0'));
    }

    // Task review finding #2: resolveMilestone() had no coverage at all.
    // It makes no OuScopeResolver call, so unlike resolveProject()/
    // resolveTask()/resolveSection()/resolveGroup() it belongs here, on the
    // SQLite double, not in the Postgres-only suite.

    public function testResolveMilestoneFindsByIdWithinTheTask(): void
    {
        $milestoneId = $this->makeMilestone(7, 100, 'Write tests');

        self::assertSame($milestoneId, IdentifierResolver::resolveMilestone($this->pdo, 7, 100, $milestoneId));
    }

    public function testResolveMilestoneFallsBackToPositionalIndexWhenTheIntegerIsNotAKnownId(): void
    {
        // Filler rows for an unrelated task, inserted first purely to push
        // SQLite's AUTOINCREMENT counter past the 0/1/2 values used as
        // INDEXES below. Without this, a fresh table's first three rows
        // would be handed ids 1/2/3 -- which would coincidentally also BE
        // valid milestone ids and make the id-lookup branch succeed instead
        // of falling through to the positional index this test targets.
        $this->makeMilestone(7, 999, 'Unrelated filler A');
        $this->makeMilestone(7, 999, 'Unrelated filler B');
        $this->makeMilestone(7, 999, 'Unrelated filler C');

        $first  = $this->makeMilestone(7, 200, 'First', 0);
        $second = $this->makeMilestone(7, 200, 'Second', 1);
        $third  = $this->makeMilestone(7, 200, 'Third', 2);
        self::assertGreaterThan(2, $first, 'sanity check: ids must be clear of the 0/1/2 index values used below');

        self::assertSame($first, IdentifierResolver::resolveMilestone($this->pdo, 7, 200, 0));
        self::assertSame($second, IdentifierResolver::resolveMilestone($this->pdo, 7, 200, 1));
        self::assertSame($third, IdentifierResolver::resolveMilestone($this->pdo, 7, 200, 2));
    }

    public function testResolveMilestoneReturnsNullForAnOutOfRangeIndex(): void
    {
        $this->makeMilestone(7, 300, 'Only one');

        self::assertNull(IdentifierResolver::resolveMilestone($this->pdo, 7, 300, 5));
    }

    public function testResolveMilestoneReturnsNullWhenTheTaskHasNoMilestonesAtAll(): void
    {
        self::assertNull(IdentifierResolver::resolveMilestone($this->pdo, 7, 400, 0));
    }

    public function testResolveMilestoneFindsByUuid(): void
    {
        $milestoneId = $this->makeMilestone(7, 500, 'Ship it');
        $publicId = $this->publicIdOf($milestoneId);

        self::assertSame($milestoneId, IdentifierResolver::resolveMilestone($this->pdo, 7, 500, $publicId));
    }
}
