<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD for tasker_sections.
 *
 * REGRESSION FIX (whole-branch review finding C1): list()/create() used to be
 * tenant-scoped only, on the theory that a caller can only ever learn a
 * project id by first reaching it through an OU-visible project list. That
 * reasoning is false here specifically: {projectId} is a PATH PARAMETER, not
 * something the caller had to discover, and tasker_projects.id is a plain
 * sequential BIGSERIAL — an OU-restricted caller holding tasker_structure:manage
 * could iterate project ids directly and list/create sections under ANY
 * project in the tenant. list()/create()'s parent-existence check is now
 * OU-aware (projectVisible(), below), joining straight to tasker_projects and
 * applying OuScopeResolver — the exact same static-SQL-template pattern
 * {@see ProjectsApiHandler::findScoped()} already uses. update()/delete() are
 * unaffected: they take the SECTION's own id directly (not a project id path
 * parameter), which is explicitly out of this fix's scope (a separate,
 * not-yet-decided question — see the plan's fix-wave notes).
 *
 * Postgres-only for list()/create() specifically, same reasoning as
 * ProjectsApiHandler: OuScopeResolver::whereFragment()'s `= ANY(:scope)` is
 * PostgreSQL-only syntax that SQLite's PDO::prepare() rejects outright, so
 * those two methods are exercised only against a real PostgreSQL connection
 * (see TenantIsolationOuTest). update()/delete() remain plain tenant-scoped
 * queries and keep their SQLite-backed unit test coverage.
 *
 * delete() refuses to remove a project's last remaining section — every
 * project must always have at least one, the invariant ProjectsApiHandler's
 * atomic Backlog-section creation exists to guarantee (design spec §4).
 *
 * D1b Task 12b FIX (contract parity with the original app): delete() used to
 * ALSO cascade unconditionally to a non-last section's own groups and tasks,
 * with no guard at all — the original app's own delete_section instead
 * REFUSES a non-empty section unless the caller explicitly passes
 * delete_tasks: true. Because tasker_tasks.section_id and
 * tasker_groups.section_id are both ON DELETE CASCADE (see
 * CreateTaskerTasksTable/CreateTaskerGroupsTable), the identical
 * `delete_section({project_id, section_id})` call an original-app agent
 * makes routinely — a REFUSAL there — silently destroyed every task and
 * group in the section here. $deleteTasks now gates that cascade: false (the
 * default) refuses with a count of what would be destroyed when the section
 * still has tasks or groups; true proceeds and lets the FK cascade do its
 * work, exactly like deleting a whole project already implies deleting
 * everything under it.
 *
 * REVIEW FIX (post-merge): the delete_tasks:false guard's first version was
 * check-then-act — COUNT tasks/groups, THEN a separate DELETE — leaving a
 * window where a task created between the two statements would be silently
 * destroyed by the FK cascade with no refusal at all, the exact bug this
 * whole fix exists to prevent, reopened by its own two-step implementation.
 * The guard and the delete are now ONE atomic statement (see delete()'s own
 * comment): the DELETE's own WHERE clause carries the emptiness check via
 * correlated NOT EXISTS subqueries, so a row it does not see as empty simply
 * is not deleted — no separate round trip, no window. This codebase already
 * avoids SELECT ... FOR UPDATE / advisory locks for Postgres/SQLite
 * portability (see {@see \Tasker\Domain\ShortIdAllocator}'s own docblock);
 * folding the check into the mutating statement itself is the same kind of
 * portable, lock-free technique, applied to a DELETE-guard race instead of
 * ShortIdAllocator's INSERT-race.
 */
final class SectionsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function list(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        if (!$this->projectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        $idCol = $this->idColumn();
        $stmt = $this->db->prepare(
            "SELECT {$idCol} AS id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs, created_at
             FROM tasker_sections WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, {$idCol} ASC"
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return Response::json(['data' => array_map([$this, 'toPublicSection'], $rows)], 200);
    }

    public function create(int $tenantId, ?int $callerOuId, int $projectId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        if (!$this->projectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        $slug = self::slugify($name);

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :project_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':project_id' => $projectId,
                ':name' => $name,
                ':slug' => $slug,
            ]);

            // lastInsertId() is the row's true identity on BOTH engines
            // (SQLite's rowid; PostgreSQL's BIGSERIAL sequence via lastval()),
            // but findScoped() must look it up through the SAME column this
            // value actually came from — see idColumn()'s doc for why that is
            // not always the literal "id" column.
            $id = (int) $this->db->lastInsertId();
            $row = $this->findScoped($id, $tenantId);
            if ($row === null) {
                return Response::error('Failed to create section', 500);
            }

            return Response::json(['data' => $this->toPublicSection($row)], 201);
        } catch (\Throwable $e) {
            if (self::isUniqueViolation($e)) {
                return Response::error('A section with this name already exists', 409);
            }

            return Response::error('Failed to create section', 500);
        }
    }

    public function update(int $tenantId, int $sectionId, string $body): Response
    {
        $row = $this->findScoped($sectionId, $tenantId);
        if ($row === null) {
            return Response::error('Section not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $sectionId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (array_key_exists('description', $decoded)) {
            $fields[] = 'description = :description';
            $params[':description'] = $decoded['description'] !== null ? (string) $decoded['description'] : null;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }
        if (array_key_exists('view_prefs', $decoded)) {
            $encoded = json_encode($decoded['view_prefs']);
            $fields[] = 'view_prefs = :view_prefs';
            $params[':view_prefs'] = $encoded === false ? null : $encoded;
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicSection($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_sections SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($sectionId, $tenantId);
            if ($updated === null) {
                return Response::error('Section not found', 404);
            }

            return Response::json(['data' => $this->toPublicSection($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update section', 500);
        }
    }

    /**
     * $deleteTasks defaults to false, matching the original app's own
     * delete_section default — see this class's own docblock for why that
     * default changed here (it used to always cascade).
     */
    public function delete(int $tenantId, int $sectionId, bool $deleteTasks = false): Response
    {
        $row = $this->findScoped($sectionId, $tenantId);
        if ($row === null) {
            return Response::error('Section not found', 404);
        }

        $countStmt = $this->db->prepare(
            'SELECT COUNT(*) FROM tasker_sections WHERE project_id = :project_id AND tenant_id = :tenant_id'
        );
        $countStmt->execute([':project_id' => $row['project_id'], ':tenant_id' => $tenantId]);
        if ((int) $countStmt->fetchColumn() <= 1) {
            return Response::error('Cannot delete a project\'s last remaining section', 409);
        }

        try {
            if ($deleteTasks) {
                $stmt = $this->db->prepare("DELETE FROM tasker_sections WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id");
                $stmt->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);

                return Response::json(null, 204);
            }

            // ATOMIC GUARD (see this class's own docblock, "REVIEW FIX
            // (post-merge)"): the emptiness check lives in THIS statement's
            // own WHERE clause via correlated NOT EXISTS subqueries, not a
            // separate SELECT COUNT(*) beforehand — a task/group created
            // after such a count but before a separate DELETE would be
            // silently destroyed by the FK cascade with no refusal, which is
            // exactly the bug this whole guard exists to close. Every
            // placeholder is bound under its OWN distinct name even though
            // several share the same value ($sectionId three times,
            // $tenantId three times) — pdo_pgsql rejects reusing one named
            // placeholder twice under a native prepare (the same reason
            // {@see \Tasker\Access\IdentifierResolver}'s taskByColumn()/
            // resolveStructural() bind `:tenant_id`/`:tenant_id_p` separately
            // rather than repeating one name).
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "DELETE FROM tasker_sections
                 WHERE {$idCol} = :id AND tenant_id = :tenant_id
                   AND NOT EXISTS (SELECT 1 FROM tasker_tasks WHERE section_id = :id_t AND tenant_id = :tenant_id_t)
                   AND NOT EXISTS (SELECT 1 FROM tasker_groups WHERE section_id = :id_g AND tenant_id = :tenant_id_g)"
            );
            $stmt->execute([
                ':id' => $sectionId,
                ':tenant_id' => $tenantId,
                ':id_t' => $sectionId,
                ':tenant_id_t' => $tenantId,
                ':id_g' => $sectionId,
                ':tenant_id_g' => $tenantId,
            ]);

            if ($stmt->rowCount() > 0) {
                return Response::json(null, 204);
            }

            // Zero rows affected: either the section is non-empty (the
            // guard refused, the expected/common case) or it vanished
            // between findScoped() above and this statement (a concurrent
            // delete — rare, but distinguished here rather than reporting a
            // misleading "has tasks" refusal for a section that is simply
            // gone).
            $taskCount = $this->countIn('tasker_tasks', $sectionId, $tenantId);
            $groupCount = $this->countIn('tasker_groups', $sectionId, $tenantId);
            if ($taskCount === 0 && $groupCount === 0) {
                return Response::error('Section not found', 404);
            }

            return Response::error(
                sprintf(
                    'Refused: section has %d task(s) and %d group(s). Move them to another section first '
                        . '(e.g. via update_task/move_task_to_group), or pass delete_tasks: true to delete the '
                        . 'section together with all its tasks and groups.',
                    $taskCount,
                    $groupCount
                ),
                409
            );
        } catch (\Throwable) {
            return Response::error('Failed to delete section', 500);
        }
    }

    /**
     * Row count in $table for $sectionId, tenant-scoped. $table is never
     * caller-supplied (only 'tasker_tasks'/'tasker_groups' from delete()
     * above), so interpolating it into the static SQL text is safe — the
     * same "column/table name comes from code, never from input" rule this
     * codebase applies everywhere else (see e.g. idColumn()'s own use above).
     */
    private function countIn(string $table, int $sectionId, int $tenantId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM {$table} WHERE section_id = :section_id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':section_id' => $sectionId, ':tenant_id' => $tenantId]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * Whether $projectId exists, belongs to $tenantId, AND is within
     * $callerOuId's OU-descendant scope — byte-for-byte the same query shape
     * as {@see ProjectsApiHandler::findScoped()}: one static SQL template via
     * {@see OuScopeResolver::whereFragment()}, called unconditionally (never a
     * runtime-branched query). See this class's own docblock for why this
     * confines list()/create() to a real PostgreSQL connection.
     */
    private function projectVisible(int $tenantId, ?int $callerOuId, int $projectId): bool
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT 1 FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        return $stmt->fetch() !== false;
    }

    /**
     * Whether $e was thrown for a unique-constraint violation (PostgreSQL
     * SQLSTATE 23505) — e.g. a duplicate (project_id, slug), the
     * always-reproducible "Backlog" auto-collision case. Duplicated per
     * handler rather than shared — see
     * {@see ProjectsApiHandler::isUniqueViolation()}'s own doc for why.
     */
    private static function isUniqueViolation(\Throwable $e): bool
    {
        return $e instanceof \PDOException && $e->getCode() === '23505';
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $idCol = $this->idColumn();
        $stmt = $this->db->prepare(
            "SELECT {$idCol} AS id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs, created_at
             FROM tasker_sections WHERE {$idCol} = :id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * The physical column every id-keyed SELECT/UPDATE/DELETE above matches
     * against.
     *
     * On PostgreSQL (production; see CreateTaskerSectionsTable) `id
     * BIGSERIAL PRIMARY KEY` populates the real `id` column and
     * PDO::lastInsertId() (via lastval()) reads it back correctly — `id` is
     * always right there.
     *
     * Under the in-memory SQLite double this plugin's own unit tests run
     * against, SQLite only aliases a primary key column to its own rowid
     * when the column's declared type is the LITERAL string "INTEGER" (case
     * insensitive) — see https://www.sqlite.org/lang_createtable.html#rowid.
     * "BIGSERIAL" (a PostgreSQL-only type name SQLite happily accepts but
     * does not recognise) does not qualify, so a row inserted without
     * specifying `id` gets a real, permanent NULL in its `id` column, while
     * PDO::lastInsertId() still faithfully reports SQLite's own always-present
     * `rowid`. A later `WHERE id = :id` lookup keyed off that value then
     * matches nothing — confirmed empirically: a fresh INSERT followed by
     * `SELECT * FROM tasker_sections WHERE id = :id` using lastInsertId()
     * returns no row, while `WHERE rowid = :id` finds it immediately.
     * Consequently every id-keyed statement in this class (not just the
     * lookup right after create()) must key off `rowid` on SQLite so a
     * caller's create()-returned id round-trips correctly through
     * update()/delete() within the same test run.
     *
     * Mirrors the identical id/rowid branch already established in
     * {@see \Tasker\Api\PingApiHandler::tag()} for the exact same reason.
     */
    private function idColumn(): string
    {
        return $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? 'rowid' : 'id';
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');

        return $slug === '' ? 'section' : $slug;
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicSection(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'projectId' => (int) $row['project_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'description' => $row['description'],
            'sortOrder' => (int) $row['sort_order'],
            'viewPrefs' => $row['view_prefs'] !== null ? (json_decode((string) $row['view_prefs'], true) ?? null) : null,
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
