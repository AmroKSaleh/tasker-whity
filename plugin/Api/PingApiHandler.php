<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Core\Audit\AuditLogger;
use Whity\Core\Taxonomy\EntityTagRepository;
use Whity\Core\Taxonomy\TagRepository;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD over tasker_pings.
 *
 * Takes the resolved tenant id as an argument rather than reading
 * TenantContext, so the handler depends on nothing but PDO and the SDK's
 * Response — which is what lets the test suite run it against in-memory
 * SQLite with no host present.
 *
 * Every statement binds an explicit, parameterised tenant_id predicate.
 */
final class PingApiHandler
{
    private const MAX_LABEL_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/pings — the caller's pings, newest first.
     */
    public function list(int $tenantId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'SELECT id, tenant_id, label, created_at FROM tasker_pings
                 WHERE tenant_id = :tenant_id
                 ORDER BY id DESC'
            );
            $stmt->execute([':tenant_id' => $tenantId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicPing'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch pings', 500);
        }
    }

    /**
     * POST /api/tasker/pings — create a ping in the caller's tenant.
     *
     * @param string $body Raw JSON request body.
     */
    public function create(int $tenantId, string $body): Response
    {
        $label = $this->validatedLabel($body);
        if ($label === null) {
            return Response::error(
                'label must be a non-empty string of at most ' . self::MAX_LABEL_LENGTH . ' characters',
                400
            );
        }

        try {
            // created_at is bound as an explicit, PHP-computed value rather than
            // delegated to an engine SQL function (NOW()/CURRENT_TIMESTAMP), so
            // the statement is portable across PostgreSQL and the in-memory
            // SQLite the unit tests run against, and the value returned below is
            // guaranteed to match what was persisted.
            $createdAt = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s');

            // The tenant is stamped from the caller's context — never from input.
            $stmt = $this->db->prepare(
                'INSERT INTO tasker_pings (tenant_id, label, created_at) VALUES (:tenant_id, :label, :created_at)'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':label' => $label, ':created_at' => $createdAt]);

            // Built directly from the known insert values rather than a
            // post-insert SELECT keyed on id: CreateTaskerPingTable's
            // `id SERIAL PRIMARY KEY` is not recognised by SQLite as the rowid
            // alias (SQLite only special-cases a column whose declared type is
            // the literal "INTEGER"), so under the in-memory SQLite the unit
            // tests use, the `id` column is always NULL and a `WHERE id = :id`
            // lookup keyed off lastInsertId() would never match. lastInsertId()
            // itself stays correct on both engines (SQLite's rowid, Postgres's
            // SERIAL sequence via lastval()), so it is safe to report directly.
            $id = (int) $this->db->lastInsertId();

            // Establishes the convention every later table's create() reuses:
            // action keys are tasker_<entity>.<verb>, target_type is tasker_<entity>.
            (new AuditLogger($this->db))->record('tasker_ping.created', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_ping',
                'target_id' => $id,
            ]);

            return Response::json(['data' => [
                'id' => $id,
                'tenantId' => $tenantId,
                'label' => $label,
                'createdAt' => $createdAt,
            ]], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create ping', 500);
        }
    }

    /**
     * POST /api/tasker/pings/{id}/tags — attach an existing tag to a ping.
     *
     * The tag itself must already exist (created via core's own /api/tags,
     * gated on tags:manage) — this plugin never creates tags, only attaches
     * them, and the tag must belong to the caller's tenant (a foreign/absent
     * tag_id is a 422 validation failure, never a confirmation of its
     * existence in another tenant — mirrors core's own
     * {@see \Whity\Api\EntityTagsApiHandler::attach()}). A ping outside the
     * caller's tenant reports 404, never a cross-tenant existence leak.
     */
    public function tag(int $tenantId, int $pingId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $tagId = is_array($decoded) && isset($decoded['tag_id']) ? (int) $decoded['tag_id'] : 0;
        if ($tagId <= 0) {
            return Response::error('tag_id is required and must be a positive integer', 400);
        }

        // tasker_pings.id (see create()'s comment) never matches on SQLite: its
        // declared type is "SERIAL", not the literal "INTEGER" SQLite requires
        // to alias a column to the rowid, so an inserted row's id column reads
        // back as NULL. `rowid` is SQLite's own always-present identity column
        // and holds exactly the value create() returned via lastInsertId(), so
        // it stands in for `id` here on that engine only; PostgreSQL has no
        // `rowid` and does populate `id` correctly, so it keeps using the real
        // column. Both branches bind tenant_id, so cross-tenant access is
        // never widened by this switch.
        $idColumn = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? 'rowid' : 'id';

        $find = $this->db->prepare("SELECT id FROM tasker_pings WHERE {$idColumn} = :id AND tenant_id = :tenant_id");
        $find->execute([':id' => $pingId, ':tenant_id' => $tenantId]);
        if ($find->fetch() === false) {
            return Response::error('Ping not found', 404);
        }

        // The tag must belong to the caller's tenant. TagRepository::find()
        // already binds tenant_id, so a foreign-tenant tag_id is
        // indistinguishable from a non-existent one — a validation failure
        // (422), never a cross-tenant leak.
        if ((new TagRepository($this->db))->find($tenantId, $tagId) === null) {
            return Response::error('tag not found', 422, ['tag_id' => $tagId]);
        }

        try {
            // Delegates the actual INSERT to core's own EntityTagRepository —
            // the canonical, single writer for entity_tags (see its class
            // doc) — rather than re-issuing the raw SQL here.
            $created = (new EntityTagRepository($this->db))
                ->attach($tenantId, 'tasker_ping', $pingId, $tagId);

            return Response::json([
                'data' => ['entity_type' => 'tasker_ping', 'entity_id' => $pingId, 'tag_id' => $tagId],
            ], $created ? 201 : 200);
        } catch (\Throwable) {
            return Response::error('Failed to attach tag', 500);
        }
    }

    /**
     * @return string|null The valid label, or null when missing/invalid.
     */
    private function validatedLabel(string $body): ?string
    {
        $decoded = json_decode($body, true);
        $label = is_array($decoded) ? ($decoded['label'] ?? null) : null;

        if (!is_string($label) || trim($label) === '' || mb_strlen($label) > self::MAX_LABEL_LENGTH) {
            return null;
        }

        return trim($label);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicPing(array $row): array
    {
        return [
            'id' => (int) ($row['id'] ?? 0),
            'tenantId' => (int) ($row['tenant_id'] ?? 0),
            'label' => (string) ($row['label'] ?? ''),
            'createdAt' => isset($row['created_at']) ? (string) $row['created_at'] : null,
        ];
    }
}
