<?php

declare(strict_types=1);

namespace Tasker\Domain;

use PDO;
use PDOException;
use RuntimeException;

/**
 * Allocates the next per-project short_id.
 *
 * Correctness comes from UNIQUE (project_id, short_id) — see
 * AddTaskerTaskShortIdUnique. We compute MAX+1 and let the constraint reject
 * a race, then retry. That is portable across Postgres and SQLite, unlike the
 * original's pg_advisory_xact_lock, and unlike SELECT ... FOR UPDATE.
 *
 * Callers pass the allocated value into their own INSERT, so the retry loop
 * lives with the caller's insert rather than here — this class only computes
 * the next candidate. See TasksApiHandler::create() for the retry.
 */
final class ShortIdAllocator
{
    public const MAX_ATTEMPTS = 5;

    /**
     * Tables this allocator is allowed to serve. Closed, code-level
     * whitelist — never derived from caller input. $table is interpolated
     * into SQL text below (PDO cannot bind identifiers), so assertTable()
     * validating against this list, rather than accepting any string, is
     * what keeps that interpolation from becoming a caller-controlled SQL
     * injection point.
     */
    private const ALLOWED_TABLES = ['tasker_tasks', 'tasker_flows'];

    /**
     * The next candidate short_id for this project. Not reserved — the unique
     * constraint is what makes concurrent use safe.
     */
    public static function next(PDO $db, int $tenantId, int $projectId, string $table = 'tasker_tasks'): int
    {
        $table = self::assertTable($table);

        $stmt = $db->prepare(
            "SELECT COALESCE(MAX(short_id), 0) + 1 FROM {$table}
             WHERE project_id = :project_id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':project_id' => $projectId, ':tenant_id' => $tenantId]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * Validates $table against the closed ALLOWED_TABLES whitelist before it
     * is interpolated into SQL text. Throws rather than silently falling
     * back, since an unknown table here means a caller (or future table
     * addition) bypassed the whitelist rather than a value that can be
     * defaulted away.
     */
    private static function assertTable(string $table): string
    {
        if (!in_array($table, self::ALLOWED_TABLES, true)) {
            throw new \InvalidArgumentException('Unknown short-id table: ' . $table);
        }

        return $table;
    }

    /**
     * Whether a PDOException is a unique-constraint violation, i.e. a lost
     * race worth retrying rather than a real failure.
     *
     * Postgres reports SQLSTATE 23505 for a unique violation specifically, so
     * that check alone is precise. SQLite reports the broader 23000
     * (integrity constraint violation in general — NOT NULL, CHECK, and FK
     * failures all share it too), so 23000 alone would be too wide: it would
     * make withRetry() waste every attempt retrying a NOT NULL/CHECK/FK bug
     * that will never succeed, before finally rethrowing the last one.
     * Narrowed instead by checking the message names OUR OWN table and both
     * columns — confirmed empirically (a throwaway PDO SQLite script against
     * this exact schema) that a real violation of
     * `idx_tasker_tasks_project_short_id` reports:
     *   "UNIQUE constraint failed: tasker_tasks.project_id, tasker_tasks.short_id"
     * i.e. the table/column names, NEVER the index name — an earlier version
     * of this check matched on the index name instead and consequently never
     * matched a real SQLite error at all, silently turning the SQLite retry
     * path into dead code. Matching both column names (rather than the exact
     * substring, which also encodes their comma-separated order) tolerates
     * a future SQLite version reordering or rewording the message slightly.
     *
     * This check is now per-table: $table (validated against the same
     * ALLOWED_TABLES whitelist next() uses) is substituted into the message
     * fragments matched below, so a violation on tasker_flows's own unique
     * index — "UNIQUE constraint failed: tasker_flows.project_id,
     * tasker_flows.short_id" — is recognised as a tasker_flows race and NOT
     * as a tasker_tasks race, and vice versa. Repeating the original
     * index-name mistake for a second table, or matching one table's message
     * against another table's name, would silently resurrect the exact dead
     * SQLite retry path described above, just scoped to whichever table it
     * hit.
     */
    public static function isRaceLoss(PDOException $e, string $table = 'tasker_tasks'): bool
    {
        $table = self::assertTable($table);
        $sqlState = $e->errorInfo[0] ?? $e->getCode();

        if ((string) $sqlState === '23505') {
            return true;
        }

        return (string) $sqlState === '23000'
            && stripos($e->getMessage(), "{$table}.project_id") !== false
            && stripos($e->getMessage(), "{$table}.short_id") !== false;
    }

    /**
     * @param callable(int): void $insert Receives the candidate short_id and
     *        performs the INSERT; must let PDOException propagate.
     */
    public static function withRetry(
        PDO $db,
        int $tenantId,
        int $projectId,
        callable $insert,
        string $table = 'tasker_tasks'
    ): int {
        $table = self::assertTable($table);

        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
            $candidate = self::next($db, $tenantId, $projectId, $table);

            try {
                $insert($candidate);

                return $candidate;
            } catch (PDOException $e) {
                if (!self::isRaceLoss($e, $table) || $attempt === self::MAX_ATTEMPTS) {
                    throw $e;
                }
                // Lost the race; recompute MAX+1 and try again.
            }
        }

        throw new RuntimeException('Exhausted short_id allocation attempts');
    }
}
