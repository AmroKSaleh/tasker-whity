<?php

declare(strict_types=1);

namespace Tasker\Tests\Access;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Access\OuScopeResolver;

final class OuScopeResolverTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('
            CREATE TABLE organizational_units (
                id INTEGER PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                parent_id INTEGER NULL REFERENCES organizational_units(id)
            )
        ');
    }

    private function makeOu(int $id, int $tenantId, ?int $parentId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO organizational_units (id, tenant_id, parent_id) VALUES (?, ?, ?)'
        );
        $stmt->execute([$id, $tenantId, $parentId]);
    }

    public function testDescendantIdsIncludesSelfAndChildren(): void
    {
        // 1 (root) -> 2 (child) -> 3 (grandchild); 4 is a sibling of 2, not a descendant.
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 2);
        $this->makeOu(4, 7, 1);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1);

        sort($ids);
        self::assertSame([1, 2, 3, 4], $ids);
    }

    public function testDescendantIdsExcludesAncestorsAndSiblings(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 2);
        $this->makeOu(4, 7, 1);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 2);

        sort($ids);
        self::assertSame([2, 3], $ids, 'OU 2\'s subtree must not include its parent (1) or its sibling (4)');
    }

    public function testDescendantIdsIsScopedToTenant(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        // A different tenant's OU, same id-space shape, must never leak in.
        $this->makeOu(10, 9, null);
        $this->makeOu(11, 9, 10);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1);

        sort($ids);
        self::assertSame([1, 2], $ids);
    }

    public function testDescendantIdsIsBoundedAgainstACycle(): void
    {
        // whity's own schema permits a node to be its own parent, or a cycle
        // through several nodes. The traversal must terminate, not hang.
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->pdo->exec('UPDATE organizational_units SET parent_id = 2 WHERE id = 1'); // 1 -> 2 -> 1

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1, maxDepth: 5);

        // The exact membership is secondary; termination is the point. Both
        // nodes are reachable from 1 within 5 hops around the cycle.
        sort($ids);
        self::assertSame([1, 2], $ids);
    }

    public function testScopeParamsForANullCallerOuIsUnrestricted(): void
    {
        $params = OuScopeResolver::scopeParams($this->pdo, 7, null);

        self::assertTrue($params['unrestricted']);
    }

    public function testScopeParamsForARealCallerOuIsNotUnrestricted(): void
    {
        $this->makeOu(1, 7, null);

        $params = OuScopeResolver::scopeParams($this->pdo, 7, 1);

        self::assertFalse($params['unrestricted']);
        self::assertSame([1], $params['scope']);
    }
}
