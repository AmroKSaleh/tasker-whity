<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
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
            return Response::json(['data' => [
                'id' => (int) $this->db->lastInsertId(),
                'tenantId' => $tenantId,
                'label' => $label,
                'createdAt' => $createdAt,
            ]], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create ping', 500);
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
