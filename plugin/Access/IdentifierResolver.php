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
 *   1. integer          ^\d+$                     -> id
 *   2. uuid             RFC 4122 shape            -> public_id
 *   3. flow short id    ^[A-Za-z]{2,5}-F\d+$ (ci) -> project prefix + flow short_id
 *   4. short id         ^[A-Z]{2,5}-\d+$          -> project prefix + task short_id
 *   5. prefix           ^[A-Z]{2,5}$              -> project prefix
 *   6. slug             anything else             -> slug
 *   7. empty            null/''                   -> caller's default project
 *
 * Form 3 (flow short id, D5a Task 4) MUST be tested before form 4 (task short
 * id): TDE-F1 is not all-digits after the dash, so it would never match form
 * 4 directly, but without its own check it would be swallowed by the generic
 * "looks like a short id but isn't" malformed catch-all below form 4, rather
 * than being recognised as a flow.
 *
 * Ambiguity is ACCEPTED, not prevented: a project whose slug is "TDE" while
 * another's prefix is "TDE" resolves to the prefix match, silently. This is a
 * deliberate trade — deterministic and documented in each tool description,
 * rather than an ambiguity error that would break callers who work today.
 *
 * D5a Task 4 (review finding) adds a second instance of that same accepted
 * trade-off: the flow-short-id pattern is deliberately case-insensitive (the
 * brief mandates TDE-F1 and tde-f12 both resolve), which widens what counts
 * as "flow-shaped" beyond what an uppercase-only pattern would catch — a
 * slug like "ab-f1", "off-f2", or "alpha-f10" now classifies as
 * 'flow_short_id' rather than 'slug', and "tde-f" now classifies as
 * 'malformed_short_id' rather than 'slug'. No real project slug is expected
 * to collide with PREFIX-F<digits> shape in practice, and the failure mode
 * if one ever does is the same deterministic, documented one the
 * prefix/slug collision above already accepts — a clean miss, not data
 * leaking across a boundary — so this is accepted rather than guarded
 * against.
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

    // Flows: PREFIX-F<n>, e.g. TDE-F1 or tde-f12 — case-insensitive, unlike
    // SHORT_ID_PATTERN above, so both classify() and resolveFlow() accept
    // either case for the letters (the "F" literal included).
    private const FLOW_SHORT_ID_PATTERN  = '/^[A-Za-z]{2,5}-F\d+$/i';
    private const MALFORMED_FLOW_PATTERN = '/^[A-Za-z]{2,5}-F$/i';

    /**
     * Which form is this? Pure — no database, no scoping. Callers use it to
     * decide which lookup to run, and to distinguish a malformed short id
     * (400) from a genuine miss (404).
     *
     * @return 'empty'|'integer'|'uuid'|'flow_short_id'|'short_id'|'prefix'|'slug'|'malformed_short_id'
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

        // A flow: PREFIX-F<n>, e.g. TDE-F1. MUST be tested before the task
        // short-id pattern (and its malformed catch-all) below, which would
        // otherwise swallow "TDE-F1" as a malformed task short id instead of
        // recognising it as its own form.
        if (preg_match(self::FLOW_SHORT_ID_PATTERN, $value) === 1) {
            return 'flow_short_id';
        }

        // PREFIX-F with no digits is a malformed flow id, NOT a slug. Without
        // this, "TDE-F" resolves as a slug lookup that silently finds nothing
        // instead of telling the caller their identifier is wrong.
        if (preg_match(self::MALFORMED_FLOW_PATTERN, $value) === 1) {
            return 'malformed_short_id';
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

        // REVIEW FIX (D5a Task 4 round 3): allowlist, not denylist. Tasks are
        // addressable only via 'short_id' (handled above), 'integer', or
        // 'uuid'. Everything else -- 'empty', 'malformed_short_id', 'prefix',
        // 'slug', and classify()'s NEW 'flow_short_id' form -- is not a task
        // identifier and resolves to null. The previous denylist here
        // (`'prefix'`/`'slug'` only) predated 'flow_short_id' and let it fall
        // through to `$column = 'id'` below, binding a non-numeric string
        // like "TDE-F1" to a bigint column and raising an uncaught
        // PDOException instead of a clean 404 -- the exact bug resolveFlow()
        // was fixed for, reopened here by the same classify() change. An
        // allowlist stays correct the next time classify() grows an eighth
        // form; a denylist needs updating in lockstep every time.
        if ($form !== 'integer' && $form !== 'uuid') {
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

    /**
     * Resolve a flow identifier. Mirrors resolveTask()'s structure exactly:
     * a flow short id (TDE-F1) resolves through its project's prefix, so it
     * is unambiguous across projects, and every form is OU-scoped by joining
     * through to the owning project — flows carry no ou_id of their own.
     */
    public static function resolveFlow(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'flow_short_id') {
            // Split on the first "-" (not the literal "-F", which would miss
            // a lowercase match like "tde-f12"): the remainder always starts
            // with the "F"/"f" marker, so stripping its first character
            // leaves the digits. Mirrors resolveTask()'s own
            // explode('-', $value, 2) for the task short-id form.
            [$prefix, $withMarker] = explode('-', $value, 2);

            return self::flowByPrefixAndShortId(
                $db,
                $tenantId,
                $callerOuId,
                strtoupper($prefix),
                (int) substr($withMarker, 1)
            );
        }

        // CRITICAL FIX (review finding): only 'integer' and 'uuid' remain as
        // flow identifiers below. Everything else -- 'empty',
        // 'malformed_short_id', a well-formed TASK 'short_id' (e.g. CNF-31),
        // 'prefix', 'slug' -- is not a flow identifier and resolves to null,
        // so the route answers 404. This is an ALLOWLIST, not a denylist of
        // the forms known to be wrong at the time this was written: the
        // previous denylist (only 'prefix'/'slug') let classify()'s
        // pre-existing 'short_id' form fall through to `$column = 'id'`
        // below, binding a raw string like "CNF-31" to f.id (bigint) and
        // raising an uncaught PDOException instead of returning null -- a
        // realistic, non-adversarial mistake (an agent confusing a task id
        // with a flow id), not an adversarial probe. An allowlist stays
        // correct the next time classify() grows a form; a denylist would
        // need updating in lockstep every time, and silently reopen this
        // exact bug if that update were missed.
        if ($form !== 'integer' && $form !== 'uuid') {
            return null;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';

        return self::flowByColumn($db, $tenantId, $callerOuId, $column, $value);
    }

    /**
     * Flow lookup by id/public_id, OU-scoped by joining through to the
     * owning project — the same shape as taskByColumn(), one static template
     * shared by both the 'integer' and 'uuid' forms via $column, which is
     * never caller-supplied.
     */
    private static function flowByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $column,
        string $value
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $db->prepare(
            "SELECT f.id FROM tasker_flows f
             JOIN tasker_projects p ON p.id = f.project_id
             WHERE f.{$column} = :value
               AND f.tenant_id = :tenant_id
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

    /**
     * Flow lookup by its F-prefixed short id (TDE-F1): one static template
     * joining straight to tasker_projects on prefix, rather than resolving
     * the project first and querying tasker_flows separately — $prefix and
     * $shortId are both derived internally in resolveFlow(), never
     * caller-supplied text reaching SQL.
     */
    private static function flowByPrefixAndShortId(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $prefix,
        int $shortId
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $db->prepare(
            "SELECT f.id FROM tasker_flows f
             JOIN tasker_projects p ON p.id = f.project_id
             WHERE UPPER(p.prefix) = :prefix
               AND f.short_id = :short_id
               AND f.tenant_id = :tenant_id
               AND p.tenant_id = :tenant_id_p
               AND {$ouClause}
             LIMIT 1"
        );
        $stmt->bindValue(':prefix', $prefix, PDO::PARAM_STR);
        $stmt->bindValue(':short_id', $shortId, PDO::PARAM_INT);
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
        return self::resolveStructural(
            $db,
            $tenantId,
            $callerOuId,
            $raw,
            'tasker_sections',
            'project_id',
            $projectId,
            'JOIN tasker_projects p ON p.id = t.project_id'
        );
    }

    public static function resolveGroup(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $sectionId = null
    ): ?int {
        return self::resolveStructural(
            $db,
            $tenantId,
            $callerOuId,
            $raw,
            'tasker_groups',
            'section_id',
            $sectionId,
            'JOIN tasker_sections s ON s.id = t.section_id JOIN tasker_projects p ON p.id = s.project_id'
        );
    }

    /**
     * Sections and groups share a shape: id | public_id | slug, with slug
     * unique only within a parent, so a slug lookup needs that parent.
     *
     * Neither table carries its own ou_id — only tasker_projects does — so
     * $projectJoin walks from $table (aliased "t") up to tasker_projects
     * (aliased "p"): one hop for a section, two for a group. Every branch
     * (id, UUID, AND slug) applies OuScopeResolver::whereFragment('p.ou_id')
     * unconditionally, on the SAME static SQL template, exactly like
     * taskByColumn() — a resolver that enforced this for tasks' short ids but
     * not for sections/groups reached by id or UUID would be a boundary that
     * tests clean and leaks in production.
     *
     * tenant_id is bound on BOTH $table and tasker_projects, under distinct
     * placeholder names — pdo_pgsql rejects reusing one named placeholder
     * twice under a native prepare, the same reason taskByColumn() binds
     * :tenant_id and :tenant_id_p separately.
     */
    private static function resolveStructural(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        string $table,
        string $parentColumn,
        ?int $parentId,
        string $projectJoin
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        // REVIEW FIX (D5a Task 4 round 3): allowlist, not denylist. Sections
        // and groups are addressable only via 'slug'/'prefix' (ambiguous
        // slug lookup, below) or 'integer'/'uuid' (id lookup, further
        // below). Everything else -- 'empty', 'malformed_short_id',
        // 'short_id' (short ids name a TASK, not a section/group), and
        // classify()'s NEW 'flow_short_id' form -- is not a section/group
        // identifier and resolves to null. The previous denylist here
        // (only 'empty'/'malformed_short_id'/'short_id') predated
        // 'flow_short_id' and let it fall through to `$column = 'id'`
        // further below, binding a non-numeric string like "TDE-F1" to a
        // bigint column and raising an uncaught PDOException instead of a
        // clean 404 -- the same bug resolveFlow() and resolveTask() were
        // fixed for, reopened here by the same classify() change.
        if ($form !== 'slug' && $form !== 'prefix' && $form !== 'uuid' && $form !== 'integer') {
            return null;
        }

        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        if ($form === 'slug' || $form === 'prefix') {
            // A slug is only unique within its parent; without one it is
            // genuinely ambiguous, so refuse rather than guess.
            if ($parentId === null) {
                return null;
            }

            $stmt = $db->prepare(
                "SELECT t.id FROM {$table} t
                 {$projectJoin}
                 WHERE t.slug = :slug AND t.{$parentColumn} = :parent_id
                   AND t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}
                 LIMIT 1"
            );
            $stmt->bindValue(':slug', strtolower($value));
            $stmt->bindValue(':parent_id', $parentId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
            $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
            $stmt->execute();
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';
        $stmt = $db->prepare(
            "SELECT t.id FROM {$table} t
             {$projectJoin}
             WHERE t.{$column} = :value
               AND t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}
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

    /**
     * Resolve a milestone by ID/UUID ONLY — never positionally.
     *
     * D1b Task 12b FIX: this used to be one method (`resolveMilestone()`)
     * that tried an id lookup FIRST and fell back to the ordinal position
     * only when no milestone with that integer id existed under the task.
     * That made `index` and `milestone_id` share one ambiguous resolution
     * path, and for any task whose milestone ids land in the low integers —
     * the normal case for early rows — an original-shaped positional call
     * (`complete_milestone({task_id, index: 1})`) silently completed the
     * milestone with id 1 instead of the second milestone. Split into two
     * methods with NO cross-fallback in either direction: this one only ever
     * matches `id` or `public_id`, so `milestone_id` is unambiguous and
     * stable under reordering — the property this backend recommends over
     * `index` in the first place. See {@see self::resolveMilestoneByIndex()}
     * for the positional counterpart.
     */
    public static function resolveMilestoneById(
        PDO $db,
        int $tenantId,
        int $taskId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form !== 'uuid' && $form !== 'integer') {
            return null;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';
        $stmt = $db->prepare(
            "SELECT id FROM tasker_milestones
             WHERE {$column} = :value AND task_id = :task_id AND tenant_id = :tenant_id LIMIT 1"
        );
        $stmt->execute([':value' => $value, ':task_id' => $taskId, ':tenant_id' => $tenantId]);
        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    /**
     * Resolve a milestone by POSITION ONLY — never by id.
     *
     * D1b Task 12b FIX: the positional counterpart of
     * {@see self::resolveMilestoneById()}, split out of the same formerly
     * id-first `resolveMilestone()` — see that method's docblock for why the
     * old combined resolution was unsafe. `index` is 0-based, matching the
     * original app's own documented convention exactly (its milestones lived
     * in a jsonb array addressed positionally); this never consults `id` at
     * all, so a value that happens to also be a real milestone id under this
     * task is not treated specially — it is purely an offset into the task's
     * milestones ordered by (sort_order, id).
     *
     * Inherently racy under concurrent reordering — two callers can have the
     * same index land on different rows after a third reorders between their
     * calls — so tool descriptions state that `milestone_id` is preferred.
     * Supported for compatibility, not recommended.
     */
    public static function resolveMilestoneByIndex(
        PDO $db,
        int $tenantId,
        int $taskId,
        string|int|null $raw
    ): ?int {
        if (self::classify($raw) !== 'integer') {
            return null;
        }

        $ordered = $db->prepare(
            'SELECT id FROM tasker_milestones
             WHERE task_id = :task_id AND tenant_id = :tenant_id
             ORDER BY sort_order ASC, id ASC'
        );
        $ordered->execute([':task_id' => $taskId, ':tenant_id' => $tenantId]);
        /** @var list<int> $ids */
        $ids = array_map('intval', $ordered->fetchAll(PDO::FETCH_COLUMN));

        return $ids[(int) trim((string) $raw)] ?? null;
    }
}
