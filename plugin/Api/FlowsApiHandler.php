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
 * ATOMICITY — name() runs in ONE real transaction, insert AND stamp loop
 * both, matching the brief's literal instruction. An earlier version of this
 * class argued that was impossible alongside the brief's OTHER instruction to
 * insert via {@see ShortIdAllocator::withRetry()} (which recovers from a lost
 * short_id race by catching a PDOException and retrying with a freshly
 * computed candidate) — Postgres aborts an ENTIRE transaction block on the
 * FIRST error any statement inside it raises, so a caught race-loss would
 * normally poison the surrounding transaction and make the retry's own next
 * SELECT fail immediately with "current transaction is aborted" (SQLSTATE
 * 25P02) instead of actually retrying. That conclusion was WRONG: wrapping
 * each individual insert ATTEMPT in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`
 * (inside the withRetry() closure — see name()'s own comments) rescues the
 * retry without ever leaving the outer transaction. A failed attempt rolls
 * back only to its savepoint, not out of the transaction, so the connection
 * is never poisoned and the next attempt's SELECT/INSERT runs normally. This
 * needed no change to {@see ShortIdAllocator} itself — the savepoint dance
 * lives entirely in this class's own closure.
 *
 * This is simpler than the previous shape, not just more literal: there is
 * no un-transacted insert, no separate compensating DELETE, and no
 * orphan-flow failure mode (a flow committed with zero stamped members
 * because the stamp loop failed AND the compensating delete also failed).
 * Either the whole transaction (insert + every stamp) commits, or none of it
 * does. A genuine duplicate flow name (tasker_flows' own
 * `UNIQUE (project_id, name)`) still surfaces as the intended 409 via
 * isUniqueViolation(): {@see ShortIdAllocator::isRaceLoss()} treats ANY
 * SQLSTATE 23505 as a lost race unconditionally (it does not check WHICH
 * constraint fired), so a duplicate name is retried MAX_ATTEMPTS times before
 * the last real 23505 propagates out — wasteful but not wrong, and not
 * something this task owns fixing (see ShortIdAllocator's own docblock).
 *
 * Validation (task-project membership, re-membership, edge loading,
 * topological sort) stays ENTIRELY READ-ONLY and runs BEFORE the transaction
 * even opens — a cycle/invalid-task/already-in-another-flow 422 leaves
 * nothing written and never even opens a transaction to roll back.
 *
 * THE STAMP LOOP'S OWN GUARD: the per-member `UPDATE` binds
 * `AND project_id = :project_id AND flow_id IS NULL`, not just `(id,
 * tenant_id)`, and throws unless `rowCount() === 1`. This is NOT redundant
 * with the transaction: the membership SELECT far above (which is also where
 * the re-membership check reads each member's CURRENT flow_id) and this
 * UPDATE are separated by the edge SELECT, the sort, and up to
 * `ShortIdAllocator::MAX_ATTEMPTS` insert attempts, and under READ COMMITTED
 * that snapshot can go stale in the window:
 *
 *   - a concurrent `move_task` committing in between would let a task that no
 *     longer belongs to `$projectId` still match a bare `(id, tenant_id)`
 *     UPDATE, silently producing the exact cross-project member the 422
 *     earlier in this method exists to prevent — closed by `project_id`;
 *   - a concurrent `delete_task` would make the UPDATE match 0 rows silently,
 *     and this method would return 201 for a flow quietly missing a member
 *     the caller named — closed by the `rowCount() === 1` check itself;
 *   - a SECOND `name_flow` call claiming this SAME task into a DIFFERENT flow,
 *     committing in the identical window, is the race twin of the
 *     re-membership guard above: that guard only refuses a member whose
 *     flow_id was ALREADY non-null as of ITS OWN read, so a concurrent claim
 *     landing strictly after it and before this UPDATE sails straight past
 *     it, and — without `flow_id IS NULL` here — this UPDATE would silently
 *     overwrite the concurrent claim's flow_id with this call's own, exactly
 *     the "steal a task, no warning" behaviour the re-membership guard exists
 *     to prevent, just reachable by a race instead of a sequential call.
 *     Closed by `flow_id IS NULL`, which is safe to add unconditionally:
 *     every member that reached this loop was already confirmed
 *     flow_id-null by the earlier read, so the clause only ever fires when
 *     something changed underneath us — precisely when it must.
 *
 * The transaction from item 1 does not close any of these three by itself —
 * the stale SELECT was already read before the transaction opened — so this
 * UPDATE's own three-part guard plus its rowCount() check is what actually
 * closes them, by rolling the WHOLE transaction back the instant any of the
 * three is detected.
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
            "SELECT id, flow_id FROM tasker_tasks
             WHERE tenant_id = :tenant_id AND project_id = :project_id AND id IN ({$memberSql})"
        );
        $membership->execute([':tenant_id' => $tenantId, ':project_id' => $projectId] + $memberParams);

        /** @var list<int> $validIds */
        $validIds = [];
        /** @var array<int, int> $existingFlowByTask task id => the OTHER flow it already belongs to */
        $existingFlowByTask = [];
        foreach ($membership->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $id = (int) $row['id'];
            $validIds[] = $id;
            if ($row['flow_id'] !== null) {
                $existingFlowByTask[$id] = (int) $row['flow_id'];
            }
        }

        $offenders = array_values(array_diff($taskIds, $validIds));
        if ($offenders !== []) {
            return Response::error(
                'task_ids must all belong to project ' . $projectId . '; offending id(s): ' . implode(', ', $offenders),
                422
            );
        }

        // REVIEW FIX: name() used to happily re-stamp a task that already
        // belonged to ANOTHER flow, silently stealing it out — a second
        // name_flow call over the same tasks returned 201 and left the FIRST
        // flow with zero members, with no warning on either side. Neither the
        // brief nor the plan addresses re-membership, so this is a deliberate
        // decision, not a contradiction of either: refuse outright, naming
        // both the offending task ids and the flow(s) they already belong to.
        // A caller who genuinely wants to re-home tasks can delete_flow first
        // (explicit), rather than name_flow silently emptying someone else's
        // flow as a side effect nobody asked for.
        if ($existingFlowByTask !== []) {
            $conflictFlowIds = array_values(array_unique($existingFlowByTask));
            [$flowSql, $flowParams] = self::inClause('ef', $conflictFlowIds);
            $flowNameStmt = $this->db->prepare(
                "SELECT id, name FROM tasker_flows WHERE tenant_id = :tenant_id AND id IN ({$flowSql})"
            );
            $flowNameStmt->execute([':tenant_id' => $tenantId] + $flowParams);
            /** @var array<int, string> $flowNames */
            $flowNames = [];
            foreach ($flowNameStmt->fetchAll(PDO::FETCH_ASSOC) as $flowRow) {
                $flowNames[(int) $flowRow['id']] = (string) $flowRow['name'];
            }

            $conflicts = [];
            foreach ($existingFlowByTask as $taskId => $flowId) {
                $conflicts[] = [
                    'task_id' => $taskId,
                    'flow_id' => $flowId,
                    'flow_name' => $flowNames[$flowId] ?? null,
                ];
            }

            return Response::error(
                'task_ids already belong to another flow; delete_flow that flow first to re-home its tasks',
                422,
                ['conflicts' => $conflicts]
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

        // REVIEW FIX: this class's own docblock used to argue that ONE real
        // transaction covering both the insert and the stamp loop was
        // impossible alongside ShortIdAllocator::withRetry() — wrong.
        // SAVEPOINT/ROLLBACK TO SAVEPOINT around each individual insert
        // ATTEMPT (inside the withRetry() closure) rescues the retry from
        // Postgres's whole-transaction-abort-on-error behaviour: a caught
        // race-loss rolls back only to the savepoint, not out of the
        // transaction, so the NEXT attempt's own SELECT/INSERT runs against a
        // live, un-poisoned transaction exactly as it would outside one. This
        // makes the brief's literal "one transaction" instruction genuinely
        // achievable, and it is simpler than the previous
        // un-transacted-insert-plus-compensating-delete shape: no orphan-flow
        // failure mode (there is nothing to compensate for — either the whole
        // transaction commits or none of it does), and a genuine duplicate
        // flow name still surfaces as 409 (isUniqueViolation() below), not a
        // confusing 500, because the LAST attempt's real 23505 is what
        // ultimately propagates once ShortIdAllocator::MAX_ATTEMPTS is spent.
        $publicId = self::generateUuidV4();

        try {
            $this->db->beginTransaction();

            ShortIdAllocator::withRetry(
                $this->db,
                $tenantId,
                $projectId,
                function (int $candidate) use ($publicId, $tenantId, $projectId, $name, $encodedContext, $stepListOpen, $createdBy): void {
                    // A fresh SAVEPOINT per attempt: on success it is
                    // RELEASEd (folded into the still-open outer
                    // transaction); on failure it is rolled back to —
                    // un-poisoning the outer transaction so the NEXT
                    // attempt's own statements do not immediately fail with
                    // "current transaction is aborted" (SQLSTATE 25P02) the
                    // way they would without this.
                    $this->db->exec('SAVEPOINT flow_insert_attempt');
                    try {
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
                    } catch (\Throwable $e) {
                        $this->db->exec('ROLLBACK TO SAVEPOINT flow_insert_attempt');
                        throw $e;
                    }
                    $this->db->exec('RELEASE SAVEPOINT flow_insert_attempt');
                },
                'tasker_flows'
            );

            // lastInsertId() is the row's true identity (PostgreSQL's
            // BIGSERIAL sequence via lastval()) — see TasksApiHandler::create()'s
            // own doc for why this is read AFTER withRetry() returns rather
            // than trusting its own return value (the successful short_id
            // candidate, not the row id). Still inside the SAME transaction:
            // lastval() reads the sequence state on this connection, which a
            // not-yet-committed INSERT already advanced.
            $flowId = (int) $this->db->lastInsertId();

            foreach ($sorted['positions'] as $taskId => $step) {
                // REVIEW FIX: keyed only on (id, tenant_id) before, with no
                // guard against what happened in the WINDOW between the
                // membership SELECT far above and this UPDATE (the edge
                // SELECT, the sort, and up to MAX_ATTEMPTS allocate-and-insert
                // retries all sit in between). Under READ COMMITTED a
                // concurrent move_task committing in that window could move a
                // task out of $projectId and this UPDATE would still find and
                // stamp it by bare id — producing exactly the cross-project
                // member the 422 above exists to prevent. Adding
                // `AND project_id = :project_id` closes that: a task that
                // moved out no longer matches, so rowCount() drops to 0.
                // A concurrent delete_task hits the same rowCount() === 0
                // case.
                //
                // SECOND REVIEW FIX: `AND flow_id IS NULL` closes the sibling
                // race straight back into the hole the re-membership guard
                // above (the `$existingFlowByTask` check) was written to
                // close — that guard only sees the state as of its OWN
                // membership SELECT, which runs before this transaction even
                // opens. If a SECOND name_flow call claims this SAME
                // currently-unflowed task into a DIFFERENT flow and commits
                // strictly between that SELECT and this UPDATE, the task's
                // project never changed, so the `project_id` guard alone
                // would not catch it — this UPDATE would silently overwrite
                // the concurrent claim's flow_id with this call's own,
                // exactly the "steal a task, no warning" behaviour the
                // re-membership guard exists to prevent, just reachable by a
                // race instead of a sequential call. `flow_id IS NULL` is
                // safe to add unconditionally: the re-membership guard above
                // already refused any member whose flow_id was non-null AS
                // OF that read, so at this point every member SHOULD have
                // flow_id IS NULL — the clause only ever fires when
                // something changed underneath us, which is exactly when it
                // must.
                //
                // Either race throws here, which rolls back the WHOLE
                // transaction (the flow insert included) rather than
                // returning 201 for a flow silently missing a member, wrongly
                // including a cross-project one, or having silently stolen
                // one out from under another flow.
                $stamp = $this->db->prepare(
                    'UPDATE tasker_tasks SET flow_id = :flow_id, flow_step = :flow_step, updated_at = CURRENT_TIMESTAMP
                     WHERE id = :id AND tenant_id = :tenant_id AND project_id = :project_id AND flow_id IS NULL'
                );
                $stamp->bindValue(':flow_id', $flowId, PDO::PARAM_INT);
                $stamp->bindValue(':flow_step', $step, PDO::PARAM_INT);
                $stamp->bindValue(':id', $taskId, PDO::PARAM_INT);
                $stamp->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
                $stamp->bindValue(':project_id', $projectId, PDO::PARAM_INT);
                $stamp->execute();

                if ($stamp->rowCount() !== 1) {
                    throw new \RuntimeException(
                        "Task {$taskId} could not be stamped -- it no longer belongs to project {$projectId}, or "
                        . 'was concurrently claimed by another flow, since this call\'s own validation read it'
                    );
                }
            }

            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if (self::isUniqueViolation($e)) {
                return Response::error('A flow named "' . $name . '" already exists in this project', 409);
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
     * GET /api/tasker/flows/context?flow_id= — the original's
     * get_flow_context, addressed by flow_id directly rather than "any task
     * in the flow" (see TaskerPlugin::getFlowContext()'s own docblock, and
     * this task's own parity-allowlist.php entry, for why that alternate
     * lookup form is not ported). Returns the SAME public flow shape
     * {@see self::toPublicFlow()} already returns from name()/list() —
     * context and stepListOpen are just two of its fields, and a caller
     * asking for "the context" loses nothing by getting the whole flow back
     * alongside it.
     */
    public function getContext(int $tenantId, ?int $callerOuId, int $flowId): Response
    {
        $row = $this->flowVisible($tenantId, $callerOuId, $flowId);
        if ($row === null) {
            return Response::error('Flow not found', 404);
        }

        return Response::json(['data' => $this->toPublicFlow($row)], 200);
    }

    /**
     * PATCH /api/tasker/flows/context — the original's update_flow_context,
     * narrowed to the two fields this backend actually models (context,
     * step_list_open); a caller-chosen rename or short_id change is not
     * ported (see this task's own parity-allowlist.php entry).
     *
     * MERGE VS REPLACE is byte-for-byte
     * {@see \Tasker\Api\ProjectsApiHandler::updateContext()}'s own shape: TWO
     * HARDCODED SQL LITERALS selected by the strictly-typed $merge bool,
     * never composed from caller input — `context = context ||
     * :context::jsonb` for merge, `context = :context::jsonb` for replace.
     * $context must already be a genuine JSON object by the time it reaches
     * here: validated by the ROUTE (TaskerPlugin::updateFlowContext(), via
     * the SAME {@see \Tasker\TaskerPlugin::isJsonObject()} helper
     * updateProjectContext()/nameFlow() already use — see this class's own
     * docblock for why a JSON ARRAY operand would make `||` APPEND instead
     * of merge), not re-validated here — the identical trust boundary
     * {@see \Tasker\Api\ProjectsApiHandler::updateContext()} itself keeps
     * (that method takes `array $context` with no internal JSON-shape check
     * either).
     *
     * step_list_open is OPTIONAL and independent of context entirely: null
     * leaves the column untouched (the SET list simply omits the fragment).
     * This is a genuinely optional VALUE, not a security predicate, so
     * appending it only when supplied follows this class's own list()
     * precedent for its `$extra` project_id filter — never a caller-supplied
     * value reaching SQL TEXT, only a server-decided structural choice
     * (present vs. absent) about which of two fixed fragments to include.
     *
     * @param array<string, mixed> $context
     */
    public function updateContext(
        int $tenantId,
        ?int $callerOuId,
        int $flowId,
        array $context,
        bool $merge,
        ?bool $stepListOpen
    ): Response {
        if ($this->flowVisible($tenantId, $callerOuId, $flowId) === null) {
            return Response::error('Flow not found', 404);
        }

        // An empty $context is encoded as the JSON OBJECT '{}', never the
        // JSON ARRAY a bare json_encode([]) would produce -- copied verbatim
        // from name()'s own identical guard (see that method's own comment).
        // This is NOT cosmetic here: PostgreSQL's jsonb `||` does not treat
        // an object concatenated with an ARRAY as a no-op merge -- it WRAPS
        // the object as a new array element (`'{"a":1}'::jsonb ||
        // '[]'::jsonb` = `[{"a": 1}]`), so passing the caller's `[]` (or this
        // route's own "context omitted" no-op default) straight through
        // json_encode() would silently replace an existing flow's context
        // object with a ONE-ELEMENT ARRAY wrapping it -- corrupting the very
        // no-op this call is supposed to be.
        $encoded = ($context === []) ? '{}' : json_encode($context);
        if ($encoded === false) {
            return Response::error('context could not be encoded as JSON', 400);
        }

        $assignment = $merge ? 'context = context || :context::jsonb' : 'context = :context::jsonb';
        $stepListOpenAssignment = $stepListOpen !== null ? ', step_list_open = :step_list_open' : '';

        try {
            $stmt = $this->db->prepare(
                "UPDATE tasker_flows SET {$assignment}{$stepListOpenAssignment}
                 WHERE id = :id AND tenant_id = :tenant_id"
            );
            $stmt->bindValue(':context', $encoded, PDO::PARAM_STR);
            if ($stepListOpen !== null) {
                $stmt->bindValue(':step_list_open', $stepListOpen, PDO::PARAM_BOOL);
            }
            $stmt->bindValue(':id', $flowId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();
        } catch (\Throwable) {
            return Response::error('Failed to update flow context', 500);
        }

        // findScoped() (tenant-only), not a second flowVisible() call: the OU
        // check already passed above, at the top of this method, against the
        // SAME $tenantId/$callerOuId/$flowId that have not changed since —
        // matching name()'s own identical precedent for reading back a row
        // this method just confirmed/wrote (see name()'s own use of
        // findScoped() after its insert, for the same reason).
        $updated = $this->findScoped($flowId, $tenantId);
        if ($updated === null) {
            return Response::error('Flow not found', 404);
        }

        return Response::json(['data' => $this->toPublicFlow($updated)], 200);
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
