<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * REGRESSION FIX (whole-branch review finding I7): listForTask() used to have
 * NO existence check on its parent {taskId} at all — a nonexistent or
 * cross-tenant task returned `200 []` instead of 404, unlike
 * SectionsApiHandler::list()/GroupsApiHandler::list(). It now 404s for a
 * missing/cross-tenant parent, tenant-scoped only (list_milestones by task id
 * is explicitly NOT part of finding C1's OU-scoping fix — only its sibling
 * add_milestone route is; see create()'s own doc).
 *
 * REGRESSION FIX (whole-branch review finding C1): create()'s task-existence
 * check used to be tenant-scoped only, even though {taskId} is a path
 * parameter. It is now OU-aware, joining through tasker_tasks to
 * tasker_projects (the only table with an ou_id column) and applying
 * OuScopeResolver there — confines create() to a real PostgreSQL connection
 * (see TenantIsolationOuTest). listForTask() deliberately stays tenant-only
 * per I7's own note above.
 */
final class MilestonesApiHandler
{
    private const MAX_SUMMARY_LENGTH = 1000;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function listForTask(int $tenantId, int $taskId): Response
    {
        if (!$this->taskExistsInTenant($tenantId, $taskId)) {
            return Response::error('Task not found', 404);
        }

        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "SELECT {$idCol} AS id, public_id, tenant_id, task_id, summary, detail, checked, sort_order, created_at
                 FROM tasker_milestones
                 WHERE tenant_id = :tenant_id AND task_id = :task_id
                 ORDER BY sort_order ASC, {$idCol} ASC"
            );
            $stmt->execute([':tenant_id' => $tenantId, ':task_id' => $taskId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicMilestone'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch milestones', 500);
        }
    }

    public function create(int $tenantId, ?int $callerOuId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $summary = is_array($decoded) ? trim((string) ($decoded['summary'] ?? '')) : '';
        if ($summary === '' || mb_strlen($summary) > self::MAX_SUMMARY_LENGTH) {
            return Response::error('summary must be a non-empty string of at most ' . self::MAX_SUMMARY_LENGTH . ' characters', 400);
        }
        $sortOrder = is_array($decoded) && isset($decoded['sort_order']) ? (int) $decoded['sort_order'] : 0;

        if (!$this->taskVisible($tenantId, $callerOuId, $taskId)) {
            return Response::error('Task not found', 404);
        }

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_milestones (public_id, tenant_id, task_id, summary, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :task_id, :summary, :sort_order, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':task_id' => $taskId,
                ':summary' => $summary,
                ':sort_order' => $sortOrder,
            ]);

            // lastInsertId() is the row's true identity on BOTH engines
            // (SQLite's rowid; PostgreSQL's BIGSERIAL sequence via
            // lastval()), but findScoped() must look it up through the SAME
            // column this value actually came from — see idColumn()'s doc.
            $id = (int) $this->db->lastInsertId();
            $row = $this->findScoped($id, $tenantId);
            if ($row === null) {
                return Response::error('Failed to create milestone', 500);
            }

            return Response::json(['data' => $this->toPublicMilestone($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create milestone', 500);
        }
    }

    public function update(int $tenantId, int $milestoneId, string $body): Response
    {
        $row = $this->findScoped($milestoneId, $tenantId);
        if ($row === null) {
            return Response::error('Milestone not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $milestoneId, ':tenant_id' => $tenantId];

        if (array_key_exists('summary', $decoded)) {
            $summary = trim((string) $decoded['summary']);
            if ($summary === '' || mb_strlen($summary) > self::MAX_SUMMARY_LENGTH) {
                return Response::error('summary must be a non-empty string of at most ' . self::MAX_SUMMARY_LENGTH . ' characters', 400);
            }
            $fields[] = 'summary = :summary';
            $params[':summary'] = $summary;
        }
        if (array_key_exists('detail', $decoded)) {
            $fields[] = 'detail = :detail';
            $params[':detail'] = $decoded['detail'] !== null ? (string) $decoded['detail'] : null;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicMilestone($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_milestones SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($milestoneId, $tenantId);
            if ($updated === null) {
                return Response::error('Milestone not found', 404);
            }

            return Response::json(['data' => $this->toPublicMilestone($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update milestone', 500);
        }
    }

    public function delete(int $tenantId, int $milestoneId): Response
    {
        $row = $this->findScoped($milestoneId, $tenantId);
        if ($row === null) {
            return Response::error('Milestone not found', 404);
        }

        try {
            $stmt = $this->db->prepare("DELETE FROM tasker_milestones WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id");
            $stmt->execute([':id' => $milestoneId, ':tenant_id' => $tenantId]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete milestone', 500);
        }
    }

    /**
     * POST /api/tasker/milestones/{id}/toggle — flips checked, does not set it
     * to a caller-supplied value, matching the original app's own toggle
     * semantics (complete_milestone / uncomplete_milestone were always a pair
     * of opposite actions, never an arbitrary set).
     */
    public function toggle(int $tenantId, int $milestoneId): Response
    {
        try {
            $stmt = $this->db->prepare(
                "UPDATE tasker_milestones SET checked = NOT checked
                 WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id"
            );
            $stmt->execute([':id' => $milestoneId, ':tenant_id' => $tenantId]);

            if ($stmt->rowCount() === 0) {
                return Response::error('Milestone not found', 404);
            }

            $row = $this->findScoped($milestoneId, $tenantId);
            if ($row === null) {
                return Response::error('Milestone not found', 404);
            }

            return Response::json(['data' => $this->toPublicMilestone($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to toggle milestone', 500);
        }
    }

    /**
     * Whether $taskId exists and belongs to $tenantId — tenant-scoped only,
     * per I7's own note (listForTask() is explicitly not part of C1's
     * OU-scoping fix).
     */
    private function taskExistsInTenant(int $tenantId, int $taskId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
        $stmt->execute([':id' => $taskId, ':tenant_id' => $tenantId]);

        return $stmt->fetch() !== false;
    }

    /**
     * Whether $taskId exists, belongs to $tenantId, AND its OWN PROJECT is
     * within $callerOuId's OU-descendant scope. tasker_tasks itself carries
     * no ou_id column, so this joins up to tasker_projects (the only table
     * that does) and applies {@see OuScopeResolver::whereFragment()} there —
     * the same static-SQL-template pattern used throughout this fix.
     */
    private function taskVisible(int $tenantId, ?int $callerOuId, int $taskId): bool
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT 1 FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.id = :id AND t.tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        return $stmt->fetch() !== false;
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $idCol = $this->idColumn();
        $stmt = $this->db->prepare(
            "SELECT {$idCol} AS id, public_id, tenant_id, task_id, summary, detail, checked, sort_order, created_at
             FROM tasker_milestones WHERE {$idCol} = :id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * The physical column every id-keyed SELECT/UPDATE/DELETE above matches
     * against.
     *
     * On PostgreSQL (production; see CreateTaskerMilestonesTable) `id
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
     * matches nothing. Consequently every id-keyed statement in this class
     * (not just the lookup right after create()) must key off `rowid` on
     * SQLite so a caller's create()-returned id round-trips correctly
     * through update()/delete()/toggle() within the same test run.
     *
     * Mirrors the identical id/rowid branch already established in
     * {@see \Tasker\Api\TasksApiHandler::idColumn()},
     * {@see \Tasker\Api\SectionsApiHandler::idColumn()}, and
     * {@see \Tasker\Api\GroupsApiHandler::idColumn()} for the exact same
     * reason — confirmed empirically here too: without this fix,
     * testCreateDefaultsCheckedToFalse() failed with a 500 (findScoped()
     * found nothing after INSERT), and toggle()/update()/delete() cascaded
     * from that same failure.
     */
    private function idColumn(): string
    {
        return $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? 'rowid' : 'id';
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicMilestone(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'taskId' => (int) $row['task_id'],
            'summary' => (string) $row['summary'],
            'detail' => $row['detail'],
            'checked' => self::dbTruthy($row['checked']),
            'sortOrder' => (int) $row['sort_order'],
            'createdAt' => (string) $row['created_at'],
        ];
    }

    /**
     * Coerce a DB boolean column to a real bool across drivers.
     *
     * CRITICAL: pdo_pgsql can return a boolean column as the STRING "f" for
     * false, and PHP's (bool) cast treats the non-empty string "f" as TRUE
     * — a naive `(bool) $row['checked']` would therefore report every
     * unchecked milestone as checked over the real API. SQLite's in-memory
     * double (this plugin's own unit tests) yields 0/1 (int) instead; either
     * engine may also hand back a native PHP bool directly. Mirrors the
     * identical, repeated fix already established elsewhere in this
     * codebase for the exact same driver quirk — see
     * {@see \Tasker\Api\TasksApiHandler::dbTruthy()} and
     * `TwoFactorHandler::dbTruthy()` (all private-static, so replicated here
     * rather than reused directly).
     *
     * @param mixed $value Raw column value from a boolean field.
     */
    private static function dbTruthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }
        $normalised = strtolower(trim((string) $value));

        return !in_array($normalised, ['', '0', 'f', 'false', 'no'], true);
    }
}
