<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * GET /api/tasker/projects/{id}/board — sections, groups, tasks and
 * milestone progress in one response, replacing the four-to-five separate
 * round trips the original Supabase app made per board load.
 */
final class BoardApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function get(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        $project = $this->findProject($tenantId, $callerOuId, $projectId);
        if ($project === null) {
            return Response::error('Project not found', 404);
        }

        $sections = $this->fetchAll(
            'SELECT id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs
             FROM tasker_sections WHERE tenant_id = :tenant_id AND project_id = :project_id ORDER BY sort_order ASC, id ASC',
            [':tenant_id' => $tenantId, ':project_id' => $projectId]
        );

        $groups = $this->fetchAll(
            'SELECT g.id, g.public_id, g.tenant_id, g.section_id, g.name, g.slug, g.sort_order
             FROM tasker_groups g
             JOIN tasker_sections s ON s.id = g.section_id
             WHERE g.tenant_id = :tenant_id AND s.tenant_id = :tenant_id2 AND s.project_id = :project_id
             ORDER BY g.sort_order ASC, g.id ASC',
            [':tenant_id' => $tenantId, ':tenant_id2' => $tenantId, ':project_id' => $projectId]
        );

        $tasks = $this->fetchAll(
            'SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                    due_date, pinned, sort_order, completed_at, short_id
             FROM tasker_tasks WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, id ASC',
            [':tenant_id' => $tenantId, ':project_id' => $projectId]
        );

        $taskIds = array_map(static fn (array $t): int => (int) $t['id'], $tasks);
        $milestonesByTask = $this->fetchMilestonesGroupedByTask($tenantId, $taskIds);

        $tasksBySection = [];
        $tasksByGroup = [];
        foreach ($tasks as $task) {
            $task['milestones'] = $milestonesByTask[(int) $task['id']] ?? [];
            $sectionId = (int) $task['section_id'];
            $groupId = $task['group_id'] !== null ? (int) $task['group_id'] : null;

            if ($groupId !== null) {
                $tasksByGroup[$groupId][] = $task;
            } else {
                $tasksBySection[$sectionId][] = $task;
            }
        }

        $groupsBySection = [];
        foreach ($groups as $group) {
            $groupId = (int) $group['id'];
            $group['tasks'] = array_map([$this, 'toPublicTask'], $tasksByGroup[$groupId] ?? []);
            $groupsBySection[(int) $group['section_id']][] = $group;
        }

        $publicSections = [];
        foreach ($sections as $section) {
            $sectionId = (int) $section['id'];
            $publicSections[] = [
                'id' => $sectionId,
                'publicId' => (string) $section['public_id'],
                'name' => (string) $section['name'],
                'slug' => (string) $section['slug'],
                'description' => $section['description'],
                'sortOrder' => (int) $section['sort_order'],
                'ungroupedTasks' => array_map([$this, 'toPublicTask'], $tasksBySection[$sectionId] ?? []),
                'groups' => array_map(fn (array $g) => $this->toPublicGroup($g), $groupsBySection[$sectionId] ?? []),
            ];
        }

        return Response::json([
            'data' => [
                'project' => $project,
                'sections' => $publicSections,
            ],
        ], 200);
    }

    /**
     * OU-scoped, tenant-scoped project lookup — byte-for-byte the same
     * structure as {@see ProjectsApiHandler::findScoped()} and
     * {@see TasksApiHandler::isProjectVisible()}: one static SQL template via
     * {@see OuScopeResolver::whereFragment()}, called unconditionally,
     * exactly as documented (never a runtime-branched query, so a
     * tenant-predicate scanner always sees the same shape). Consequently this
     * method — and therefore {@see self::get()} as a whole — is exercised
     * only against a REAL PostgreSQL connection, in
     * `TenantIsolationOuTest.php`, never against this plugin's in-memory
     * SQLite unit-test double: `whereFragment()`'s `= ANY(:scope)` is
     * PostgreSQL-only syntax that SQLite's `PDO::prepare()` rejects outright
     * ("no such function: ANY") purely from the SQL text containing it,
     * regardless of which branch `:unrestricted` would make live at
     * runtime — SQLite resolves function names at prepare time, before any
     * parameter is bound. `ProjectsApiHandler` has no SQLite-backed unit test
     * file at all for exactly this reason; this method follows that same
     * precedent instead of inventing a driver branch around it.
     *
     * @return array<string, mixed>|null
     */
    private function findProject(int $tenantId, ?int $callerOuId, int $projectId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT id, public_id, tenant_id, ou_id, name, slug FROM tasker_projects
             WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
        ];
    }

    /**
     * @param array<string, mixed> $params
     * @return array<int, array<string, mixed>>
     */
    private function fetchAll(string $sql, array $params): array
    {
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * @param list<int> $taskIds
     * @return array<int, array<int, array<string, mixed>>>
     */
    private function fetchMilestonesGroupedByTask(int $tenantId, array $taskIds): array
    {
        if ($taskIds === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($taskIds), '?'));
        $stmt = $this->db->prepare(
            "SELECT id, task_id, summary, detail, checked, sort_order
             FROM tasker_milestones
             WHERE tenant_id = ? AND task_id IN ({$placeholders})
             ORDER BY sort_order ASC, id ASC"
        );
        $stmt->execute(array_merge([$tenantId], $taskIds));

        $grouped = [];
        /** @var array<string, mixed> $row */
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $grouped[(int) $row['task_id']][] = [
                'id' => (int) $row['id'],
                'summary' => (string) $row['summary'],
                'detail' => $row['detail'],
                'checked' => self::dbTruthy($row['checked']),
                'sortOrder' => (int) $row['sort_order'],
            ];
        }

        return $grouped;
    }

    /**
     * @param array<string, mixed> $task
     * @return array<string, mixed>
     */
    private function toPublicTask(array $task): array
    {
        return [
            'id' => (int) $task['id'],
            'publicId' => (string) $task['public_id'],
            'text' => (string) $task['text'],
            'detail' => $task['detail'],
            'status' => (string) $task['status'],
            'priority' => $task['priority'],
            'dueDate' => $task['due_date'],
            'pinned' => self::dbTruthy($task['pinned']),
            'sortOrder' => (int) $task['sort_order'],
            'completedAt' => $task['completed_at'],
            'shortId' => $task['short_id'] !== null ? (int) $task['short_id'] : null,
            'milestones' => $task['milestones'] ?? [],
        ];
    }

    /**
     * @param array<string, mixed> $group
     * @return array<string, mixed>
     */
    private function toPublicGroup(array $group): array
    {
        return [
            'id' => (int) $group['id'],
            'publicId' => (string) $group['public_id'],
            'name' => (string) $group['name'],
            'slug' => (string) $group['slug'],
            'sortOrder' => (int) $group['sort_order'],
            'tasks' => $group['tasks'] ?? [],
        ];
    }

    /**
     * Coerce a DB boolean column to a real bool across drivers.
     *
     * CRITICAL: pdo_pgsql can return a boolean column as the STRING "f" for
     * false, and PHP's (bool) cast treats the non-empty string "f" as TRUE —
     * a naive `(bool) $row['pinned']`/`(bool) $row['checked']` would
     * therefore report every unpinned task/unchecked milestone as
     * pinned/checked over the real API. SQLite's in-memory double (this
     * plugin's own unit tests) yields 0/1 (int) instead; either engine may
     * also hand back a native PHP bool directly. Mirrors the identical,
     * repeated fix already established elsewhere in this codebase for the
     * exact same driver quirk — see {@see TasksApiHandler::dbTruthy()} and
     * {@see MilestonesApiHandler::dbTruthy()} (both private-static, so
     * replicated here rather than reused directly).
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
