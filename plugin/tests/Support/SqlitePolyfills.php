<?php

declare(strict_types=1);

namespace Tasker\Tests\Support;

use PDO;

/**
 * SQLite compatibility shims for pinned whity-core classes this plugin's
 * handlers construct directly (never via the container).
 *
 * whity-core is fetched at a pinned ref (see host/core.version) and is out of
 * this plugin's editing scope. Several of its data-access classes hardcode
 * the engine function `NOW()` in their own SQL — e.g.
 * {@see \Whity\Core\Audit\AuditLogger::record()} and
 * {@see \Whity\Core\Taxonomy\EntityTagRepository::attach()} both write
 * `created_at` via a literal `NOW()` call. PostgreSQL provides `NOW()`
 * natively; the in-memory SQLite the plugin's unit tests run against does
 * not, and PHP's PDO SQLite driver has no built-in fallback for it. Without
 * this shim, every write through one of those classes either throws (for
 * classes that let the exception propagate) or is silently dropped (for
 * {@see \Whity\Core\Audit\AuditLogger}, which is deliberately fail-soft and
 * swallows the resulting PDOException).
 *
 * Any later task that constructs another pinned whity-core class directly
 * under this plugin's SQLite test double and hits the same "no such
 * function: NOW" error should reach for {@see self::registerNowFunction()}
 * rather than re-registering the UDF inline.
 *
 * Test-only: every real deployment runs on PostgreSQL, where NOW() is native
 * and this class is never loaded (it lives under tests/, excluded from the
 * live plugin deploy by host/scripts/install-plugin.ps1).
 */
final class SqlitePolyfills
{
    private function __construct()
    {
        // Static-only; never instantiated.
    }

    /**
     * Register a `NOW()` SQLite user-defined function returning the current
     * UTC time as `Y-m-d H:i:s` — the same shape a `TIMESTAMP` column expects
     * from PostgreSQL's native `NOW()`.
     *
     * Call once per PDO connection, before running migrations or exercising
     * any pinned whity-core class that hardcodes `NOW()` in its own SQL.
     */
    public static function registerNowFunction(PDO $pdo): void
    {
        $pdo->sqliteCreateFunction('NOW', static function (): string {
            return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        }, 0);
    }
}
