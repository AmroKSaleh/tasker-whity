<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use PDO;
use Whity\Sdk\MigrationInterface;

/**
 * Adds UNIQUE (tenant_id, prefix) WHERE prefix IS NOT NULL — the constraint
 * that makes a project prefix, and therefore a short id, an actual REFERENCE.
 *
 * WHY (whole-branch review finding B2): three separately-correct pieces of work
 * composed into deterministic silent data corruption. One task built short-id
 * resolution ASSUMING prefix uniqueness — {@see \Tasker\Access\IdentifierResolver}'s
 * projectByColumn() resolves a prefix with `LIMIT 1` and no `ORDER BY`. One put
 * the uniqueness check inside {@see \Tasker\Domain\PrefixDeriver} (so it only
 * ever ran on the DERIVE path). Two more exposed `prefix` as a writable field
 * on create_project and update_project, whose explicit-prefix branches
 * validated format only. Net effect: `update_project(project_id: B,
 * prefix: "TDE")` succeeded while project A already held TDE, and every later
 * complete_task("TDE-5") / update_task("TDE-5") / delete_task("TDE-5") hit
 * whichever row Postgres returned first. No concurrency required.
 *
 * The handler-side checks (ProjectsApiHandler::explicitPrefixError()) are
 * check-then-act and so cannot be the whole answer — two concurrent
 * update_project calls both pass their own SELECT. This index is what actually
 * holds the invariant, the same reasoning {@see AddTaskerTaskShortIdUnique}
 * applies to (project_id, short_id).
 *
 * PARTIAL, not plain: `WHERE prefix IS NOT NULL` is required because a null
 * prefix is a LEGITIMATE, repeatable outcome — PrefixDeriver::derive() returns
 * null once every suffix candidate is exhausted, and such a project simply has
 * no short ids. A plain UNIQUE (tenant_id, prefix) would treat that as a
 * conflict on the SECOND such project under PostgreSQL's NULLS DISTINCT
 * default only by accident of NULL semantics; being explicit says what is
 * meant. Partial indexes are supported by PostgreSQL and by SQLite (since
 * 3.8.0), so the SQLite test tier can still run this migration — the reason
 * this is an index and not a table constraint.
 *
 * PRE-EXISTING DUPLICATES: a live database may already hold them (this bug
 * shipped), and `CREATE UNIQUE INDEX` against duplicate data throws an opaque
 * "could not create unique index" naming only the index. So they are detected
 * FIRST, and this migration REFUSES with a message naming every offending row.
 *
 * Refusing rather than auto-resolving is deliberate:
 *   - The only mechanical resolution is to null the prefix on all but one row.
 *     That SILENTLY DESTROYS every short id an agent already holds for the
 *     losing project — TDE-5 stops resolving — and is unrecoverable afterwards,
 *     since nothing records which project used to own the prefix.
 *   - Which project KEEPS a contested prefix is a product decision (which one
 *     are people actually using?), not something a migration can infer.
 *     "Lowest id wins" is deterministic but arbitrary, and plausibly picks the
 *     abandoned project over the live one.
 *   - Refusing is recoverable and actionable, not permanently broken: the
 *     message names the tenant, the prefix and every project id involved, and
 *     once an operator has resolved them by hand the migration re-runs and the
 *     index goes in. A migration that destroys short ids to save an operator
 *     one query is the worse trade.
 */
final class AddTaskerProjectPrefixUnique implements MigrationInterface
{
    public function up(PDO $pdo): void
    {
        $duplicates = self::findDuplicatePrefixes($pdo);
        if ($duplicates !== []) {
            throw new \RuntimeException(
                "Cannot add UNIQUE (tenant_id, prefix) to tasker_projects: duplicate project prefixes already exist.\n"
                . implode("\n", $duplicates) . "\n"
                . 'Resolve these by hand — decide which project keeps each prefix and clear or change the others '
                . "(e.g. UPDATE tasker_projects SET prefix = NULL WHERE id = <id>), then re-run this migration.\n"
                . 'This is NOT resolved automatically on purpose: clearing a prefix destroys every short id '
                . '(e.g. TDE-5) that already refers to that project, and which project keeps a contested prefix '
                . 'cannot be inferred from the data.'
            );
        }

        $pdo->exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_projects_tenant_prefix
             ON tasker_projects (tenant_id, prefix)
             WHERE prefix IS NOT NULL'
        );
    }

    public function down(PDO $pdo): void
    {
        $pdo->exec('DROP INDEX IF EXISTS idx_tasker_projects_tenant_prefix');
    }

    /**
     * One human-readable line per offending (tenant_id, prefix) pair, naming
     * every project id that holds it.
     *
     * Two queries rather than one `string_agg`/`group_concat`: those two
     * aggregate names are PostgreSQL-only and SQLite-only respectively, and
     * this migration must run on both. The aggregate below returns nothing at
     * all in the normal (clean) case, so the per-pair id lookup never runs.
     *
     * @return list<string>
     */
    private static function findDuplicatePrefixes(PDO $pdo): array
    {
        $pairs = $pdo->query(
            'SELECT tenant_id, prefix, COUNT(*) AS duplicate_count
             FROM tasker_projects
             WHERE prefix IS NOT NULL
             GROUP BY tenant_id, prefix
             HAVING COUNT(*) > 1
             ORDER BY tenant_id, prefix'
        );
        if ($pairs === false) {
            return [];
        }

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $pairs->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            return [];
        }

        $idStmt = $pdo->prepare(
            'SELECT id FROM tasker_projects
             WHERE tenant_id = :tenant_id AND prefix = :prefix
             ORDER BY id'
        );

        $lines = [];
        foreach ($rows as $row) {
            $idStmt->execute([':tenant_id' => $row['tenant_id'], ':prefix' => $row['prefix']]);
            /** @var list<string> $ids */
            $ids = $idStmt->fetchAll(PDO::FETCH_COLUMN);

            $lines[] = sprintf(
                '  tenant_id=%s prefix=%s is held by %d projects: id %s',
                (string) $row['tenant_id'],
                (string) $row['prefix'],
                (int) $row['duplicate_count'],
                implode(', ', array_map('strval', $ids))
            );
        }

        return $lines;
    }
}
