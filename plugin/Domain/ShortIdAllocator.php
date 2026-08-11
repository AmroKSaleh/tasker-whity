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
     * The next candidate short_id for this project. Not reserved — the unique
     * constraint is what makes concurrent use safe.
     */
    public static function next(PDO $db, int $tenantId, int $projectId): int
    {
        $stmt = $db->prepare(
            'SELECT COALESCE(MAX(short_id), 0) + 1 FROM tasker_tasks
             WHERE project_id = :project_id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':project_id' => $projectId, ':tenant_id' => $tenantId]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * Whether a PDOException is a unique-constraint violation, i.e. a lost
     * race worth retrying rather than a real failure.
     *
     * Postgres reports SQLSTATE 23505; SQLite reports 23000 with a message
     * naming the constraint. Both are checked because the plugin's tests run
     * on SQLite and production runs on Postgres.
     */
    public static function isRaceLoss(PDOException $e): bool
    {
        $sqlState = $e->errorInfo[0] ?? $e->getCode();

        if ((string) $sqlState === '23505') {
            return true;
        }

        return (string) $sqlState === '23000'
            && stripos($e->getMessage(), 'idx_tasker_tasks_project_short_id') !== false;
    }

    /**
     * @param callable(int): void $insert Receives the candidate short_id and
     *        performs the INSERT; must let PDOException propagate.
     */
    public static function withRetry(PDO $db, int $tenantId, int $projectId, callable $insert): int
    {
        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
            $candidate = self::next($db, $tenantId, $projectId);

            try {
                $insert($candidate);

                return $candidate;
            } catch (PDOException $e) {
                if (!self::isRaceLoss($e) || $attempt === self::MAX_ATTEMPTS) {
                    throw $e;
                }
                // Lost the race; recompute MAX+1 and try again.
            }
        }

        throw new RuntimeException('Exhausted short_id allocation attempts');
    }
}
