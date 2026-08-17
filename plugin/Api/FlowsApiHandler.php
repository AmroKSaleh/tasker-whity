<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Tasker\Domain\FlowStepSorter;
use Tasker\Domain\ShortIdAllocator;
use Whity\Sdk\Http\Response;

/**
 * name_flow/list_flows/delete_flow (D5a Task 5) — the flow-creating call and
 * its two siblings.
 *
 * Postgres-only, like every other OU-aware handler in this plugin
 * ({@see \Tasker\Api\SectionsApiHandler}'s own docblock explains why):
 * flowVisible()/projectVisible()/list() all call
 * {@see OuScopeResolver::whereFragment()} unconditionally, which emits
 * PostgreSQL's `= ANY(:scope)` and fails at `PDO::prepare()` under SQLite.
 * There is deliberately no SQLite-backed FlowsApiHandlerTest — every test for
 * this class lives in {@see \Tasker\Tests\TenantIsolationOuTest}.
 *
 * Flows carry no ou_id of their own (see CreateTaskerFlowsTable, D5a Task 2)
 * — they inherit OU scope entirely through their project, so every OU-aware
 * query here joins tasker_projects and applies OuScopeResolver on
 * `p.ou_id`, binding tenant_id on both sides of the join, exactly like
 * {@see \Tasker\Access\IdentifierResolver::flowByColumn()}.
 *
 * name()'s OWN OU check (projectVisible()) is DEFENCE IN DEPTH: the route
 * (TaskerPlugin::nameFlow()) already resolves project_id through
 * IdentifierResolver::resolveProject() (OU-scoped) before ever calling this
 * method. Kept anyway, matching SectionsApiHandler::create()/
 * GroupsApiHandler::create()/TasksApiHandler::create()'s own identical
 * precedent — see any of their docblocks for why a handler safe only because
 * every current caller happens to be careful is one future call site away
 * from not being safe.
 *
 * ATOMICITY — name() DEVIATES from the brief's literal "runs in one
 * transaction" instruction, and this is a DELIBERATE, DOCUMENTED fix for a
 * real conflict in that instruction, not an oversight:
 *
 * The brief also says to insert the flow row via
 * {@see ShortIdAllocator::withRetry()}, "copy[ing] the shape" of
 * {@see TasksApiHandler::create()}'s own call — and THAT method's sibling
 * {@see TasksApiHandler::moveToProject()} documents, at length, exactly why
 * withRetry() must NOT run inside an explicit BEGIN/COMMIT block on real
 * PostgreSQL: withRetry() recovers from a lost short_id race by catching a
 * PDOException and retrying with a freshly computed candidate, but Postgres
 * aborts an ENTIRE transaction block on the FIRST error any statement inside
 * it raises. Wrap withRetry() in an explicit transaction and a caught
 * race-loss poisons the surrounding transaction: the retry's own next SELECT
 * fails immediately with "current transaction is aborted" (SQLSTATE 25P02)
 * instead of actually retrying — and isRaceLoss() does not recognise 25P02 as
 * a race, so withRetry() rethrows it immediately. Worse, tasker_flows ALSO
 * carries `UNIQUE (project_id, name)` (tasker_tasks has no equivalent, so
 * this half of the conflict is new to this table): isRaceLoss() treats ANY
 * SQLSTATE 23505 as a lost race unconditionally (see its own docblock — it
 * does not check WHICH constraint fired), so a genuine, deterministic
 * duplicate-flow-name INSERT would ALSO be (wrongly) retried, and if that
 * whole call sat inside an explicit transaction, the second attempt's own
 * SELECT MAX(short_id) would hit the SAME 25P02-abort wall — turning an
 * ordinary, nameable 409 into a confusing, generic 500.
 *
 * So: validation (task-project membership, edge loading, topological sort) is
 * ENTIRELY READ-ONLY and runs BEFORE any write, which is what actually
 * guarantees "a cycle/invalid task 422 leaves nothing written" — no
 * transaction is needed for that half at all. The flow row is then inserted
 * UN-TRANSACTED via ShortIdAllocator::withRetry() (exactly like
 * TasksApiHandler::create(), so its retry-on-race behaviour works exactly as
 * documented, and a genuine duplicate name surfaces as the intended 409 via
 * isUniqueViolation()). ONLY the per-member stamp loop right after — the part
 * the brief is actually worried about ("a flow that exists with half its
 * members stamped is a corrupt row") — runs inside a real transaction, so a
 * partial-stamp failure rolls every stamp back. If the stamp transaction
 * itself fails, the already-committed flow row is deleted as a compensating
 * action so the operation is atomic from the CALLER's point of view (either a
 * fully-formed, fully-stamped flow exists, or nothing does) even though it is
 * not implemented as one literal SQL transaction.
 */
final class FlowsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * POST /api/tasker/flows/name — the flow-CREATING call. See this class's
     * own docblock for the full atomicity reasoning.
     *
     * @param list<int> $taskIds
     * @param array<string, mixed>|null $context
     */
    public function name(
        int $tenantId,
        ?int $callerOuId,
        int $projectId,
        string $name,
        array $taskIds,
        ?array $context,
        bool $stepListOpen,
        ?int $createdBy
    ): Response {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        /** @var list<int> $taskIds */
        $taskIds = array_values(array_unique(array_map('intval', $taskIds)));
        if ($taskIds === []) {
            return Response::error('task_ids must be a non-empty array', 400);
        }

        if (!$this->projectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        // ---- Read-only validation. Nothing is written below this point
        // until every check has passed (see this class's own ATOMICITY note)
        // — a 422 here always leaves the database untouched. ----

        [$memberSql, $memberParams] = self::inClause('m', $taskIds);
        $membership = $this->db->prepare(
            "SELECT id FROM tasker_tasks WHERE tenant_id = :tenant_id AND project_id = :project_id AND id IN ({$memberSql})"
        );
        $membership->execute([':tenant_id' => $tenantId, ':project_id' => $projectId] + $memberParams);
        /** @var list<int> $validIds */
        $validIds = array_map('intval', $membership->fetchAll(PDO::FETCH_COLUMN));

        $offenders = array_values(array_diff($taskIds, $validIds));
        if ($offenders !== []) {
            return Response::error(
                'task_ids must all belong to project ' . $projectId . '; offending id(s): ' . implode(', ', $offenders),
                422
            );
        }

        // Edges among the flow's own members, in BOTH directions — a task
        // outside the flow constrains nothing inside it, and
        // FlowStepSorter::sort() already ignores an edge that reaches one
        // (see its own docblock), so this could over-fetch slightly rather
        // than under-fetch and still be correct; it does not, because both
        // the source and target IN-clauses are scoped to $taskIds.
        //
        // Two SEPARATE placeholder namespaces ('s'/'t') for the same
        // $taskIds list, never the SAME placeholder name reused twice in one
        // SQL string — pdo_pgsql's native prepare rejects that (the same
        // reason IdentifierResolver::taskByColumn() binds :tenant_id and
        // :tenant_id_p separately).
        [$sourceSql, $sourceParams] = self::inClause('s', $taskIds);
        [$targetSql, $targetParams] = self::inClause('t', $taskIds);
        $edgeStmt = $this->db->prepare(
            "SELECT source_task_id AS source, target_task_id AS target
             FROM tasker_task_edges
             WHERE tenant_id = :tenant_id AND source_task_id IN ({$sourceSql}) AND target_task_id IN ({$targetSql})"
        );
        $edgeStmt->execute([':tenant_id' => $tenantId] + $sourceParams + $targetParams);
        /** @var list<array{source:int,target:int}> $edges */
        $edges = array_map(
            /** @param array<string, mixed> $row */
            static fn (array $row): array => ['source' => (int) $row['source'], 'target' => (int) $row['target']],
            $edgeStmt->fetchAll(PDO::FETCH_ASSOC)
        );

        $sorted = FlowStepSorter::sort($taskIds, $edges);
        if (!$sorted['ok']) {
            return Response::error(
                'Cannot name a flow while its tasks form a dependency cycle: ' . implode(' -> ', $sorted['cycle']),
                422
            );
        }

        // ---- Write phase. See this class's own ATOMICITY note for why the
        // flow insert (below) is deliberately un-transacted while the stamp
        // loop (further below) is not. ----

        // An empty/absent context is encoded as the JSON OBJECT '{}', not the
        // JSON ARRAY '[]' a bare `json_encode([])` would produce: PHP treats
        // both identically on decode (json_decode('[]', true) === []), but
        // tasker_flows.context's own DEFAULT is the object form (see
        // CreateTaskerFlowsTable), and a non-PHP consumer (a JS/TS client
        // reading this column back over the wire) does NOT treat `[]` and
        // `{}` as interchangeable.
        $encodedContext = ($context === null || $context === []) ? '{}' : json_encode($context);
        if ($encodedContext === false) {
            $encodedContext = '{}';
        }

        try {
            $publicId = self::generateUuidV4();
            ShortIdAllocator::withRetry(
                $this->db,
                $tenantId,
                $projectId,
                function (int $candidate) use ($publicId, $tenantId, $projectId, $name, $encodedContext, $stepListOpen, $createdBy): void {
                    $insert = $this->db->prepare(
                        'INSERT INTO tasker_flows
                            (public_id, tenant_id, project_id, name, context, step_list_open, short_id, created_by, created_at, updated_at)
                         VALUES
                            (:public_id, :tenant_id, :project_id, :name, :context, :step_list_open, :short_id, :created_by, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
                    );
                    $insert->bindValue(':public_id', $publicId, PDO::PARAM_STR);
                    $insert->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
                    $insert->bindValue(':project_id', $projectId, PDO::PARAM_INT);
                    $insert->bindValue(':name', $name, PDO::PARAM_STR);
                    $insert->bindValue(':context', $encodedContext, PDO::PARAM_STR);
                    $insert->bindValue(':step_list_open', $stepListOpen, PDO::PARAM_BOOL);
                    $insert->bindValue(':short_id', $candidate, PDO::PARAM_INT);
                    $insert->bindValue(':created_by', $createdBy, $createdBy === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
                    $insert->execute();
                },
                'tasker_flows'
            );
        } catch (\Throwable $e) {
            if (self::isUniqueViolation($e)) {
                return Response::error('A flow named "' . $name . '" already exists in this project', 409);
            }

            return Response::error('Failed to create flow', 500);
        }

        // lastInsertId() is the row's true identity (PostgreSQL's BIGSERIAL
        // sequence via lastval()) — see TasksApiHandler::create()'s own doc
        // for why this is read AFTER withRetry() returns rather than trusting
        // its own return value (the successful short_id candidate, not the
        // row id).
        $flowId = (int) $this->db->lastInsertId();

        try {
            $this->db->beginTransaction();
            foreach ($sorted['positions'] as $taskId => $step) {
                $stamp = $this->db->prepare(
                    'UPDATE tasker_tasks SET flow_id = :flow_id, flow_step = :flow_step, updated_at = CURRENT_TIMESTAMP
                     WHERE id = :id AND tenant_id = :tenant_id'
                );
                $stamp->bindValue(':flow_id', $flowId, PDO::PARAM_INT);
                $stamp->bindValue(':flow_step', $step, PDO::PARAM_INT);
                $stamp->bindValue(':id', $taskId, PDO::PARAM_INT);
                $stamp->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
                $stamp->execute();
            }
            $this->db->commit();
        } catch (\Throwable) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            // Compensating cleanup: the flow row committed above must not
            // survive with zero stamped members — see this class's own
            // ATOMICITY note. Best effort; if this ALSO fails there is
            // nothing further this method can do.
            try {
                $cleanup = $this->db->prepare('DELETE FROM tasker_flows WHERE id = :id AND tenant_id = :tenant_id');
                $cleanup->execute([':id' => $flowId, ':tenant_id' => $tenantId]);
            } catch (\Throwable) {
                // Nothing more to do here; the primary error below still reports.
            }

            return Response::error('Failed to create flow', 500);
        }

        $row = $this->findScoped($flowId, $tenantId);
        if ($row === null) {
            return Response::error('Failed to create flow', 500);
        }

        return Response::json(['data' => $this->toPublicFlow($row)], 201);
    }

    /**
     * GET /api/tasker/flows?project_id= — $projectId null lists every flow
     * visible to the caller across the whole tenant/OU scope (no project
     * filter); non-null narrows to that one project. See
     * TaskerPlugin::listFlows()'s own docblock for how the route decides
     * between the two.
     */
    public function list(int $tenantId, ?int $callerOuId, ?int $projectId): Response
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        // The tenant/OU predicate is unconditional, static SQL text (never
        // built through a runtime-appended array) — the tenant-isolation
        // conformance scanner's own tenant-predicate check only recognises a
        // `tenant_id` comparison that is LITERALLY present in the SQL text it
        // reassembles from string literals/interpolation; a predicate hidden
        // inside a conditionally-appended array element (`$conditions[] =
        // '...tenant_id...'`, later `implode()`d in) is invisible to it by
        // design (see TenantPredicateScanner's own docblock: that shape is
        // reserved for a genuine "sees all tenants" exception). Only the
        // project_id filter — genuinely optional, not a security predicate —
        // is appended dynamically, mirroring
        // {@see TasksApiHandler::listFiltered()}'s own `$extra` fragment.
        $extra = $projectId !== null ? ' AND f.project_id = :project_id' : '';

        try {
            $stmt = $this->db->prepare(
                "SELECT f.id, f.public_id, f.tenant_id, f.project_id, f.name, f.context, f.step_list_open, f.short_id,
                        f.created_by, f.created_at, f.updated_at, p.prefix
                 FROM tasker_flows f
                 JOIN tasker_projects p ON p.id = f.project_id
                 WHERE f.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}{$extra}
                 ORDER BY f.id ASC"
            );
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
            if ($projectId !== null) {
                $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
            }
            $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
            $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
            $stmt->execute();

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicFlow'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch flows', 500);
        }
    }

    /**
     * DELETE /api/tasker/flows — deletes the flow row ONLY.
     * `flow_id ON DELETE SET NULL` (AddTaskerTaskFlowAndContractColumns)
     * returns every member task to the board automatically; tasker_task_edges
     * is never touched — an edge joins two TASKS and is independent of flow
     * membership, so the I/O graph the flow's tasks share survives intact.
     *
     * flow_step is cleared EXPLICITLY, before the DELETE: the FK's
     * ON DELETE SET NULL is a single-column cascade action (it only clears
     * flow_id itself), so flow_step would otherwise survive as a stale,
     * orphaned value on a task whose flow_id is now NULL.
     */
    public function delete(int $tenantId, ?int $callerOuId, int $flowId): Response
    {
        if ($this->flowVisible($tenantId, $callerOuId, $flowId) === null) {
            return Response::error('Flow not found', 404);
        }

        try {
            $this->db->beginTransaction();

            $countStmt = $this->db->prepare(
                'SELECT COUNT(*) FROM tasker_tasks WHERE flow_id = :flow_id AND tenant_id = :tenant_id'
            );
            $countStmt->execute([':flow_id' => $flowId, ':tenant_id' => $tenantId]);
            $memberCount = (int) $countStmt->fetchColumn();

            $clearStep = $this->db->prepare(
                'UPDATE tasker_tasks SET flow_step = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE flow_id = :flow_id AND tenant_id = :tenant_id'
            );
            $clearStep->execute([':flow_id' => $flowId, ':tenant_id' => $tenantId]);

            $stmt = $this->db->prepare('DELETE FROM tasker_flows WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $flowId, ':tenant_id' => $tenantId]);

            $this->db->commit();

            return Response::json(['data' => ['id' => $flowId, 'tasksReturnedToBoard' => $memberCount]], 200);
        } catch (\Throwable) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return Response::error('Failed to delete flow', 500);
        }
    }

    /**
     * Whether $flowId exists, belongs to $tenantId, AND is within
     * $callerOuId's OU-descendant scope — the handler-level, defence-in-depth
     * check every mutating/single-id method in this class keeps even though
     * the route already resolved the identifier OU-scoped (see this class's
     * own docblock). Joins straight to tasker_projects, since flows carry no
     * ou_id of their own, exactly like
     * {@see \Tasker\Access\IdentifierResolver::flowByColumn()}.
     *
     * @return array<string, mixed>|null
     */
    private function flowVisible(int $tenantId, ?int $callerOuId, int $flowId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT f.id, f.public_id, f.tenant_id, f.project_id, f.name, f.context, f.step_list_open, f.short_id,
                    f.created_by, f.created_at, f.updated_at, p.prefix
             FROM tasker_flows f
             JOIN tasker_projects p ON p.id = f.project_id
             WHERE f.id = :id AND f.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}"
        );
        $stmt->bindValue(':id', $flowId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * Whether $projectId exists, belongs to $tenantId, AND is within
     * $callerOuId's OU-descendant scope — name()'s own defence-in-depth check
     * (see this class's own docblock), byte-for-byte the same shape as
     * {@see SectionsApiHandler::projectVisible()}.
     */
    private function projectVisible(int $tenantId, ?int $callerOuId, int $projectId): bool
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT 1 FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        return $stmt->fetch() !== false;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT f.id, f.public_id, f.tenant_id, f.project_id, f.name, f.context, f.step_list_open, f.short_id,
                    f.created_by, f.created_at, f.updated_at, p.prefix
             FROM tasker_flows f
             JOIN tasker_projects p ON p.id = f.project_id
             WHERE f.id = :id AND f.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId, ':tenant_id_p' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * Builds an `IN (:prefix0, :prefix1, ...)` fragment with FRESH,
     * uniquely-prefixed placeholder names for $ids — never the literal values
     * interpolated into SQL text. $ids are always internally-derived ints by
     * the time this is called (never raw caller text), but distinct
     * placeholder names are still required even so: pdo_pgsql's native
     * prepare rejects the SAME placeholder name appearing twice in one SQL
     * string (see IdentifierResolver::taskByColumn()'s own :tenant_id/
     * :tenant_id_p precedent), which matters here because name() calls this
     * twice (once for 's', once for 't') against the SAME $taskIds list.
     *
     * @param list<int> $ids
     * @return array{0: string, 1: array<string, int>}
     */
    private static function inClause(string $prefix, array $ids): array
    {
        $names = [];
        $params = [];
        foreach (array_values($ids) as $i => $id) {
            $name = ":{$prefix}{$i}";
            $names[] = $name;
            $params[$name] = $id;
        }

        return [implode(',', $names), $params];
    }

    /**
     * Whether $e was thrown for a unique-constraint violation (PostgreSQL
     * SQLSTATE 23505) — either tasker_flows's `(project_id, name)` or
     * `(project_id, short_id)` index. Duplicated per handler rather than
     * shared — see {@see ProjectsApiHandler::isUniqueViolation()}'s own doc
     * for why.
     */
    private static function isUniqueViolation(\Throwable $e): bool
    {
        return $e instanceof \PDOException && $e->getCode() === '23505';
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * "PREFIX-F<n>" when the flow's project has a prefix, "F<n>" otherwise, or
     * null when the flow has no short_id at all. Mirrors
     * {@see TasksApiHandler::renderShortId()}'s own fallback shape, with the
     * "F" marker {@see \Tasker\Access\IdentifierResolver}'s own
     * FLOW_SHORT_ID_PATTERN requires.
     */
    private static function renderFlowShortId(?string $prefix, ?int $shortId): ?string
    {
        if ($shortId === null) {
            return null;
        }

        return $prefix !== null ? "{$prefix}-F{$shortId}" : "F{$shortId}";
    }

    /**
     * Interprets a driver-returned boolean column value. Duplicated per
     * handler rather than shared — see
     * {@see TasksApiHandler::dbTruthy()}'s own doc for why.
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
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicFlow(array $row): array
    {
        $shortId = $row['short_id'] !== null ? (int) $row['short_id'] : null;
        $prefix  = isset($row['prefix']) && $row['prefix'] !== null ? (string) $row['prefix'] : null;
        $context = $row['context'] !== null ? json_decode((string) $row['context'], true) : [];

        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'projectId' => (int) $row['project_id'],
            'name' => (string) $row['name'],
            'context' => is_array($context) ? $context : [],
            'stepListOpen' => self::dbTruthy($row['step_list_open']),
            'shortId' => self::renderFlowShortId($prefix, $shortId),
            'createdBy' => $row['created_by'] !== null ? (int) $row['created_by'] : null,
            'createdAt' => (string) $row['created_at'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }
}
