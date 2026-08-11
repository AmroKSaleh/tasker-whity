<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Tasker\Domain\PrefixDeriver;
use Whity\Core\Audit\AuditLogger;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped, OU-scoped CRUD for tasker_projects.
 *
 * Every list/read query uses OuScopeResolver::whereFragment('ou_id') bound
 * with OuScopeResolver::scopeParams()'s output — always the SAME static SQL
 * text regardless of whether the caller is OU-restricted, per the design's
 * explicit answer to the tenant-predicate-scanner risk.
 *
 * Postgres-only by design: `RETURNING id` and OuScopeResolver::whereFragment()'s
 * `= ANY(:scope)` are both PostgreSQL-specific, so this handler is exercised
 * exclusively against a real PostgreSQL connection (see TenantIsolationOuTest),
 * never against the SQLite double the rest of this plugin's unit tests use.
 */
final class ProjectsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/projects — OU-scoped list, newest first.
     */
    public function list(int $tenantId, ?int $callerOuId): Response
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        try {
            $stmt = $this->db->prepare(
                "SELECT id, public_id, tenant_id, ou_id, name, slug, context, prefix, sort_order, created_by, created_at
                 FROM tasker_projects
                 WHERE tenant_id = :tenant_id AND {$ouClause}
                 ORDER BY sort_order ASC, id DESC"
            );
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
            $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
            $stmt->execute();

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicProject'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch projects', 500);
        }
    }

    /**
     * POST /api/tasker/projects — create a project and its default "Backlog"
     * section atomically. A project never exists without at least one
     * section, closing the null-section rendering bug the original app
     * carried as a client-side workaround.
     */
    public function create(int $tenantId, ?int $callerOuId, int $createdBy, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        // Default to the CALLER's own OU, not tenant-root: an OU-restricted
        // caller who simply omits ou_id must not get a project that is
        // wider than their own scope (a bare null ou_id is visible
        // tenant-wide). An unrestricted caller's own OU is null, so this
        // default is a no-op for them. When the body DOES supply the key
        // (present, not just non-null — an explicit `"ou_id": null` must
        // still be validated, not skipped), the requested value — concrete
        // id or null — is routed through ouIsInCallersScope() below.
        $ouId = $callerOuId;
        $ouInput = self::extractOuIdInput(is_array($decoded) ? $decoded : []);
        if ($ouInput['present']) {
            if ($ouInput['raw'] !== null && !is_numeric($ouInput['raw'])) {
                return Response::error('environment_id must be an integer id', 400);
            }
            $ouId = $ouInput['raw'] !== null ? (int) $ouInput['raw'] : null;
            if (!$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('environment_id is outside the caller\'s scope', 422);
            }
        }

        $slug = self::slugify($name);

        // A caller-supplied prefix is validated the same 2-5-uppercase-letter
        // shape update() already enforces (see its own 'prefix' branch);
        // omitting the key entirely derives one instead, mirroring the
        // original app's deriveProjectPrefix() so a project's short ids
        // (TDE-31) start from a sensible, name-derived prefix by default.
        $prefix = null;
        if (is_array($decoded) && isset($decoded['prefix'])) {
            $prefix = strtoupper(trim((string) $decoded['prefix']));
            if (preg_match('/^[A-Z]{2,5}$/', $prefix) !== 1) {
                return Response::error('prefix must be 2-5 uppercase letters', 400);
            }
        } else {
            // Null is acceptable — the project then has no short ids.
            $prefix = PrefixDeriver::derive($this->db, $tenantId, $name);
        }

        $this->db->beginTransaction();
        try {
            $insertProject = $this->db->prepare(
                'INSERT INTO tasker_projects (public_id, tenant_id, ou_id, name, slug, prefix, created_by, created_at)
                 VALUES (:public_id, :tenant_id, :ou_id, :name, :slug, :prefix, :created_by, CURRENT_TIMESTAMP)
                 RETURNING id'
            );
            $insertProject->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':ou_id' => $ouId,
                ':name' => $name,
                ':slug' => $slug,
                ':prefix' => $prefix,
                ':created_by' => $createdBy,
            ]);
            $projectId = (int) $insertProject->fetchColumn();

            $insertSection = $this->db->prepare(
                'INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :project_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insertSection->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':project_id' => $projectId,
                ':name' => 'Backlog',
                ':slug' => 'backlog',
            ]);

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            if (self::isUniqueViolation($e)) {
                return Response::error('A project with this name already exists', 409);
            }

            return Response::error('Failed to create project', 500);
        }

        (new AuditLogger($this->db))->record('tasker_project.created', [
            'tenant_id' => $tenantId,
            'target_type' => 'tasker_project',
            'target_id' => $projectId,
        ]);

        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Failed to create project', 500);
        }

        return Response::json(['data' => $this->toPublicProject($row)], 201);
    }

    /**
     * PATCH /api/tasker/projects — partial update, project_id resolved by
     * the caller before this is reached (see TaskerPlugin::updateProject()).
     * Only fields present in the body are changed. slug is frozen at
     * creation and never exposed as an updatable field, the same policy
     * sections and groups use.
     */
    public function update(int $tenantId, ?int $callerOuId, int $projectId, string $body): Response
    {
        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Project not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $projectId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        $ouInput = self::extractOuIdInput($decoded);
        if ($ouInput['present']) {
            if ($ouInput['raw'] !== null && !is_numeric($ouInput['raw'])) {
                return Response::error('environment_id must be an integer id', 400);
            }
            $ouId = $ouInput['raw'] !== null ? (int) $ouInput['raw'] : null;
            // Validated regardless of whether the new value is a concrete OU
            // id or null: an OU-restricted caller setting ou_id to null would
            // otherwise unilaterally widen the project to tenant-wide
            // visibility with no authorization check at all.
            if (!$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('environment_id is outside the caller\'s scope', 422);
            }
            $fields[] = 'ou_id = :ou_id';
            $params[':ou_id'] = $ouId;
        }
        if (array_key_exists('prefix', $decoded)) {
            $prefix = $decoded['prefix'] !== null ? strtoupper((string) $decoded['prefix']) : null;
            if ($prefix !== null && preg_match('/^[A-Z]{2,5}$/', $prefix) !== 1) {
                return Response::error('prefix must be 2-5 uppercase letters, or null to clear it', 400);
            }
            $fields[] = 'prefix = :prefix';
            $params[':prefix'] = $prefix;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicProject($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_projects SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($projectId, $tenantId, $callerOuId);
            if ($updated === null) {
                return Response::error('Project not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_project.updated', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_project',
                'target_id' => $projectId,
            ]);

            return Response::json(['data' => $this->toPublicProject($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update project', 500);
        }
    }

    /**
     * DELETE /api/tasker/projects — project_id resolved by the caller before
     * this is reached (see TaskerPlugin::deleteProject()). Cascades to the
     * project's sections, groups, tasks, milestones, and task discussions via
     * each table's own FK (all ON DELETE CASCADE, see Tasks 4-7's
     * migrations). entity_tags rows referencing a deleted task or project
     * become orphaned — accepted, since entity_tags.entity_type is opaque and
     * unenforced by design (§6).
     */
    public function delete(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Project not found', 404);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $projectId, ':tenant_id' => $tenantId]);

            (new AuditLogger($this->db))->record('tasker_project.deleted', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_project',
                'target_id' => $projectId,
            ]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete project', 500);
        }
    }

    /**
     * GET /api/tasker/project?project_id=&include_notes= — the original's
     * get_project: the project itself, plus every one of its sections and
     * TASKS OF EVERY STATUS. Unlike list_tasks (whose default excludes done
     * tasks — a deliberate work-queue behaviour), this is a full project read
     * a UI renders, so nothing is filtered by status. Flat: tasks nest
     * directly under their section, with no group nesting (unlike
     * {@see \Tasker\Api\BoardApiHandler::get()}'s groups/ungroupedTasks
     * split) — matching the original's own get_project shape. Sections and
     * tasks are both ordered by sort_order then id, for a deterministic
     * response, matching every other composed-read handler in this codebase.
     *
     * Reuses {@see self::findScoped()} for the OU-scoped project lookup —
     * this method's SQLite-tier status is therefore identical to every other
     * findScoped()-based method: Postgres-only (see this class's own
     * docblock), exercised in TenantIsolationOuTest, never a SQLite unit test.
     *
     * $includeNotes controls whether each task's `detail` key is present in
     * the response AT ALL — omitted entirely (not present-as-null) when
     * false, since a large project's accumulated detail text can be very
     * large. See {@see \Tasker\TaskerPlugin::queryParamBool()} for how the
     * caller's `include_notes` query string is parsed into this bool without
     * a naive `(bool)` cast misreading a falsy string like "false" as true.
     */
    public function getOne(int $tenantId, ?int $callerOuId, int $projectId, bool $includeNotes): Response
    {
        $project = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($project === null) {
            return Response::error('Project not found', 404);
        }

        $sections = $this->fetchSectionsForProject($tenantId, $projectId);
        $tasks = $this->fetchTasksForProject($tenantId, $projectId);

        $tasksBySection = [];
        foreach ($tasks as $task) {
            $tasksBySection[(int) $task['section_id']][] = $this->toProjectTask($task, $includeNotes);
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
                'tasks' => $tasksBySection[$sectionId] ?? [],
            ];
        }

        return Response::json([
            'data' => array_merge($this->toPublicProject($project), ['sections' => $publicSections]),
        ], 200);
    }

    /**
     * Every section of $projectId, tenant_id bound explicitly (never
     * implicit) — ordered by sort_order then id for a deterministic
     * get_project response.
     *
     * @return array<int, array<string, mixed>>
     */
    private function fetchSectionsForProject(int $tenantId, int $projectId): array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, project_id, name, slug, description, sort_order
             FROM tasker_sections WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, id ASC'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * Every task in $projectId, regardless of status — see {@see self::getOne()}'s
     * own docblock for why get_project does not apply list_tasks' default
     * "exclude done" filter. Ordered by sort_order then id.
     *
     * @return array<int, array<string, mixed>>
     */
    private function fetchTasksForProject(int $tenantId, int $projectId): array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, section_id, group_id, text, detail, status, priority, due_date,
                    pinned, sort_order, completed_at, short_id
             FROM tasker_tasks WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, id ASC'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * A task's shape within a get_project response — deliberately NOT the
     * same shape as {@see \Tasker\Api\TasksApiHandler::toPublicTask()} (no
     * tenantId/projectId/createdBy/timestamps — a project-scoped nested view
     * does not need to repeat its own parent's ids), and `detail` is present
     * ONLY when $includeNotes is true (see {@see self::getOne()}'s docblock).
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toProjectTask(array $row, bool $includeNotes): array
    {
        $task = [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'groupId' => $row['group_id'] !== null ? (int) $row['group_id'] : null,
            'text' => (string) $row['text'],
            'status' => (string) $row['status'],
            'priority' => $row['priority'],
            'dueDate' => $row['due_date'],
            'pinned' => self::dbTruthy($row['pinned']),
            'sortOrder' => (int) $row['sort_order'],
            'completedAt' => $row['completed_at'],
            'shortId' => $row['short_id'] !== null ? (int) $row['short_id'] : null,
        ];
        if ($includeNotes) {
            $task['detail'] = $row['detail'];
        }

        return $task;
    }

    /**
     * Coerce a DB boolean column to a real bool across drivers.
     *
     * CRITICAL: pdo_pgsql can return a boolean column as the STRING "f" for
     * false, and PHP's (bool) cast treats the non-empty string "f" as TRUE —
     * a naive `(bool) $row['pinned']` would therefore report every unpinned
     * task as pinned over the real API. Mirrors the identical, repeated fix
     * already established elsewhere in this codebase for the exact same
     * driver quirk — see {@see \Tasker\Api\TasksApiHandler::dbTruthy()} and
     * {@see \Tasker\Api\BoardApiHandler::dbTruthy()} (both private-static, so
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

    /**
     * Reads the caller-supplied OU id out of a decoded body, accepting
     * `environment_id` as the request-facing alias for the internal `ou_id`
     * column — the derived MCP tool surface speaks "Environment", never
     * "OU" (see this handler's route schema in TaskerPlugin::getRoutes()),
     * so `create`/`update` must accept whichever key an agent actually sends.
     * `ou_id` wins when a caller supplies both, matching this class's own
     * historical field name.
     *
     * `present` uses array_key_exists, not isset, on EITHER key — an
     * explicit `"ou_id": null` (or `"environment_id": null`) must still be
     * validated as "leave/set this project tenant-wide", not silently
     * treated as "the key was omitted".
     *
     * OU ids are integers or UUIDs, resolved by core rather than by
     * {@see \Tasker\Access\IdentifierResolver} — that resolver only knows
     * Tasker's own entities (projects/sections/groups/tasks); it has no
     * notion of an organizational_units row. Accepting a UUID here would
     * need a genuine OU-identifier resolver this slice does not build, so
     * only an integer or a numeric string is accepted; anything else is
     * rejected by the caller with a 400, not silently coerced to 0 or
     * misreported as a 404/422 scope failure.
     *
     * @param array<string, mixed> $decoded
     * @return array{present: bool, raw: mixed}
     */
    private static function extractOuIdInput(array $decoded): array
    {
        if (array_key_exists('ou_id', $decoded)) {
            return ['present' => true, 'raw' => $decoded['ou_id']];
        }
        if (array_key_exists('environment_id', $decoded)) {
            return ['present' => true, 'raw' => $decoded['environment_id']];
        }

        return ['present' => false, 'raw' => null];
    }

    /**
     * Whether $ouId is within the caller's own OU-descendant scope — used to
     * stop a caller assigning a project to an OU they cannot themselves see,
     * INCLUDING assigning it to null (tenant-root, visible to the whole
     * tenant) — a null ou_id is strictly WIDER than any non-null OU scope,
     * so it must be treated as its own case, not skipped as "no OU to
     * check".
     *
     * REGRESSION FIX (whole-branch review finding I5): a tenant-root caller
     * ($callerOuId === null) used to short-circuit straight to `true` for
     * ANY concrete $ouId, with no check that it actually exists — let alone
     * that it belongs to the caller's own tenant. Since tasker_projects.ou_id
     * carries no FK to organizational_units, a tenant-root caller could
     * silently assign a nonexistent or foreign-tenant ou_id, orphaning the
     * project (invisible to every OU-restricted caller, visible only via
     * tenant-root) with no diagnostic at all. A concrete $ouId is now always
     * existence-checked against the caller's OWN tenant, even on this
     * branch; only a null $ouId (tenant-root leaving/setting the project
     * tenant-wide) skips the check, since there is no OU row to validate.
     */
    private function ouIsInCallersScope(int $tenantId, ?int $callerOuId, ?int $ouId): bool
    {
        if ($callerOuId === null) {
            if ($ouId === null) {
                return true; // unrestricted (tenant-root) caller may leave/set the project tenant-wide.
            }

            return $this->ouExistsInTenant($tenantId, $ouId);
        }

        // An OU-restricted caller can never produce a null ou_id: that would
        // grant tenant-wide visibility, strictly wider than their own scope.
        if ($ouId === null) {
            return false;
        }

        return in_array($ouId, OuScopeResolver::descendantIds($this->db, $tenantId, $callerOuId), true);
    }

    /**
     * Whether $ouId exists at all, and belongs to $tenantId — the tenant-root
     * caller's own scope-check, tenant-only (an OU either exists in the
     * tenant or it doesn't; no OuScopeResolver/descendant traversal is
     * meaningful here), so this is portable and needs no Postgres-only
     * syntax.
     */
    private function ouExistsInTenant(int $tenantId, int $ouId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM organizational_units WHERE id = :ou_id AND tenant_id = :tenant_id');
        $stmt->execute([':ou_id' => $ouId, ':tenant_id' => $tenantId]);

        return $stmt->fetch() !== false;
    }

    /**
     * Whether $e was thrown for a unique-constraint violation (PostgreSQL
     * SQLSTATE 23505) — e.g. a duplicate (tenant_id, slug). Confirmed
     * empirically against a real pdo_pgsql connection: PDOException::getCode()
     * returns the SQLSTATE string directly for a failed statement, so no
     * errorInfo[] lookup is needed. Duplicated per handler (ProjectsApiHandler/
     * SectionsApiHandler/GroupsApiHandler) rather than shared, matching this
     * codebase's existing convention for small driver-specific helpers (see
     * idColumn()/generateUuidV4()/dbTruthy() elsewhere in this plugin).
     */
    private static function isUniqueViolation(\Throwable $e): bool
    {
        return $e instanceof \PDOException && $e->getCode() === '23505';
    }

    /**
     * A dependency-free RFC 4122 v4 UUID, generated in PHP because neither
     * PostgreSQL's gen_random_uuid() nor a DEFAULT expression that calls it
     * is available under the SQLite double this plugin's own unit tests run
     * against.
     */
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
    private function findScoped(int $id, int $tenantId, ?int $callerOuId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT id, public_id, tenant_id, ou_id, name, slug, context, prefix, sort_order, created_by, created_at
             FROM tasker_projects
             WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $id, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');

        return $slug === '' ? 'project' : $slug;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicProject(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'ouId' => $row['ou_id'] !== null ? (int) $row['ou_id'] : null,
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'context' => json_decode((string) $row['context'], true) ?? [],
            'prefix' => $row['prefix'],
            'sortOrder' => (int) $row['sort_order'],
            'createdBy' => (int) $row['created_by'],
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
