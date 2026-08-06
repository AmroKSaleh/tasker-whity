<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

final class TaskDiscussionsApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/tasks/{id}/discussion — returns an empty shape when no
     * discussion row exists yet, rather than 404. A task always logically
     * "has" a discussion (empty until AI chat begins), matching the original
     * app's lazy-creation-on-first-use semantics without needing a row to
     * pre-exist for every task.
     */
    public function get(int $tenantId, int $taskId): Response
    {
        $task = $this->db->prepare('SELECT id FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
        $task->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        if ($task->fetch() === false) {
            return Response::error('Task not found', 404);
        }

        $stmt = $this->db->prepare(
            'SELECT task_id, messages, reason, updated_at FROM tasker_task_discussions
             WHERE task_id = :task_id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':task_id' => $taskId, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!is_array($row)) {
            return Response::json(['data' => ['taskId' => $taskId, 'messages' => [], 'reason' => null, 'updatedAt' => null]], 200);
        }

        return Response::json(['data' => $this->toPublicDiscussion($row)], 200);
    }

    /**
     * PUT /api/tasker/tasks/{id}/discussion — upsert. Creates the row on
     * first write, updates it on every subsequent write — never duplicates.
     *
     * Rejects a malformed/non-object body with 400 rather than silently
     * treating it as "no messages, no reason" and overwriting an existing
     * row's data with empty defaults. `json_decode($body, true)` maps BOTH a
     * JSON object (`{"messages":[...]}`) and a JSON array (`[1,2,3]`) to a
     * PHP array, so `is_array($decoded)` alone can't tell them apart —
     * `array_is_list()` (empty-array excepted, since `{}` and `[]` are
     * indistinguishable once decoded and an empty object is a legitimate,
     * if unusual, payload) is what actually catches a JSON-array body like
     * `[1,2,3]` that `is_array()` alone would let through as if it were `{}`.
     */
    public function put(int $tenantId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
            return Response::error('Request body must be a JSON object', 400);
        }

        if (isset($decoded['reason']) && !is_scalar($decoded['reason'])) {
            return Response::error('reason must be a string', 400);
        }

        $messages = isset($decoded['messages']) && is_array($decoded['messages'])
            ? $decoded['messages']
            : [];
        $reason = isset($decoded['reason']) ? (string) $decoded['reason'] : null;

        $task = $this->db->prepare('SELECT id FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
        $task->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        if ($task->fetch() === false) {
            return Response::error('Task not found', 404);
        }

        $encodedMessages = json_encode($messages, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encodedMessages === false) {
            $encodedMessages = '[]';
        }

        try {
            $upsert = $this->db->prepare(
                'INSERT INTO tasker_task_discussions (public_id, tenant_id, task_id, messages, reason, created_at, updated_at)
                 VALUES (:public_id, :tenant_id, :task_id, :messages, :reason, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (task_id) DO UPDATE SET messages = :messages, reason = :reason, updated_at = CURRENT_TIMESTAMP'
            );
            $upsert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':task_id' => $taskId,
                ':messages' => $encodedMessages,
                ':reason' => $reason,
            ]);

            return $this->get($tenantId, $taskId);
        } catch (\Throwable) {
            return Response::error('Failed to save discussion', 500);
        }
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
    private function toPublicDiscussion(array $row): array
    {
        return [
            'taskId' => (int) $row['task_id'],
            'messages' => json_decode((string) $row['messages'], true) ?? [],
            'reason' => $row['reason'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }
}
