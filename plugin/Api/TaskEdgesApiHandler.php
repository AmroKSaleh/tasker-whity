<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Tasker\Domain\FlowCycleException;
use Tasker\Domain\FlowStepSorter;
use Whity\Sdk\Http\Response;

/**
 * set_task_input/remove_task_input (D5a Task 7) — the I/O edges between
 * tasks, and the heart of this slice: every edge mutation re-stamps the
 * owning flow's topological order in the SAME transaction as the edge
 * write itself, and refuses any edge that would close a dependency cycle.
 *
 * Postgres-only, like every other OU-aware handler in this plugin
 * ({@see \Tasker\Api\SectionsApiHandler}'s own docblock explains why):
 * {@see self::taskInfo()} calls {@see OuScopeResolver::whereFragment()}
 * unconditionally, which emits PostgreSQL's `= ANY(:scope)` and fails at
 * `PDO::prepare()` under SQLite. There is deliberately no SQLite-backed
 * TaskEdgesApiHandlerTest — every test for this class lives in
 * {@see \Tasker\Tests\TenantIsolationOuTest}.
 *
 * CYCLE DETECTION IS NOT SCOPED TO A FLOW, EVEN THOUGH THE BRIEF'S OWN Step 3
 * TEXT SAYS "load the edges among the flow's members and re-sort" — a real
 * gap in the brief found while implementing this task. Two edges are legal
 * between tasks that are in NO flow at all (see {@see self::setInput()}'s own
 * docblock, and the brief's own requirement #1), so "the flow's members" is
 * EMPTY for that case — yet the brief's own cycle-rejection test
 * (testSetInputRefusesAnEdgeThatWouldCloseACycle) constructs two UNFLOWED
 * tasks and still requires a 422. A cycle check that only ran over "the
 * flow's members" would silently skip it for exactly the case the test
 * exercises. The fix: cycle detection here is a GLOBAL invariant on the I/O
 * graph, independent of flow membership — {@see self::assertNoCycleAround()}
 * walks the actual edge graph (bounded to the sub-graph that could possibly
 * be affected — see its own docblock for the standard DAG-edge-insertion
 * theorem this relies on), not "the current flow's members". Only the
 * SEPARATE re-STAMPING step ({@see self::recomputeFlowOrder()}) is scoped to
 * one flow's own membership — that part of the brief's Step 3 text is
 * correct, it is only the cycle CHECK that cannot be flow-scoped without
 * breaking the brief's own test.
 *
 * ATOMICITY: setInput()'s write phase — the optional replace-all delete, the
 * edge upsert, the cycle check, and the conditional flow re-stamp — is ONE
 * transaction. A cycle rolls the WHOLE thing back (the edge write included),
 * matching {@see \Tasker\Api\FlowsApiHandler}'s own "either everything
 * commits or nothing does" precedent. removeInput() is symmetric: its delete
 * and its conditional re-stamp share one transaction too, even though
 * removing an edge can never itself CREATE a cycle (removing a constraint
 * cannot close a loop that did not already exist) — kept transactional
 * anyway so a mid-flight failure never leaves the edge gone but flow_step
 * stale, and so {@see self::recomputeFlowOrder()} — shared by Tasks 7, 8 and
 * 10 — has exactly one contract regardless of caller.
 */
final class TaskEdgesApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * POST /api/tasker/tasks/input — upsert the edge feeding $targetTaskId
     * (the consumer) from $sourceTaskId (the producer), then re-stamp the
     * owning flow's topological order in the SAME transaction.
     *
     * ORDER (all inside one transaction, once both tasks are confirmed
     * visible and same-project outside it):
     *   1. if $replaceAll, delete the target's OTHER inbound edges;
     *   2. upsert the (source_task_id, target_task_id) edge;
     *   3. check the resulting graph for a cycle — see this class's own
     *      docblock for why this is NOT scoped to a flow;
     *   4. if $targetTaskId and $sourceTaskId share ONE non-null flow_id,
     *      re-stamp that flow's flow_step for every member;
     *   5. commit, or roll back the whole thing on a cycle.
     *
     * BOTH TASKS MIGHT BE UNFLOWED. The original permits I/O edges outside a
     * flow, and name_flow reads pre-existing edges when it stamps a flow's
     * initial order — so when $targetTaskId and $sourceTaskId do not share a
     * single non-null flow_id (either is unflowed, or they belong to two
     * DIFFERENT flows), there is no flow_step to re-stamp and step 4 above is
     * skipped entirely. Tested explicitly (the brief's own instruction) by
     * {@see \Tasker\Tests\TenantIsolationOuTest::testSetInputAllowsAnEdgeBetweenTwoUnflowedTasksAndStampsNothing()}.
     *
     * @param array<string, mixed>|null $contract
     */
    public function setInput(
        int $tenantId,
        ?int $callerOuId,
        int $targetTaskId,
        int $sourceTaskId,
        ?string $expectedType,
        ?array $contract,
        bool $replaceAll
    ): Response {
        // Caught here, not left to the database's own CHECK
        // (tasker_task_edges_no_self, Task 2): a self-edge would otherwise
        // surface as an uncaught PDOException and a bare 500, when the
        // caller's mistake is knowable before ever touching the database.
        if ($targetTaskId === $sourceTaskId) {
            return Response::error('task_id and source_task_id must be different tasks', 422);
        }

        $target = $this->taskInfo($tenantId, $callerOuId, $targetTaskId);
        if ($target === null) {
            return Response::error('Task not found', 404);
        }
        $source = $this->taskInfo($tenantId, $callerOuId, $sourceTaskId);
        if ($source === null) {
            return Response::error('Source task not found', 404);
        }

        if ($target['project_id'] !== $source['project_id']) {
            return Response::error('task_id and source_task_id must belong to the same project', 422);
        }

        // Guard `[] -> '{}'` -- json_encode([]) produces the JSON ARRAY "[]",
        // not "{}", and this column is read back as an OBJECT (see
        // FlowsApiHandler::updateContext()'s own identical guard/doc for the
        // jsonb `||` hazard this same shape exists to avoid elsewhere).
        $encodedContract = null;
        if ($contract !== null) {
            $encodedContract = $contract === [] ? '{}' : json_encode($contract);
            if ($encodedContract === false) {
                $encodedContract = '{}';
            }
        }

        try {
            $this->db->beginTransaction();

            if ($replaceAll) {
                $deleteOthers = $this->db->prepare(
                    'DELETE FROM tasker_task_edges
                     WHERE tenant_id = :tenant_id AND target_task_id = :target_task_id AND source_task_id <> :source_task_id'
                );
                $deleteOthers->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
                $deleteOthers->bindValue(':target_task_id', $targetTaskId, PDO::PARAM_INT);
                $deleteOthers->bindValue(':source_task_id', $sourceTaskId, PDO::PARAM_INT);
                $deleteOthers->execute();
            }

            $upsert = $this->db->prepare(
                'INSERT INTO tasker_task_edges
                    (public_id, tenant_id, source_task_id, target_task_id, expected_type, contract, created_at)
                 VALUES
                    (:public_id, :tenant_id, :source_task_id, :target_task_id, :expected_type, :contract, CURRENT_TIMESTAMP)
                 ON CONFLICT (target_task_id, source_task_id) DO UPDATE SET
                    expected_type = :expected_type_u,
                    contract = :contract_u
                 WHERE tasker_task_edges.tenant_id = :tenant_id_conflict'
            );
            $upsert->bindValue(':public_id', self::generateUuidV4(), PDO::PARAM_STR);
            $upsert->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $upsert->bindValue(':source_task_id', $sourceTaskId, PDO::PARAM_INT);
            $upsert->bindValue(':target_task_id', $targetTaskId, PDO::PARAM_INT);
            $upsert->bindValue(':expected_type', $expectedType, $expectedType === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $upsert->bindValue(':expected_type_u', $expectedType, $expectedType === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $upsert->bindValue(':contract', $encodedContract, $encodedContract === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $upsert->bindValue(':contract_u', $encodedContract, $encodedContract === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $upsert->bindValue(':tenant_id_conflict', $tenantId, PDO::PARAM_INT);
            $upsert->execute();

            // The edge is now written. Check the graph it produced BEFORE
            // touching flow_step at all -- see this class's own docblock for
            // why this is a global check, not one scoped to a flow.
            $this->assertNoCycleAround($tenantId, $targetTaskId, $sourceTaskId);

            if ($target['flow_id'] !== null && $target['flow_id'] === $source['flow_id']) {
                $this->recomputeFlowOrder($tenantId, $target['flow_id']);
            }

            $this->db->commit();
        } catch (FlowCycleException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return Response::error(
                'Cannot set this input: it would close a dependency cycle: ' . implode(' -> ', $e->cycle()),
                422
            );
        } catch (\Throwable) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return Response::error('Failed to set task input', 500);
        }

        $row = $this->findEdge($tenantId, $sourceTaskId, $targetTaskId);
        if ($row === null) {
            return Response::error('Failed to set task input', 500);
        }

        return Response::json(['data' => $this->toPublicEdge($row)], 200);
    }

    /**
     * DELETE /api/tasker/tasks/input — remove the edge feeding
     * $targetTaskId from $sourceTaskId, then re-stamp the owning flow's
     * topological order in the SAME transaction (see this class's own
     * docblock for why this stays transactional even though a removal can
     * never itself create a cycle).
     *
     * UNLIKE the original's remove_task_input, $sourceTaskId is REQUIRED
     * here, never optional — see {@see \Tasker\TaskerPlugin::removeTaskInput()}'s
     * own docblock for why (this plugin's mutating-route rule: a mutation
     * never resolves its own target from a caller default), and
     * `parity-allowlist.php`'s own `remove_task_input` entry for the
     * resulting divergence.
     */
    public function removeInput(int $tenantId, ?int $callerOuId, int $targetTaskId, int $sourceTaskId): Response
    {
        $target = $this->taskInfo($tenantId, $callerOuId, $targetTaskId);
        if ($target === null) {
            return Response::error('Task not found', 404);
        }
        $source = $this->taskInfo($tenantId, $callerOuId, $sourceTaskId);
        if ($source === null) {
            return Response::error('Source task not found', 404);
        }

        try {
            $this->db->beginTransaction();

            $delete = $this->db->prepare(
                'DELETE FROM tasker_task_edges
                 WHERE tenant_id = :tenant_id AND target_task_id = :target_task_id AND source_task_id = :source_task_id'
            );
            $delete->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $delete->bindValue(':target_task_id', $targetTaskId, PDO::PARAM_INT);
            $delete->bindValue(':source_task_id', $sourceTaskId, PDO::PARAM_INT);
            $delete->execute();

            if ($delete->rowCount() === 0) {
                $this->db->rollBack();

                return Response::error('Input edge not found', 404);
            }

            if ($target['flow_id'] !== null && $target['flow_id'] === $source['flow_id']) {
                $this->recomputeFlowOrder($tenantId, $target['flow_id']);
            }

            $this->db->commit();
        } catch (FlowCycleException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return Response::error(
                'Cannot remove this input: the flow would be left with a dependency cycle: ' . implode(' -> ', $e->cycle()),
                422
            );
        } catch (\Throwable) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return Response::error('Failed to remove task input', 500);
        }

        return Response::json(
            ['data' => ['targetTaskId' => $targetTaskId, 'sourceTaskId' => $sourceTaskId, 'removed' => true]],
            200
        );
    }

    /**
     * Re-derives and re-stamps flow_step for every current member of
     * $flowId, from the edges among ITS OWN members only — mirroring
     * {@see \Tasker\Api\FlowsApiHandler::name()}'s own initial-stamp query
     * (both source and target IN-clauses scoped to the member set). Shared
     * by Tasks 7, 8 and 10's own edge/membership mutations — written once
     * here.
     *
     * Must always run INSIDE a transaction the CALLER already opened: this
     * method never begins or commits one of its own, so a thrown
     * {@see FlowCycleException} can still be rolled back alongside whatever
     * else that transaction wrote (the edge upsert/delete in this class's
     * own two public methods).
     *
     * A cycle here is NOT expected to be reachable from either of this
     * class's own two callers: setInput() already ran
     * {@see self::assertNoCycleAround()} over the strictly larger graph
     * (target's full forward-reachable set, a superset of any one flow's
     * membership) before ever calling this; removeInput() only ever removes
     * a constraint, which cannot close a loop that did not already exist.
     * Kept as a real check (not an assertion) anyway: this method is SHARED
     * by two future tasks whose own call sites this task cannot see, and a
     * silently-stale flow_step is worse than the small extra cost of a
     * belt-and-braces resort.
     *
     * @throws FlowCycleException
     */
    private function recomputeFlowOrder(int $tenantId, int $flowId): void
    {
        $members = $this->db->prepare(
            'SELECT id FROM tasker_tasks WHERE tenant_id = :tenant_id AND flow_id = :flow_id'
        );
        $members->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $members->bindValue(':flow_id', $flowId, PDO::PARAM_INT);
        $members->execute();
        /** @var list<int> $taskIds */
        $taskIds = array_map('intval', $members->fetchAll(PDO::FETCH_COLUMN));

        if ($taskIds === []) {
            return;
        }

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
            throw new FlowCycleException($sorted['cycle']);
        }

        foreach ($sorted['positions'] as $taskId => $step) {
            $stamp = $this->db->prepare(
                'UPDATE tasker_tasks SET flow_step = :flow_step, updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id AND flow_id = :flow_id'
            );
            $stamp->bindValue(':flow_step', $step, PDO::PARAM_INT);
            $stamp->bindValue(':id', $taskId, PDO::PARAM_INT);
            $stamp->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stamp->bindValue(':flow_id', $flowId, PDO::PARAM_INT);
            $stamp->execute();

            if ($stamp->rowCount() !== 1) {
                throw new \RuntimeException(
                    "Task {$taskId} could not be re-stamped -- it no longer belongs to flow {$flowId}"
                );
            }
        }
    }

    /**
     * Checks the I/O graph around a just-written edge (source=$sourceTaskId,
     * target=$targetTaskId, ALREADY committed to this transaction by the
     * caller) for a cycle, throwing {@see FlowCycleException} if one exists.
     *
     * DELIBERATELY NOT SCOPED TO A FLOW -- see this class's own docblock for
     * why: the brief's own cycle-rejection test constructs two tasks with no
     * flow at all, so "the flow's members" cannot be the node set here.
     *
     * THE GRAPH-THEORY SHORTCUT this relies on: in a DAG, adding edge (S, T)
     * closes a cycle if and only if T could already reach S BEFORE that edge
     * existed -- the standard single-edge-insertion cycle test. Since every
     * edge ever accepted by this method was itself checked the same way, the
     * graph was acyclic immediately before this write, so it suffices to
     * check whether $sourceTaskId is now reachable from $targetTaskId by
     * following existing edges FORWARD (source -> target) starting at
     * $targetTaskId -- {@see self::forwardReachable()}. The new edge itself
     * (source=$sourceTaskId, target=$targetTaskId) does not change that
     * computation: forwardReachable() only follows edges whose OWN
     * source_task_id is the current node, and the new edge's source is
     * $sourceTaskId, never $targetTaskId or any of ITS descendants, so it
     * can never appear as an outgoing edge partway through that walk.
     *
     * Bounding the node set to {$targetTaskId} ∪ forwardReachable($targetTaskId)
     * ∪ {$sourceTaskId} — rather than every task in the project — also avoids
     * a false rejection: running {@see FlowStepSorter::sort()} over an
     * OVER-broad set (e.g. "every task in the project") would report failure
     * on ANY cycle anywhere in that set, including one entirely unrelated to
     * this edge (theoretically reachable only through direct, validation-
     * bypassing writes such as this test suite's own insertEdgeDirect()
     * helper) -- this bounded set can only ever contain a cycle that this
     * specific edge is part of.
     *
     * @throws FlowCycleException
     */
    private function assertNoCycleAround(int $tenantId, int $targetTaskId, int $sourceTaskId): void
    {
        $descendants = $this->forwardReachable($tenantId, $targetTaskId);
        /** @var list<int> $taskIds */
        $taskIds = array_values(array_unique([$targetTaskId, $sourceTaskId, ...$descendants]));

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
            throw new FlowCycleException($sorted['cycle']);
        }
    }

    /**
     * Every task reachable from $startTaskId by following existing I/O edges
     * FORWARD (source -> target), directly or transitively -- i.e. every
     * task $startTaskId's output eventually feeds. Tenant-scoped only, never
     * project- or flow-scoped: an edge's two endpoints are already guaranteed
     * same-project by {@see self::setInput()}'s own 422 on every prior
     * insert, so tenant scoping alone is both necessary and sufficient.
     *
     * Depth-bounded the same way {@see OuScopeResolver::descendantIds()}
     * bounds its own recursive traversal, and for the identical reason: the
     * existing graph is guaranteed acyclic by this very check running on
     * every prior write THROUGH THIS CLASS, so the bound should never bite in
     * practice -- it exists only so a row written by some OTHER path (a
     * direct database write bypassing this class entirely, e.g. this
     * plugin's own test-only insertEdgeDirect() helper) can never turn this
     * recursive CTE into an infinite loop.
     *
     * @return list<int>
     */
    private function forwardReachable(int $tenantId, int $startTaskId, int $maxDepth = 1000): array
    {
        $stmt = $this->db->prepare(
            'WITH RECURSIVE reach(id, depth) AS (
                SELECT target_task_id, 1
                FROM tasker_task_edges
                WHERE tenant_id = :tenant_id AND source_task_id = :start_id
                UNION
                SELECT e.target_task_id, r.depth + 1
                FROM tasker_task_edges e
                JOIN reach r ON e.source_task_id = r.id
                WHERE e.tenant_id = :tenant_id_r AND r.depth < :max_depth
            )
            SELECT DISTINCT id FROM reach'
        );
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':start_id', $startTaskId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_r', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':max_depth', $maxDepth, PDO::PARAM_INT);
        $stmt->execute();

        /** @var list<int> $ids */
        $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

        return $ids;
    }

    /**
     * Whether $taskId exists, belongs to $tenantId, AND its OWN PROJECT is
     * within $callerOuId's OU-descendant scope -- the handler-level, defence-
     * in-depth check this class keeps even though the route
     * ({@see \Tasker\TaskerPlugin::setTaskInput()}/
     * {@see \Tasker\TaskerPlugin::removeTaskInput()}) already resolves both
     * identifiers OU-scoped via {@see \Tasker\Access\IdentifierResolver}
     * before ever reaching here. Mirrors
     * {@see \Tasker\Api\MilestonesApiHandler::taskVisible()}'s exact join
     * shape, but returns the row's own project_id/flow_id rather than a bare
     * bool -- this class needs both on every call (the cross-project 422 and
     * the shared-flow re-stamp decision), and a second round-trip to fetch
     * them separately would be pure waste.
     *
     * @return array{project_id:int, flow_id:?int}|null
     */
    private function taskInfo(int $tenantId, ?int $callerOuId, int $taskId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT t.project_id, t.flow_id FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.id = :id AND t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}"
        );
        $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }

        return [
            'project_id' => (int) $row['project_id'],
            'flow_id' => $row['flow_id'] !== null ? (int) $row['flow_id'] : null,
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findEdge(int $tenantId, int $sourceTaskId, int $targetTaskId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, source_task_id, target_task_id, expected_type, contract, created_at
             FROM tasker_task_edges
             WHERE tenant_id = :tenant_id AND source_task_id = :source_task_id AND target_task_id = :target_task_id'
        );
        $stmt->execute([
            ':tenant_id' => $tenantId,
            ':source_task_id' => $sourceTaskId,
            ':target_task_id' => $targetTaskId,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * Builds an `IN (:prefix0, :prefix1, ...)` fragment with FRESH,
     * uniquely-prefixed placeholder names for $ids -- copied from
     * {@see \Tasker\Api\FlowsApiHandler::inClause()}'s own identical helper
     * (duplicated per handler rather than shared -- see
     * {@see \Tasker\Api\ProjectsApiHandler::isUniqueViolation()}'s own doc
     * for why this codebase repeats small helpers like this rather than
     * factoring them out).
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
    private function toPublicEdge(array $row): array
    {
        $contract = $row['contract'] !== null ? json_decode((string) $row['contract'], true) : null;

        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'sourceTaskId' => (int) $row['source_task_id'],
            'targetTaskId' => (int) $row['target_task_id'],
            'expectedType' => $row['expected_type'] !== null ? (string) $row['expected_type'] : null,
            'contract' => is_array($contract) ? $contract : null,
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
