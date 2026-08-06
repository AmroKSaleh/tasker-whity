<?php

declare(strict_types=1);

namespace Tasker\Access;

use PDO;

/**
 * Computes OU-descendant visibility scope for Tasker's resources.
 *
 * A user in OU X sees resources whose ou_id is X or any descendant of X, plus
 * every resource with ou_id IS NULL (tenant-root, visible to all). This is the
 * DESCENDANT direction — the opposite of whity-core's own RoleChecker, which
 * walks UP the parent chain for permission inheritance. There is no existing
 * host function for this traversal; it is Tasker's own.
 *
 * A null caller OU means tenant-root: unrestricted visibility across every OU
 * in the tenant. This matches whity-core's own seeded bootstrap accounts,
 * which are given ou_id = NULL explicitly — the alternative (null OU sees only
 * ou_id IS NULL resources) would leave the platform's own admin unable to see
 * anything once real OUs exist.
 *
 * organizational_units.parent_id can be made to cycle (including a node being
 * its own parent) per the host's own schema comments, which document this as
 * the API layer's responsibility to guard. Every traversal here is bounded by
 * $maxDepth.
 */
final class OuScopeResolver
{
    private const DEFAULT_MAX_DEPTH = 50;

    /**
     * The set of OU ids in $ouId's subtree, inclusive of $ouId itself.
     *
     * @return list<int>
     */
    public static function descendantIds(PDO $pdo, int $tenantId, int $ouId, int $maxDepth = self::DEFAULT_MAX_DEPTH): array
    {
        $stmt = $pdo->prepare(
            'WITH RECURSIVE subtree(id, depth) AS (
                SELECT id, 0 FROM organizational_units WHERE id = :ou_id AND tenant_id = :tenant_id
                UNION ALL
                SELECT ou.id, s.depth + 1
                FROM organizational_units ou
                JOIN subtree s ON ou.parent_id = s.id
                WHERE ou.tenant_id = :tenant_id AND s.depth < :max_depth
            )
            SELECT DISTINCT id FROM subtree'
        );

        // PDOStatement::execute(array) always binds every value as
        // PDO::PARAM_STR, regardless of the PHP type passed in. That is
        // harmless for the equality predicates above (SQLite's column
        // affinity coerces "7" back to 7 against an INTEGER column), but
        // fatal for "s.depth < :max_depth": neither the CTE's derived
        // "depth" column nor a bound parameter carries declared affinity,
        // so SQLite compares them by storage class, where INTEGER always
        // sorts below TEXT regardless of value — making the bound-depth
        // check vacuously true and the recursion unbounded on a cycle.
        // bindValue() with an explicit PARAM_INT avoids that entirely.
        $stmt->bindValue(':ou_id', $ouId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':max_depth', $maxDepth, PDO::PARAM_INT);
        $stmt->execute();

        /** @var list<int> $ids */
        $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

        return $ids;
    }

    /**
     * The scope parameters a query binds directly: whether the caller is
     * unrestricted (null OU), and their descendant OU id set otherwise.
     *
     * Callers always bind BOTH parameters against the SAME static SQL text
     * (see the WHERE fragment below) — never a runtime-branched query — so
     * the tenant_id predicate is never conditionally assembled.
     *
     * @return array{unrestricted: bool, scope: list<int>}
     */
    public static function scopeParams(PDO $pdo, int $tenantId, ?int $callerOuId): array
    {
        if ($callerOuId === null) {
            return ['unrestricted' => true, 'scope' => []];
        }

        return ['unrestricted' => false, 'scope' => self::descendantIds($pdo, $tenantId, $callerOuId)];
    }

    /**
     * The static WHERE fragment every OU-scoped query on a table with its own
     * ou_id column uses, unconditionally. $column is the table-qualified
     * column name (e.g. "p.ou_id") so callers can use this directly or
     * through a join.
     */
    public static function whereFragment(string $column): string
    {
        return "(:unrestricted = TRUE OR {$column} IS NULL OR {$column} = ANY(:scope))";
    }
}
