<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD for tasker_groups. Section-scoped, no OU logic at all
 * (groups don't carry a project_id — see CreateTaskerGroupsTable's own
 * note on why that column is deliberately absent).
 *
 * DELETE never touches tasker_tasks: a group's tasks are un-grouped (their
 * group_id becomes NULL via the FK's ON DELETE SET NULL), not deleted,
 * unlike deleting a project or a section which does cascade.
 */
final class GroupsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function list(int $tenantId, int $sectionId): Response
    {
        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "SELECT {$idCol} AS id, public_id, tenant_id, section_id, name, slug, sort_order, created_at
                 FROM tasker_groups
                 WHERE tenant_id = :tenant_id AND section_id = :section_id
                 ORDER BY sort_order ASC, {$idCol} ASC"
            );
            $stmt->execute([':tenant_id' => $tenantId, ':section_id' => $sectionId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicGroup'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch groups', 500);
        }
    }

    public function create(int $tenantId, int $sectionId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        $sectionCheck = $this->db->prepare('SELECT id FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id');
        $sectionCheck->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);
        if ($sectionCheck->fetch() === false) {
            return Response::error('Section not found', 404);
        }

        $slug = self::slugify($name);

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_groups (public_id, tenant_id, section_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :section_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':section_id' => $sectionId,
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
                return Response::error('Failed to create group', 500);
            }

            return Response::json(['data' => $this->toPublicGroup($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create group', 500);
        }
    }

    public function update(int $tenantId, int $groupId, string $body): Response
    {
        $row = $this->findScoped($groupId, $tenantId);
        if ($row === null) {
            return Response::error('Group not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $groupId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicGroup($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_groups SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($groupId, $tenantId);
            if ($updated === null) {
                return Response::error('Group not found', 404);
            }

            return Response::json(['data' => $this->toPublicGroup($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update group', 500);
        }
    }

    /**
     * DELETE /api/tasker/groups/{id} — tasks in this group are un-grouped,
     * not deleted (tasker_tasks.group_id is ON DELETE SET NULL), so removing
     * a group never loses work, unlike removing a section or a project.
     */
    public function delete(int $tenantId, int $groupId): Response
    {
        $row = $this->findScoped($groupId, $tenantId);
        if ($row === null) {
            return Response::error('Group not found', 404);
        }

        try {
            $stmt = $this->db->prepare("DELETE FROM tasker_groups WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id");
            $stmt->execute([':id' => $groupId, ':tenant_id' => $tenantId]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete group', 500);
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $idCol = $this->idColumn();
        $stmt = $this->db->prepare(
            "SELECT {$idCol} AS id, public_id, tenant_id, section_id, name, slug, sort_order, created_at
             FROM tasker_groups WHERE {$idCol} = :id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * The physical column every id-keyed SELECT/UPDATE/DELETE above matches
     * against.
     *
     * On PostgreSQL (production; see CreateTaskerGroupsTable) `id BIGSERIAL
     * PRIMARY KEY` populates the real `id` column and PDO::lastInsertId()
     * (via lastval()) reads it back correctly — `id` is always right there.
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
     * through update()/delete() within the same test run.
     *
     * Mirrors the identical id/rowid branch established in
     * {@see \Tasker\Api\SectionsApiHandler::idColumn()} for the exact same
     * reason.
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

        return $slug === '' ? 'group' : $slug;
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
    private function toPublicGroup(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'sectionId' => (int) $row['section_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'sortOrder' => (int) $row['sort_order'],
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
