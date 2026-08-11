<?php

declare(strict_types=1);

namespace Tasker\Access;

use PDO;

/**
 * Turns whatever an agent passes into an internal integer id.
 *
 * The original Tasker's agents do not send integer ids. They send UUIDs,
 * short ids like TDE-31, project prefixes, slugs, or nothing at all (falling
 * back to a default project). Preserving that contract is the whole point of
 * this slice, and this class is where it happens.
 *
 * PRECEDENCE is fixed and evaluated in order; the first match wins:
 *   1. integer          ^\d+$                -> id
 *   2. uuid             RFC 4122 shape       -> public_id
 *   3. short id         ^[A-Z]{2,5}-\d+$     -> project prefix + task short_id
 *   4. prefix           ^[A-Z]{2,5}$         -> project prefix
 *   5. slug             anything else        -> slug
 *   6. empty            null/''              -> caller's default project
 *
 * Ambiguity is ACCEPTED, not prevented: a project whose slug is "TDE" while
 * another's prefix is "TDE" resolves to the prefix match, silently. This is a
 * deliberate trade — deterministic and documented in each tool description,
 * rather than an ambiguity error that would break callers who work today.
 *
 * SCOPING is the security-critical part. Every resolution is tenant-scoped AND
 * OU-scoped via OuScopeResolver, using its single static SQL template. An
 * identifier that exists but sits outside the caller's scope resolves to null,
 * which callers turn into the same 404 as "absent" — so this can never be used
 * as an existence oracle.
 *
 * This matters more than it did in D1. Flattening routes removed the
 * structural enforcement point: /projects/{projectId}/sections forced a
 * project lookup, and that lookup carried the OU check. With project_id
 * optional, this class is the ONLY barrier between a caller and cross-OU data.
 */
final class IdentifierResolver
{
    private const UUID_PATTERN     = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const SHORT_ID_PATTERN = '/^[A-Z]{2,5}-\d+$/';
    private const PREFIX_PATTERN   = '/^[A-Z]{2,5}$/';

    /**
     * Which form is this? Pure — no database, no scoping. Callers use it to
     * decide which lookup to run, and to distinguish a malformed short id
     * (400) from a genuine miss (404).
     *
     * @return 'empty'|'integer'|'uuid'|'short_id'|'prefix'|'slug'|'malformed_short_id'
     */
    public static function classify(string|int|null $raw): string
    {
        if ($raw === null) {
            return 'empty';
        }

        $value = trim((string) $raw);
        if ($value === '') {
            return 'empty';
        }

        if (preg_match('/^\d+$/', $value) === 1) {
            return 'integer';
        }

        if (preg_match(self::UUID_PATTERN, $value) === 1) {
            return 'uuid';
        }

        if (preg_match(self::SHORT_ID_PATTERN, $value) === 1) {
            return 'short_id';
        }

        // Looks like a short id but is not one: PREFIX-<not digits>. Caught
        // before the slug fallback so a typo surfaces as 400, not a puzzling
        // 404 from a slug lookup that was never going to match.
        if (preg_match('/^[A-Z]{2,5}-/', $value) === 1) {
            return 'malformed_short_id';
        }

        if (preg_match(self::PREFIX_PATTERN, $value) === 1) {
            return 'prefix';
        }

        return 'slug';
    }

    /**
     * Resolve a project identifier to tasker_projects.id, OU-scoped.
     *
     * $defaultProjectId is the caller's tasker_user_prefs.default_project_id
     * and is used only when $raw is empty — that is what makes project_id
     * optional on list_tasks and friends, matching the original.
     */
    public static function resolveProject(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $defaultProjectId = null
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty') {
            // Re-resolve the default through the same scoped query rather
            // than trusting the stored id: the project may have moved OU, or
            // been deleted, since the preference was set.
            return $defaultProjectId === null
                ? null
                : self::projectByColumn($db, $tenantId, $callerOuId, 'id', (string) $defaultProjectId);
        }

        if ($form === 'malformed_short_id') {
            return null;
        }

        // A short id names a TASK, but its leading segment names the project.
        if ($form === 'short_id') {
            [$prefix] = explode('-', $value, 2);
            return self::projectByColumn($db, $tenantId, $callerOuId, 'prefix', $prefix);
        }

        $column = match ($form) {
            'integer' => 'id',
            'uuid'    => 'public_id',
            'prefix'  => 'prefix',
            default   => 'slug',
        };

        return self::projectByColumn($db, $tenantId, $callerOuId, $column, $value);
    }

    /**
     * One static SQL template, parameterised by column name only.
     *
     * $column is NEVER caller-supplied — it comes from the match() above, so
     * interpolating it is safe. The tenant predicate and the OU fragment are
     * unconditional text, exactly as the architecture requires.
     */
    private static function projectByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $column,
        string $value
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $db->prepare(
            "SELECT id FROM tasker_projects
             WHERE {$column} = :value AND tenant_id = :tenant_id AND {$ouClause}
             LIMIT 1"
        );
        $stmt->bindValue(':value', $value);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    /**
     * Resolve a task identifier. A short id (TDE-31) resolves through its
     * project's prefix, so it is unambiguous across projects.
     */
    public static function resolveTask(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty' || $form === 'malformed_short_id') {
            return null;
        }

        if ($form === 'short_id') {
            [$prefix, $shortId] = explode('-', $value, 2);

            $projectId = self::projectByColumn($db, $tenantId, $callerOuId, 'prefix', $prefix);
            if ($projectId === null) {
                return null;
            }

            $stmt = $db->prepare(
                'SELECT id FROM tasker_tasks
                 WHERE project_id = :project_id AND short_id = :short_id AND tenant_id = :tenant_id
                 LIMIT 1'
            );
            $stmt->execute([
                ':project_id' => $projectId,
                ':short_id'   => (int) $shortId,
                ':tenant_id'  => $tenantId,
            ]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        // Tasks have no slug and no prefix, so anything else is an id or UUID.
        if ($form === 'prefix' || $form === 'slug') {
            return null;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';

        return self::taskByColumn($db, $tenantId, $callerOuId, $column, $value);
    }

    /**
     * Task lookup, OU-scoped by joining through to the owning project.
     *
     * Tasks carry no ou_id of their own — only tasker_projects does — so OU
     * scoping has to travel via project_id. Every identifier form must be
     * equally safe: it would be worse than useless if TDE-31 respected the OU
     * boundary while the same task's UUID walked straight past it, because the
     * boundary would appear to work in testing and leak in practice.
     */
    private static function taskByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $column,
        string $value
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $db->prepare(
            "SELECT t.id FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.{$column} = :value
               AND t.tenant_id = :tenant_id
               AND p.tenant_id = :tenant_id_p
               AND {$ouClause}
             LIMIT 1"
        );
        $stmt->bindValue(':value', $value);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    public static function resolveSection(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $projectId = null
    ): ?int {
        return self::resolveStructural($db, $tenantId, $callerOuId, $raw, 'tasker_sections', 'project_id', $projectId);
    }

    public static function resolveGroup(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $sectionId = null
    ): ?int {
        return self::resolveStructural($db, $tenantId, $callerOuId, $raw, 'tasker_groups', 'section_id', $sectionId);
    }

    /**
     * Sections and groups share a shape: id | public_id | slug, with slug
     * unique only within a parent, so a slug lookup needs that parent.
     */
    private static function resolveStructural(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        string $table,
        string $parentColumn,
        ?int $parentId
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty' || $form === 'malformed_short_id' || $form === 'short_id') {
            return null;
        }

        if ($form === 'slug' || $form === 'prefix') {
            // A slug is only unique within its parent; without one it is
            // genuinely ambiguous, so refuse rather than guess.
            if ($parentId === null) {
                return null;
            }

            $stmt = $db->prepare(
                "SELECT id FROM {$table}
                 WHERE slug = :slug AND {$parentColumn} = :parent_id AND tenant_id = :tenant_id
                 LIMIT 1"
            );
            $stmt->execute([
                ':slug'      => strtolower($value),
                ':parent_id' => $parentId,
                ':tenant_id' => $tenantId,
            ]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';
        $stmt = $db->prepare(
            "SELECT id FROM {$table} WHERE {$column} = :value AND tenant_id = :tenant_id LIMIT 1"
        );
        $stmt->execute([':value' => $value, ':tenant_id' => $tenantId]);
        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    /**
     * Milestones accept an INDEX (positional, 0-based, within the task's
     * ordered milestones) as well as an id or UUID.
     *
     * The index form exists because the original stored milestones as a jsonb
     * array and its tools address them positionally
     * (uncomplete_milestone { task_id, index }). It is inherently racy under
     * concurrent reordering — two agents can have the same index land on
     * different rows — so tool descriptions state that ids are preferred.
     * Supported for compatibility, not recommended.
     */
    public static function resolveMilestone(
        PDO $db,
        int $tenantId,
        int $taskId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'uuid') {
            $stmt = $db->prepare(
                'SELECT id FROM tasker_milestones
                 WHERE public_id = :value AND task_id = :task_id AND tenant_id = :tenant_id LIMIT 1'
            );
            $stmt->execute([':value' => $value, ':task_id' => $taskId, ':tenant_id' => $tenantId]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        if ($form !== 'integer') {
            return null;
        }

        // An integer is ambiguous: a milestone id, or a position? Prefer the
        // id — it is stable — and fall back to the index only if no milestone
        // with that id belongs to this task.
        $byId = $db->prepare(
            'SELECT id FROM tasker_milestones
             WHERE id = :value AND task_id = :task_id AND tenant_id = :tenant_id LIMIT 1'
        );
        $byId->execute([':value' => (int) $value, ':task_id' => $taskId, ':tenant_id' => $tenantId]);
        $found = $byId->fetchColumn();
        if ($found !== false) {
            return (int) $found;
        }

        $ordered = $db->prepare(
            'SELECT id FROM tasker_milestones
             WHERE task_id = :task_id AND tenant_id = :tenant_id
             ORDER BY sort_order ASC, id ASC'
        );
        $ordered->execute([':task_id' => $taskId, ':tenant_id' => $tenantId]);
        /** @var list<int> $ids */
        $ids = array_map('intval', $ordered->fetchAll(PDO::FETCH_COLUMN));

        return $ids[(int) $value] ?? null;
    }
}
