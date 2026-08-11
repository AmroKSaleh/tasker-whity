<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Domain\DirectivePlaybook;
use Whity\Sdk\Http\Response;

/**
 * Session bootstrap and per-user preferences.
 *
 * __init_tasker_session is the original's mandated first call, returning the
 * user's preferences plus the directive playbook. Here it also lazily creates
 * the prefs row, so no separate registration step exists.
 */
final class SessionApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/session/init — idempotent.
     */
    public function init(int $tenantId, int $profileId): Response
    {
        try {
            $this->ensureRow($tenantId, $profileId);

            $stmt = $this->db->prepare(
                'SELECT default_project_id, local_mode FROM tasker_user_prefs
                 WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':profile_id' => $profileId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!is_array($row)) {
                return Response::error('Failed to initialise session', 500);
            }

            return Response::json([
                'data' => [
                    'defaultProjectId' => $row['default_project_id'] !== null ? (int) $row['default_project_id'] : null,
                    'localMode'        => self::dbTruthy($row['local_mode']),
                    'directives'       => DirectivePlaybook::text(),
                ],
            ], 200);
        } catch (\Throwable) {
            return Response::error('Failed to initialise session', 500);
        }
    }

    /**
     * PUT /api/tasker/session/default-project — body {project_id} or null.
     *
     * A project outside the caller's tenant is 404, never a distinguishable
     * error, matching every other lookup in this plugin.
     */
    public function setDefaultProject(int $tenantId, int $profileId, ?int $projectId): Response
    {
        if ($projectId !== null) {
            $check = $this->db->prepare(
                'SELECT id FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id'
            );
            $check->execute([':id' => $projectId, ':tenant_id' => $tenantId]);
            if ($check->fetch() === false) {
                return Response::error('Project not found', 404);
            }
        }

        try {
            $this->ensureRow($tenantId, $profileId);

            $stmt = $this->db->prepare(
                'UPDATE tasker_user_prefs
                 SET default_project_id = :project_id, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
            );
            $stmt->execute([
                ':project_id' => $projectId,
                ':tenant_id'  => $tenantId,
                ':profile_id' => $profileId,
            ]);

            return $this->init($tenantId, $profileId);
        } catch (\Throwable) {
            return Response::error('Failed to set the default project', 500);
        }
    }

    /**
     * The default-project lookup every other handler uses for its
     * empty-identifier fallback. Static so callers need no instance.
     */
    public static function defaultProjectId(PDO $db, int $tenantId, int $profileId): ?int
    {
        $stmt = $db->prepare(
            'SELECT default_project_id FROM tasker_user_prefs
             WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':profile_id' => $profileId]);
        $value = $stmt->fetchColumn();

        return ($value === false || $value === null) ? null : (int) $value;
    }

    private function ensureRow(int $tenantId, int $profileId): void
    {
        $insert = $this->db->prepare(
            'INSERT INTO tasker_user_prefs (public_id, tenant_id, profile_id, created_at, updated_at)
             VALUES (:public_id, :tenant_id, :profile_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (tenant_id, profile_id) DO NOTHING'
        );
        $insert->execute([
            ':public_id'  => self::generateUuidV4(),
            ':tenant_id'  => $tenantId,
            ':profile_id' => $profileId,
        ]);
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * pdo_pgsql may return booleans as the strings 't'/'f', and (bool) 'f' is
     * TRUE in PHP. Mirrors the helper already in TasksApiHandler.
     */
    private static function dbTruthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }

        return !in_array(strtolower((string) $value), ['', '0', 'f', 'false', 'no'], true);
    }
}
