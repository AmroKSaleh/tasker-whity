<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * REGRESSION FIX (whole-branch review finding C1): get()/put()'s
 * task-existence check used to be tenant-scoped only, even though {id}=task
 * is a path parameter, not a discovered value. It is now OU-aware, joining
 * through tasker_tasks to tasker_projects (the only table with an ou_id
 * column) and applying OuScopeResolver there — the same static-SQL-template
 * pattern used throughout this fix. Confines both methods to a real
 * PostgreSQL connection (see TenantIsolationOuTest).
 */
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
    public function get(int $tenantId, ?int $callerOuId, int $taskId): Response
    {
        if (!$this->taskVisible($tenantId, $callerOuId, $taskId)) {
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
    public function put(int $tenantId, ?int $callerOuId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
            return Response::error('Request body must be a JSON object', 400);
        }

        if (isset($decoded['reason']) && !is_scalar($decoded['reason'])) {
            return Response::error('reason must be a string', 400);
        }

        // REGRESSION FIX (whole-branch review data-loss guard finding): a
        // structurally-valid body whose `messages` field was present but the
        // WRONG TYPE (e.g. a string) used to silently fall back to `[]` and
        // overwrite an existing conversation's real messages with an empty
        // array. Mirrors the `reason` guard immediately above: 400 BEFORE
        // touching the database, rather than coercing to a safe-looking
        // default that quietly destroys data.
        if (isset($decoded['messages']) && !is_array($decoded['messages'])) {
            return Response::error('messages must be an array', 400);
        }

        $messages = isset($decoded['messages']) && is_array($decoded['messages'])
            ? $decoded['messages']
            : [];
        $reason = isset($decoded['reason']) ? (string) $decoded['reason'] : null;

        if (!$this->taskVisible($tenantId, $callerOuId, $taskId)) {
            return Response::error('Task not found', 404);
        }

        $encodedMessages = json_encode($messages, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encodedMessages === false) {
            $encodedMessages = '[]';
        }

        try {
            // WHOLE-BRANCH REVIEW: the ON CONFLICT DO UPDATE arm used to carry
            // no tenant_id predicate at all, unlike every other write in this
            // codebase (see this class's own docblock re: the C1/Task 13
            // OU/tenant conventions applied elsewhere). Safe TODAY only because
            // of two facts holding simultaneously -- the UNIQUE constraint this
            // upsert conflicts on is `UNIQUE (task_id)`, task_id is globally
            // unique (never reused across tenants), and taskVisible() above
            // already tenant/OU-scoped it before this statement ever runs -- so
            // an explicit WHERE here is structural defense-in-depth, not a
            // behaviour change: it can only ever narrow an already-tenant-scoped
            // conflict target, never widen it. :tenant_id_conflict is a
            // separate placeholder from :tenant_id (bound to the same value)
            // rather than reusing the name, matching this codebase's own
            // convention elsewhere (see e.g. SectionsApiHandler::delete()'s own
            // docblock) for binding the same value under several placeholder
            // names within one statement.
            $upsert = $this->db->prepare(
                'INSERT INTO tasker_task_discussions (public_id, tenant_id, task_id, messages, reason, created_at, updated_at)
                 VALUES (:public_id, :tenant_id, :task_id, :messages, :reason, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (task_id) DO UPDATE SET messages = :messages, reason = :reason, updated_at = CURRENT_TIMESTAMP
                 WHERE tasker_task_discussions.tenant_id = :tenant_id_conflict'
            );
            $upsert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':task_id' => $taskId,
                ':messages' => $encodedMessages,
                ':reason' => $reason,
                ':tenant_id_conflict' => $tenantId,
            ]);

            return $this->get($tenantId, $callerOuId, $taskId);
        } catch (\Throwable) {
            return Response::error('Failed to save discussion', 500);
        }
    }

    /**
     * Whether $taskId exists, belongs to $tenantId, AND its OWN PROJECT is
     * within $callerOuId's OU-descendant scope. tasker_tasks itself carries
     * no ou_id column, so this joins up to tasker_projects (the only table
     * that does) and applies {@see OuScopeResolver::whereFragment()} there —
     * the same static-SQL-template pattern used throughout this fix.
     *
     * D1b Task 13 FIX: this join used to bind tenant_id on tasker_tasks only,
     * never on tasker_projects — a divergence from
     * {@see \Tasker\Api\TasksApiHandler::findVisible()}'s own both-sides
     * convention (this codebase's standard; see that method's own doc). Not
     * reachable through any route today (no route can create a cross-tenant
     * task->project link), but fixed here as the natural moment since this
     * task is already touching every sibling join.
     */
    private function taskVisible(int $tenantId, ?int $callerOuId, int $taskId): bool
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT 1 FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.id = :id AND t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}"
        );
        $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
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
