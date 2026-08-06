<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
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
        // (array_key_exists, not isset — an explicit `"ou_id": null` must
        // still be validated, not skipped), the requested value — concrete
        // id or null — is routed through ouIsInCallersScope() below.
        $ouId = $callerOuId;
        if (is_array($decoded) && array_key_exists('ou_id', $decoded)) {
            $ouId = $decoded['ou_id'] !== null ? (int) $decoded['ou_id'] : null;
            if (!$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('ou_id is outside the caller\'s scope', 422);
            }
        }

        $slug = self::slugify($name);

        $this->db->beginTransaction();
        try {
            $insertProject = $this->db->prepare(
                'INSERT INTO tasker_projects (public_id, tenant_id, ou_id, name, slug, created_by, created_at)
                 VALUES (:public_id, :tenant_id, :ou_id, :name, :slug, :created_by, CURRENT_TIMESTAMP)
                 RETURNING id'
            );
            $insertProject->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':ou_id' => $ouId,
                ':name' => $name,
                ':slug' => $slug,
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
        } catch (\Throwable) {
            $this->db->rollBack();
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
     * PATCH /api/tasker/projects/{id} — partial update. Only fields present
     * in the body are changed. slug is frozen at creation and never exposed
     * as an updatable field, the same policy sections and groups use.
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
        if (array_key_exists('ou_id', $decoded)) {
            $ouId = $decoded['ou_id'] !== null ? (int) $decoded['ou_id'] : null;
            // Validated regardless of whether the new value is a concrete OU
            // id or null: an OU-restricted caller setting ou_id to null would
            // otherwise unilaterally widen the project to tenant-wide
            // visibility with no authorization check at all.
            if (!$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('ou_id is outside the caller\'s scope', 422);
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
     * DELETE /api/tasker/projects/{id} — cascades to the project's sections,
     * groups, tasks, milestones, and task discussions via each table's own
     * FK (all ON DELETE CASCADE, see Tasks 4-7's migrations). entity_tags
     * rows referencing a deleted task or project become orphaned — accepted,
     * since entity_tags.entity_type is opaque and unenforced by design (§6).
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
     * Whether $ouId is within the caller's own OU-descendant scope — used to
     * stop a caller assigning a project to an OU they cannot themselves see,
     * INCLUDING assigning it to null (tenant-root, visible to the whole
     * tenant) — a null ou_id is strictly WIDER than any non-null OU scope,
     * so it must be treated as its own case, not skipped as "no OU to
     * check".
     */
    private function ouIsInCallersScope(int $tenantId, ?int $callerOuId, ?int $ouId): bool
    {
        if ($callerOuId === null) {
            return true; // unrestricted (tenant-root) caller may assign anywhere, including null.
        }

        // An OU-restricted caller can never produce a null ou_id: that would
        // grant tenant-wide visibility, strictly wider than their own scope.
        if ($ouId === null) {
            return false;
        }

        return in_array($ouId, OuScopeResolver::descendantIds($this->db, $tenantId, $callerOuId), true);
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
