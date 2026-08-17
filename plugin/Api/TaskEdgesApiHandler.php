<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Tasker\Domain\ContractDeriver;
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
 * THE RE-STAMP GATE IS `$targetTaskId['flow_id'] !== null` ALONE (REVIEW FIX,
 * round 2) — not "$targetTaskId and $sourceTaskId share one non-null
 * flow_id", which is what the first draft shipped with. Every edge either
 * public method mutates has $targetTaskId as ONE of its two endpoints: the
 * upsert in setInput(), AND every replace-all collateral row it deletes in
 * the SAME call, AND the single row removeInput() deletes. So $targetTaskId's
 * OWN flow is the ONLY flow whose internal edge set (both endpoints members)
 * this class can ever change in one call — $sourceTaskId's flow_id is
 * irrelevant to that question, whether $sourceTaskId is unflowed, in the
 * SAME flow, or in a DIFFERENT one. The old, narrower gate broke exactly on
 * replace_all: reproduced live as flow={bb, aa} (aa -> bb, order stamped
 * aa=1/bb=2), then `setInput(target=bb, source=outsider, replace_all=true)`
 * where outsider is UNFLOWED — the replace-all delete removes aa -> bb (an
 * edge INTERNAL to the flow), the call returns 200, but the old gate
 * (`bb.flow_id === outsider.flow_id`) was false, so flow_step silently kept
 * describing an edge that no longer existed. {@see self::recomputeFlowOrder()}
 * is idempotent, so widening the gate to "target has ANY flow" costs
 * nothing on every call where the narrower gate was already correct.
 *
 * ATOMICITY, taken together with LOCKING (REVIEW FIX, round 2): both
 * methods' write phase — replace-all delete, upsert/delete, cycle check
 * (setInput() only), conditional flow re-stamp — is ONE transaction that
 * OPENS BY TAKING `SELECT id FROM tasker_projects WHERE id = :project_id
 * AND tenant_id = :tenant_id FOR UPDATE` on the shared project row, via
 * {@see self::lockProject()}. This is {@see \Tasker\Api\SectionsApiHandler}'s
 * own established pattern, not a new one — see that class's own docblock
 * for why: a predicate over SIBLING rows a write never touches (there, the
 * last-section guard; here, "is there already a path back to this edge's
 * source") cannot be folded into that write's own WHERE clause, and folding
 * was tried and empirically failed there. The FIRST DRAFT of this class
 * argued the cycle check could run entirely before any transaction opened,
 * and that removeInput()'s own re-stamp needed no lock at all — WRONG on
 * both counts, per review:
 *
 *   1. Two CONCURRENT setInput() calls that would TOGETHER close a cycle
 *      (call A: source=X target=Y; call B: source=Y target=X, racing) each
 *      see an acyclic graph in isolation under READ COMMITTED — neither
 *      sees the other's uncommitted row — and both could commit, leaving a
 *      real cycle in the table. A read-only check run before any lock is
 *      taken cannot close this; only serialising the two calls can.
 *   2. {@see self::recomputeFlowOrder()}'s own member SELECT and its stamp
 *      UPDATEs are separated by the edge SELECT and the sort. A task
 *      committed INTO the flow in that window is invisible to the SELECT,
 *      never stamped, and nothing detects it — the exact class of race
 *      {@see \Tasker\Api\FlowsApiHandler::name()}'s own stamp loop closes
 *      with `flow_id IS NULL`, but there is no equivalent guard here.
 *
 * Locking the PROJECT row (not the flow, not the edge) closes both:
 * membership changes and edge changes are both scoped to one project (an
 * edge's endpoints are always same-project, per this class's own 422; a
 * flow's members are always its project's tasks), so serialising on that
 * one row serialises every writer this class or a future Task 8/10 mutator
 * could race against. Same single row `SectionsApiHandler::delete()` already
 * locks, so no conflicting lock order is introduced — see that class's own
 * docblock, updated in this round to note it is no longer the plugin's only
 * `FOR UPDATE`.
 *
 * The cycle check still runs BEFORE the edge upsert (now: after the lock,
 * still before the write) — {@see self::assertNoCycleAround()} never writes
 * anything itself, so a rejected cycle still consumes zero
 * `tasker_task_edges_id_seq` values (Postgres sequence advances are never
 * rolled back, so consuming one on every rejection — what an even earlier
 * draft of this class did, by upserting FIRST and validating the written
 * row afterward — would be a real, if harmless, regression from
 * {@see \Tasker\Api\FlowsApiHandler::name()}'s own "nothing written until
 * every check has passed" bar). The transaction itself IS still opened on
 * every call now (to take the lock), unlike that bar's most literal reading
 * — but nothing is ever WRITTEN by a call that gets refused, which is the
 * property that actually matters and the one the test suite checks.
 *
 * removeInput() cannot itself create a cycle (removing a constraint cannot
 * close a loop that did not already exist), but it locks the SAME row for
 * the SAME reason as point 2 above: its own call to
 * {@see self::recomputeFlowOrder()} has the identical member-SELECT/stamp-
 * UPDATE window. {@see self::recomputeFlowOrder()} — shared by Tasks 7, 8
 * and 10 — has exactly one contract regardless of caller: always call it
 * inside a transaction that ALREADY holds this project's lock.
 *
 * ── D5a Task 8: the producer's own contract, and the blessing ──────────────
 *
 * THE BLESSING IS ONE BOOLEAN PER TASK (`tasker_tasks.output_contract_blessed`,
 * Task 2), and FOUR distinct writes reset it — the spec's own "blast radius"
 * decision, restated here because it is the whole point of the flag and it is
 * spread across four call sites:
 *
 *   {@see self::setOutput()}   → that task's own blessing
 *   {@see self::clearOutput()} → that task's own blessing
 *   {@see self::setInput()}    → BOTH ends of the edge (consumer AND producer),
 *                                PLUS every producer a `replace: true` call
 *                                silently unwires (REVIEW ROUND 1 — see
 *                                {@see self::unblessContractsFor()})
 *   {@see self::removeInput()} → BOTH ends of the edge (consumer AND producer)
 *
 * The rule underneath that list, which is what to reason from when a new
 * mutation lands here: THE RESET FOLLOWS THE DELETION (or the write), wherever
 * it happens. The four-way enumeration above is a consequence, not the
 * definition — enumerating per TOOL is exactly how the replace-all case got
 * missed, because one of those tools deletes edges as a side effect.
 *
 * All four go through {@see self::unblessContractsFor()} or the contract
 * write's own UPDATE, and every one of them binds the boolean with
 * `PDO::PARAM_BOOL` — an array-`execute()` binds `false` as `''`, which
 * PostgreSQL's boolean parser rejects outright (the same trap this file's own
 * test fixtures document for `pinned`).
 *
 * THE EDGE-WRITE PAIR IS A DELIBERATE DIVERGENCE, VERIFIED AGAINST THE
 * ORIGINAL (Task 8's Step 3, and the answer is recorded here so nobody has to
 * re-derive it): the original's `set_task_input` writes the CONSUMER's own
 * `tasks.input` JSON column and nothing else, resetting that EDGE's own
 * `contract.confirmed` flag — never either task's `output.contract.confirmed`.
 * `remove_task_input` likewise rewrites only the consumer's `input`. So the
 * original cascades to NEITHER end; we reset BOTH, per the spec: a producer
 * contract derived from its consumers' demands (Task 9's
 * `derive_output_contract` is exactly that) is only as valid as the demands it
 * came from, and a human blessing that silently outlives a change to those
 * demands is the precise failure the flag exists to prevent. Recorded as
 * SEMANTIC in `parity-allowlist.php` under both `set_task_input` and
 * `remove_task_input`, each naming its own behavioural test.
 *
 * ── D5a Task 9: deriving that contract from the consumers ─────────────────
 *
 * {@see self::deriveOutput()} builds a producer's contract FROM the demands its
 * consumers already declared on their input edges, which is the direction of
 * governance this whole I/O model assumes (see that method's own docblock, and
 * {@see \Tasker\Domain\ContractDeriver}, which is where the actual merge lives
 * — pure, and tested on the SQLite tier).
 *
 * IT ADDS NO FIFTH WRITER OF `output_contract_blessed`. The list above is still
 * exactly four: `derive_output_contract(apply: true)` persists by CALLING
 * {@see self::setOutput()}, so the contract write and the blessing reset stay in
 * that one method's single UPDATE. Worth stating explicitly, because "a new
 * mutation lands here" is precisely the moment the four-way enumeration above
 * invites someone to hand-roll a fifth copy of the invariant.
 *
 * NONE of the three new methods opens a transaction or takes
 * {@see self::lockProject()}, and that is deliberate rather than an omission:
 * each is a SINGLE-ROW `UPDATE tasker_tasks` with no cross-row predicate to
 * protect, none of them touches `flow_id` or any edge, so none can change a
 * flow's membership or its internal edge set, and therefore none has any
 * reason to call {@see self::recomputeFlowOrder()} — whose docblock requires
 * that lock of every caller.
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
     * ORDER:
     *   1. confirm both tasks visible and same-project (read-only, no
     *      transaction yet);
     *   2. open a transaction and take {@see self::lockProject()} on the
     *      shared project row — see this class's own docblock's LOCKING
     *      section for why this has to happen before the cycle check, not
     *      just before the write;
     *   3. UNDER THAT LOCK, check whether the CANDIDATE edge would close a
     *      cycle (see this class's own docblock for why the check is not
     *      scoped to a flow) — still before any write, so a rejection still
     *      consumes no sequence value even though a transaction is open;
     *   4. if $replaceAll, delete the target's OTHER inbound edges;
     *   5. upsert the (source_task_id, target_task_id) edge;
     *   6. if $targetTaskId's OWN flow_id is non-null, re-stamp that flow's
     *      flow_step for every member — gated on $targetTaskId alone, not
     *      "both share a flow" (REVIEW FIX: every edge this method ever
     *      writes, including a replace-all collateral DELETE, has
     *      $targetTaskId as one endpoint, so $targetTaskId's flow is the
     *      ONLY flow whose internal edge set this call can ever change; see
     *      this class's own docblock for the reproduction the old
     *      `target.flow_id === source.flow_id` gate missed);
     *   7. commit, or roll back the whole write phase on any failure.
     *
     * BOTH TASKS MIGHT BE UNFLOWED. The original permits I/O edges outside a
     * flow, and name_flow reads pre-existing edges when it stamps a flow's
     * initial order — so when $targetTaskId itself is unflowed, there is no
     * flow_step to re-stamp and step 6 above is skipped entirely. Tested
     * explicitly (the brief's own instruction) by
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

        // Filled in by the replace-all DELETE below, which RETURNs the
        // producers it unwires so their blessings can be reset alongside this
        // edge's own two ends.
        /** @var list<int> $displacedProducerIds */
        $displacedProducerIds = [];

        // ---- Write phase. Nothing above this line has written or is
        // capable of writing anything. The lock taken immediately below is
        // what makes the cycle check that follows it SAFE to trust -- see
        // this class's own docblock's LOCKING section for the concurrent
        // race this closes, which a read-only check taken before any lock
        // (this method's own first draft) could not. ----
        try {
            $this->db->beginTransaction();
            $this->lockProject($tenantId, $target['project_id']);

            // Still runs BEFORE the upsert -- see this class's own docblock
            // for why a rejection here still consumes no
            // tasker_task_edges_id_seq value even though a transaction is
            // already open.
            $this->assertNoCycleAround($tenantId, $targetTaskId, $sourceTaskId);

            // RETURNING source_task_id (REVIEW ROUND 1, the Important
            // finding): every producer this DELETE silently unwires has had
            // its demand destroyed just as surely as remove_task_input
            // destroys one, so each must be un-blessed too -- see
            // {@see self::unblessContractsFor()} for the invariant, and this
            // class's own docblock for why this DELETE is the most
            // defect-dense construct in the slice (Task 7's own Critical
            // finding was this same collateral delete leaving flow_step
            // stale).
            if ($replaceAll) {
                $deleteOthers = $this->db->prepare(
                    'DELETE FROM tasker_task_edges
                     WHERE tenant_id = :tenant_id AND target_task_id = :target_task_id AND source_task_id <> :source_task_id
                     RETURNING source_task_id'
                );
                $deleteOthers->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
                $deleteOthers->bindValue(':target_task_id', $targetTaskId, PDO::PARAM_INT);
                $deleteOthers->bindValue(':source_task_id', $sourceTaskId, PDO::PARAM_INT);
                $deleteOthers->execute();
                /** @var list<int> $displacedProducerIds */
                $displacedProducerIds = array_map('intval', $deleteOthers->fetchAll(PDO::FETCH_COLUMN));
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

            // D5a Task 8: the edge's rules just changed, so no human blessing
            // on EITHER end of it still describes rules a human actually saw.
            // Inside this transaction on purpose -- a rolled-back edge write
            // must not leave a blessing destroyed behind it. $displacedProducerIds
            // carries the replace-all case (REVIEW ROUND 1): a producer whose
            // edge was deleted as collateral above is in exactly the position
            // remove_task_input's own source is, and gets the same treatment.
            $this->unblessContractsFor(
                $tenantId,
                [$targetTaskId, $sourceTaskId, ...$displacedProducerIds]
            );

            // REVIEW FIX: gated on $targetTaskId's OWN flow_id alone -- see
            // this class's own docblock for why $sourceTaskId's flow_id is
            // irrelevant to whether THIS call could have changed $targetTaskId's
            // flow's internal edge set (it always could, if $targetTaskId is
            // flowed at all: the replace-all delete above touches ONLY edges
            // targeting $targetTaskId).
            if ($target['flow_id'] !== null) {
                $this->recomputeFlowOrder($tenantId, $target['flow_id']);
            }

            $this->db->commit();
        } catch (FlowCycleException $e) {
            // Not expected to be reachable: the read-only check above
            // already confirmed this exact edge is safe. Kept anyway as a
            // belt-and-braces guard against a race landing between that
            // check and this write (see this class's own docblock's
            // ATOMICITY note) -- rolling back here still leaves the
            // database exactly as it was before this call, just via
            // ROLLBACK rather than never having opened a transaction at all.
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
     *
     * Takes {@see self::lockProject()} even though removing an edge can
     * never itself create a cycle: {@see self::recomputeFlowOrder()}'s own
     * member-SELECT/stamp-UPDATE window is reachable here too (a task
     * committed into $targetTaskId's flow between this call's member SELECT
     * and its stamps would otherwise go un-stamped) — see this class's own
     * docblock's LOCKING section.
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
            $this->lockProject($tenantId, $target['project_id']);

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

            // D5a Task 8, same reasoning as setInput()'s own call: the rules
            // that governed this handoff are gone, so neither end's blessing
            // describes anything a human agreed to any more. Placed AFTER the
            // rowCount() check above, so the 404 path un-blesses nothing.
            // Exactly two ids here, always: this method deletes ONE named edge
            // and has no collateral of its own.
            $this->unblessContractsFor($tenantId, [$targetTaskId, $sourceTaskId]);

            // REVIEW FIX: gated on $targetTaskId's OWN flow_id alone, same
            // predicate as setInput() -- see that method's own docblock for
            // why. The removed edge's source flow_id is irrelevant here too.
            if ($target['flow_id'] !== null) {
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
     * POST /api/tasker/tasks/output — replace $taskId's OWN output contract:
     * the producer's single definition-of-done for the one artifact it
     * produces. Takes no target, by design — consumers are DERIVED (any task
     * listing this one as an edge source), never named here.
     *
     * A CONTRACT MUST BE A NON-EMPTY JSON OBJECT. That is one check more than
     * {@see \Tasker\TaskerPlugin::isJsonObject()} performs, and deliberately
     * so: that helper ACCEPTS `[]`, because `json_decode('{}', true)` and
     * `json_decode('[]', true)` produce the identical empty PHP array and it
     * refuses to guess which the caller sent (see its own docblock). An EDGE
     * contract may legitimately be empty — {@see self::setInput()} stores `[]`
     * as `'{}'`, since an edge with no rules is still a declared handoff, just
     * an ungated one. A PRODUCER contract is the payload of its own call:
     * `set_task_output` with nothing in it says nothing at all, and would
     * store a `{}` that {@see self::confirmContract()} could then bless as
     * though a human had agreed a quality bar. Refused with 422 instead.
     *
     * WRITING THE CONTRACT RESETS THE BLESSING — unconditionally, in the same
     * UPDATE, so there is no window in which the new rules are stored under
     * the old rules' blessing. See this class's own docblock for all four
     * resets and why the two edge ones diverge from the original.
     *
     * $contract is typed `array<array-key, mixed>` and NOT
     * `array<string, mixed>` like {@see self::setInput()}'s own — deliberately,
     * and PHPStan is what forced the question: with string keys promised in the
     * PHPDoc it reported the `array_is_list()` guard below as "will always
     * evaluate to false", i.e. dead code. It was right about the promise and
     * wrong about the value. Every caller's contract arrives from
     * `json_decode($body, true)`, which happily produces a LIST for a JSON
     * array, so the guard is the only thing standing between such a value and
     * `output_contract` — and refusing it is this method's own stated job, not
     * something it may assume its callers already did. Widening the declared
     * type to what the data really is makes the check honest instead of
     * silencing it.
     *
     * @param array<array-key, mixed> $contract
     */
    public function setOutput(int $tenantId, ?int $callerOuId, int $taskId, array $contract): Response
    {
        // `array_is_list([])` is TRUE, so this ONE check refuses BOTH shapes a
        // producer contract must refuse: a genuine JSON array (`[1, 2]` — a
        // non-empty list), and an empty object/array (`{}` / `[]`, which are
        // the same value by the time json_decode() has run). Spelt out because
        // that is easy to misread as covering only the first.
        if (array_is_list($contract)) {
            return Response::error('contract must be a non-empty JSON object', 422);
        }

        if ($this->taskInfo($tenantId, $callerOuId, $taskId) === null) {
            return Response::error('Task not found', 404);
        }

        $encoded = json_encode($contract);
        if ($encoded === false) {
            return Response::error('contract could not be encoded as JSON', 400);
        }

        try {
            $stmt = $this->db->prepare(
                'UPDATE tasker_tasks
                 SET output_contract = :contract::jsonb,
                     output_contract_blessed = :blessed,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id'
            );
            $stmt->bindValue(':contract', $encoded, PDO::PARAM_STR);
            $stmt->bindValue(':blessed', false, PDO::PARAM_BOOL);
            $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();
        } catch (\Throwable) {
            return Response::error('Failed to set task output contract', 500);
        }

        return $this->outputContractResponse($tenantId, $taskId);
    }

    /**
     * DELETE /api/tasker/tasks/output — drop $taskId's output contract, and
     * the blessing with it. The delete counterpart of {@see self::setOutput()};
     * nothing else on the task is touched (a stored artifact and validation
     * status are D5b's, and survive by construction — this UPDATE names two
     * columns).
     *
     * "NOTHING TO CLEAR" IS A 404, not a 200 that did nothing: the original
     * refuses the same call (`"…" has no output contract to clear.`), and this
     * class's own {@see self::removeInput()} already answers 404 for the
     * identical "no such thing to remove" shape. Detected from the UPDATE's own
     * `rowCount()` under an `output_contract IS NOT NULL` predicate rather than
     * a separate SELECT first, so there is no read-then-write race to lose.
     *
     * A BLESSING CAN NEVER OUTLIVE ITS CONTRACT, which is what makes that one
     * predicate sufficient: every writer of the flag is in this class or is
     * {@see self::confirmContract()}, which refuses to bless a task with no
     * contract at all — so `output_contract IS NULL AND output_contract_blessed`
     * is unreachable, and a row this predicate skips has nothing to reset.
     */
    public function clearOutput(int $tenantId, ?int $callerOuId, int $taskId): Response
    {
        if ($this->taskInfo($tenantId, $callerOuId, $taskId) === null) {
            return Response::error('Task not found', 404);
        }

        try {
            $stmt = $this->db->prepare(
                'UPDATE tasker_tasks
                 SET output_contract = NULL,
                     output_contract_blessed = :blessed,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id AND output_contract IS NOT NULL'
            );
            $stmt->bindValue(':blessed', false, PDO::PARAM_BOOL);
            $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();
        } catch (\Throwable) {
            return Response::error('Failed to clear task output contract', 500);
        }

        if ($stmt->rowCount() === 0) {
            return Response::error('Task has no output contract to clear', 404);
        }

        return $this->outputContractResponse($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/contract/confirm — the human blessing: flip
     * $taskId's output contract from AI-QA'd to human-blessed. The
     * highest-trust act on this surface, and the only write in this class that
     * sets the flag TRUE.
     *
     * OUTPUT-ONLY, unlike the original, which also confirms the contract on ONE
     * INPUT EDGE (`contract_type: "input"`, narrowed by `source_task_id`) and
     * records WHO confirmed it (`confirmed_by`, default `"human"`). Neither is
     * implementable in D5a BY SCHEMA rather than by choice: `tasker_task_edges`
     * has no blessing column (Task 2's columns are exactly id, public_id,
     * tenant_id, source_task_id, target_task_id, expected_type, contract,
     * created_at) and `tasker_tasks` has no confirmed_by/confirmed_at. Both are
     * recorded as genuine capability gaps in `parity-allowlist.php`, and
     * {@see \Tasker\TaskerPlugin::confirmContract()} REFUSES a
     * `contract_type` it cannot honour rather than silently blessing the output
     * contract instead — see that method's own docblock.
     *
     * REFUSES A TASK WITH NO CONTRACT (422, mirroring the original's own
     * `"…" has no output contract to confirm. Set one via set_task_output
     * first.`). That refusal is what keeps `output_contract_blessed = TRUE`
     * meaningful: it can only ever describe a contract that exists, which is
     * the invariant {@see self::clearOutput()}'s single-predicate UPDATE relies
     * on. 422 rather than 404 deliberately — the task WAS found, and a 404 here
     * would be indistinguishable from this plugin's out-of-scope answer.
     *
     * IDEMPOTENT: confirming an already-blessed contract matches its row and
     * answers 200 again, since a PostgreSQL UPDATE counts a row it re-writes
     * with the same value.
     */
    public function confirmContract(int $tenantId, ?int $callerOuId, int $taskId): Response
    {
        if ($this->taskInfo($tenantId, $callerOuId, $taskId) === null) {
            return Response::error('Task not found', 404);
        }

        try {
            $stmt = $this->db->prepare(
                'UPDATE tasker_tasks
                 SET output_contract_blessed = :blessed,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id AND output_contract IS NOT NULL'
            );
            $stmt->bindValue(':blessed', true, PDO::PARAM_BOOL);
            $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();
        } catch (\Throwable) {
            return Response::error('Failed to confirm the output contract', 500);
        }

        if ($stmt->rowCount() === 0) {
            return Response::error('Task has no output contract to confirm — set one first', 422);
        }

        return $this->outputContractResponse($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/output/derive — the derive half of the authoring
     * loop Task 8 opened: build $taskId's output contract FROM its consumers'
     * input-edge rules, rather than making a human hand-author what the
     * downstream tasks already declared. Read-only unless $apply.
     *
     * The merge itself is {@see ContractDeriver}, which is pure. This method is
     * everything that is not: resolve the producer OU-scoped, load its consumer
     * edges, label each consumer, and — with $apply — persist.
     *
     * "CONSUMERS" ARE THE EDGES WHERE THIS TASK IS THE **SOURCE**. In this
     * schema `tasker_task_edges.source_task_id` is the PRODUCER and
     * `target_task_id` is the CONSUMER (see {@see self::setInput()}, whose
     * $targetTaskId is the consumer), so a producer's consumers are found by
     * matching source_task_id. Reading the other direction would derive this
     * task's own definition-of-done from what it DEMANDS OF ITS INPUTS — rules
     * about somebody else's artifact, persisted as this task's promise. Pinned
     * by {@see \Tasker\Tests\TenantIsolationOuTest::testDeriveOutputReadsTheEdgesWhereTheTaskProducesNotTheOnesWhereItConsumes()}.
     *
     * APPLY REFUSES AN EMPTY DERIVATION WITH 422 rather than persisting it, and
     * that is not the same check {@see self::setOutput()} already makes:
     * `{"rules": []}` is a NON-EMPTY JSON object, so it sails straight past that
     * guard and would land a contract that says nothing — which
     * {@see self::confirmContract()} would then bless as a quality bar a human
     * agreed to. The refusal carries the assumptions, because "there was nothing
     * to derive" is only actionable if the caller is told which consumers said
     * nothing. A derivation with no rules is still a perfectly good READ
     * (`$apply === false` answers 200 with an empty draft and the assumptions
     * explaining it), so the refusal is scoped to the write.
     *
     * THE APPLY PATH GOES THROUGH {@see self::setOutput()} rather than issuing
     * its own UPDATE. That keeps this class at FOUR writers of
     * `output_contract_blessed`, not five: setOutput() already writes the
     * contract and resets the blessing in ONE statement, so there is no window
     * in which new rules sit under an old blessing, and this method inherits its
     * 404 and its non-empty-contract guard for free. Its 200 BODY is discarded
     * on purpose, though: the response below echoes the DRAFT rather than the
     * stored row, so `apply: true` and `apply: false` describe the same draft in
     * the same shape — jsonb normalises the key order inside each rule object on
     * the way in (verified live: `{label, rule, kind}` reads back as
     * `{kind, rule, label}`), which would otherwise make the applied response
     * gratuitously differ from the unapplied one. setOutput()'s own 200 is the
     * proof the write landed. Routing the
     * reset through {@see self::unblessContractsFor()} instead — the other
     * obvious way to avoid a fifth hand-rolled copy of the invariant — would
     * have been strictly worse HERE: that method deliberately touches only rows
     * that are ALREADY blessed and does not write a contract at all, so it would
     * still have needed a separate UPDATE beside it, splitting one atomic write
     * into two.
     *
     * NOT SERIALISED against a concurrent edge write, deliberately: a
     * `set_task_input` landing between the consumer-edge SELECT below and the
     * apply would leave a draft derived from demands that have since moved. The
     * blessing is what makes that safe rather than silent — that same edge write
     * un-blesses this producer (see this class's own docblock's four resets), so
     * the stored draft is unmistakably AI-QA'd and a human still has to look at
     * it. No lock is taken and no flow order is touched (nothing here changes
     * flow membership or any edge), so {@see self::recomputeFlowOrder()}'s
     * caller contract does not apply.
     */
    public function deriveOutput(int $tenantId, ?int $callerOuId, int $taskId, bool $apply): Response
    {
        if ($this->taskInfo($tenantId, $callerOuId, $taskId) === null) {
            return Response::error('Task not found', 404);
        }

        $derived = ContractDeriver::derive($this->consumerEdgesOf($tenantId, $callerOuId, $taskId));

        if (!$apply) {
            return self::derivationResponse($taskId, $derived, false);
        }

        if ($derived['rules'] === []) {
            // $derived['assumptions'] is never empty when there are no rules:
            // ContractDeriver reports either "no consumers at all" or, per
            // consumer, "declares no input rules". The first sentence stands on
            // its own anyway, so a future change there cannot leave this
            // message a fragment.
            return Response::error(
                'Nothing could be derived as an output contract, so nothing was applied. '
                . implode(' ', $derived['assumptions']),
                422
            );
        }

        $stored = $this->setOutput($tenantId, $callerOuId, $taskId, ['rules' => $derived['rules']]);
        if ($stored->getStatusCode() !== 200) {
            return $stored;
        }

        return self::derivationResponse($taskId, $derived, true);
    }

    /**
     * The 200 both halves of {@see self::deriveOutput()} return: the draft, the
     * assumptions it rests on, and whether it was persisted.
     *
     * `assumptions` is as much of the payload as `rules` is — a caller that
     * shows a human the draft and not the assumptions has shown them a bar that
     * looks authoritative and is not.
     *
     * @param array{rules: list<array<array-key, mixed>>, assumptions: list<string>} $derived
     */
    private static function derivationResponse(int $taskId, array $derived, bool $applied): Response
    {
        return Response::json(['data' => [
            'taskId' => $taskId,
            'rules' => $derived['rules'],
            'assumptions' => $derived['assumptions'],
            'applied' => $applied,
        ]], 200);
    }

    /**
     * Every edge on which $producerTaskId is the PRODUCER, as
     * {@see ContractDeriver::derive()}'s own input: one entry per consumer, that
     * consumer's human label, and the edge's own decoded contract (its demand on
     * this producer, or null where it declares none).
     *
     * OU-SCOPED, on top of the {@see self::taskInfo()} check
     * {@see self::deriveOutput()} already made on the PRODUCER. That is
     * defence in depth rather than a second real filter: every edge this API
     * writes has same-project endpoints ({@see self::setInput()}'s own 422), so
     * a consumer is always in the producer's own project and the predicate can
     * only ever be redundant — unless a row arrives by some other path (a direct
     * database write, e.g. this suite's own insertEdgeDirect() helper), in which
     * case dropping it is right: another OU's rule TEXT would otherwise be
     * quoted straight back to this caller in the derived draft.
     *
     * ORDERED, so the draft's rule order and its assumption order are properties
     * of the data and not of PostgreSQL's row-return order: by the consumer's
     * short id (the label a human reads), unnumbered consumers last, ties broken
     * by id. One static template, no runtime-branched ORDER BY.
     *
     * @return list<array{consumer_label: string, contract: array<array-key, mixed>|null}>
     */
    private function consumerEdgesOf(int $tenantId, ?int $callerOuId, int $producerTaskId): array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT c.id, c.text, c.short_id, p.prefix, e.contract
             FROM tasker_task_edges e
             JOIN tasker_tasks c ON c.id = e.target_task_id AND c.tenant_id = :tenant_id_c
             JOIN tasker_projects p ON p.id = c.project_id AND p.tenant_id = :tenant_id_p
             WHERE e.tenant_id = :tenant_id AND e.source_task_id = :source_task_id AND {$ouClause}
             ORDER BY c.short_id ASC NULLS LAST, c.id ASC"
        );
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_c', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':source_task_id', $producerTaskId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $edges = [];
        /** @var array<string, mixed> $row */
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $contract = $row['contract'] !== null ? json_decode((string) $row['contract'], true) : null;
            $edges[] = [
                'consumer_label' => self::consumerLabel(
                    $row['prefix'] !== null ? (string) $row['prefix'] : null,
                    $row['short_id'] !== null ? (int) $row['short_id'] : null,
                    (string) $row['text'],
                    (int) $row['id']
                ),
                'contract' => is_array($contract) ? $contract : null,
            ];
        }

        return $edges;
    }

    /**
     * How a consumer is named in a derived draft's assumptions: its SHORT ID
     * ("DRV-3", or the bare number when its project has no prefix), which is
     * both unambiguous and directly usable in the follow-up call the assumption
     * asks for (`set_task_input(task_id: "DRV-3", …)`).
     *
     * The original names consumers by their TEXT instead
     * (`derived_from: sources.map(s => s.text)`); a short id is preferred here
     * because task text is neither unique nor addressable. The text is still the
     * FALLBACK for a task with no short id at all (nothing allocates one
     * retroactively, and every pre-D1b row has none), with the id as a last
     * resort so an assumption can never name a consumer as "".
     *
     * The short-id rendering mirrors {@see \Tasker\Api\TasksApiHandler::renderShortId()}
     * exactly — duplicated per handler, as this codebase does with its small
     * private helpers (see {@see \Tasker\Api\ProjectsApiHandler::isUniqueViolation()}'s
     * own doc for why).
     */
    private static function consumerLabel(?string $prefix, ?int $shortId, string $text, int $taskId): string
    {
        if ($shortId !== null) {
            return $prefix !== null ? "{$prefix}-{$shortId}" : (string) $shortId;
        }

        $trimmed = trim($text);

        return $trimmed !== '' ? $trimmed : "task {$taskId}";
    }

    /**
     * Resets the human blessing on EVERY task whose contract-relevant demands
     * this call has just changed. See this class's own docblock for the
     * invariant and for what the original does instead.
     *
     * TAKES A LIST, NOT A FIXED PAIR (REVIEW ROUND 1, the Important finding).
     * The first version took exactly ($targetTaskId, $sourceTaskId) — the two
     * ends of the edge being written or deleted — which was one case short.
     * `set_task_input` with `replace: true` ALSO deletes every OTHER inbound
     * edge of the target, and each of those deletions destroys some producer
     * P2's only declared demand just as completely as `remove_task_input`
     * destroys one. P2 kept `output_contract_blessed = TRUE`, so the
     * byte-identical deletion un-blessed P2 through one tool and not through
     * the other. The governing rule is the spec's, and it says nothing about
     * WHICH gesture destroyed the demand: a producer contract is only as valid
     * as the demands it came from. So the reset follows the DELETION, wherever
     * the deletion happens, and the caller passes every id it touched.
     *
     * ONE STATIC SQL TEMPLATE regardless of how many ids arrive, per the
     * plan's global constraint — `id = ANY(:task_ids::bigint[])`, with the ids
     * bound as a single PostgreSQL array parameter. Same idiom
     * {@see OuScopeResolver::whereFragment()} already uses for its own
     * variable-length scope list, and deliberately NOT
     * {@see self::inClause()}'s generated `IN (:t0, :t1, ...)` fragment, which
     * would put a caller-influenced COUNT into the SQL text and re-prepare a
     * different statement per call shape. An empty list is a valid empty array
     * literal that matches nothing, so no caller needs a guard.
     *
     * MUST be called inside the caller's own transaction (both call sites are
     * mid-transaction already, holding {@see self::lockProject()}), so a
     * rolled-back edge write cannot leave a destroyed blessing behind it.
     *
     * Only rows that are ACTUALLY blessed are touched, via
     * `AND output_contract_blessed = TRUE`. That is not an optimisation: the
     * UPDATE also bumps `updated_at`, which
     * {@see \Tasker\Api\AttentionApiHandler}'s own staleness buckets rank on —
     * so touching every id on every edge write, blessed or not, would silently
     * make ordinary wiring look like fresh activity on tasks nothing about
     * actually changed.
     *
     * @param list<int> $taskIds every task whose demands this call changed —
     *        the edge's own two ends, plus any producer a replace-all delete
     *        unwired.
     */
    private function unblessContractsFor(int $tenantId, array $taskIds): void
    {
        $stmt = $this->db->prepare(
            'UPDATE tasker_tasks
             SET output_contract_blessed = :blessed, updated_at = CURRENT_TIMESTAMP
             WHERE tenant_id = :tenant_id
               AND id = ANY(:task_ids::bigint[])
               AND output_contract_blessed = TRUE'
        );
        $stmt->bindValue(':blessed', false, PDO::PARAM_BOOL);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':task_ids', '{' . implode(',', $taskIds) . '}', PDO::PARAM_STR);
        $stmt->execute();
    }

    /**
     * The 200 all three output-contract methods return: the task's contract as
     * a decoded JSON OBJECT plus its blessing, read back from the row rather
     * than echoed from the request — the same "read back what was actually
     * stored" shape {@see self::setInput()} uses via
     * {@see self::findEdge()}/{@see self::toPublicEdge()}.
     *
     * Tenant-scoped only, with no second OU check: every caller has already
     * passed {@see self::taskInfo()} for this exact
     * $tenantId/$callerOuId/$taskId triple and nothing has changed since —
     * {@see \Tasker\Api\FlowsApiHandler::updateContext()}'s own read-back after
     * its write applies the identical reasoning.
     */
    private function outputContractResponse(int $tenantId, int $taskId): Response
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, output_contract, output_contract_blessed
             FROM tasker_tasks
             WHERE id = :id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return Response::error('Task not found', 404);
        }

        $contract = $row['output_contract'] !== null ? json_decode((string) $row['output_contract'], true) : null;

        return Response::json(['data' => [
            'taskId' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'outputContract' => is_array($contract) ? $contract : null,
            'outputContractBlessed' => self::dbTruthy($row['output_contract_blessed']),
        ]], 200);
    }

    /**
     * Interprets a driver-returned boolean column value. Duplicated per
     * handler rather than shared — see
     * {@see \Tasker\Api\TasksApiHandler::dbTruthy()}'s own doc for why. NOT a
     * `(bool)` cast: pdo_pgsql can return a boolean column as the STRING "f",
     * and `(bool) 'f'` is `true` in PHP, so a naive cast would report every
     * unblessed contract as human-blessed — the single worst direction for
     * this particular flag to be wrong in.
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
     * `SELECT id FROM tasker_projects WHERE id = :project_id AND tenant_id
     * = :tenant_id FOR UPDATE` — serialises every writer this class (or a
     * future Task 8/10 membership mutator) could race against for the SAME
     * project. See this class's own docblock's LOCKING section for why a
     * project-row lock (not a flow- or edge-row lock) is both necessary and
     * sufficient, and for why it is {@see \Tasker\Api\SectionsApiHandler::delete()}'s
     * own established pattern, not a new one — same single row, so no
     * conflicting lock order is introduced between the two call sites.
     *
     * MUST be called after {@see \PDO::beginTransaction()} and before any
     * read this call's caller needs to trust (the cycle check in
     * setInput(); the member SELECT inside {@see self::recomputeFlowOrder()}
     * in both public methods) — PostgreSQL releases the lock at
     * COMMIT/ROLLBACK, never sooner, so everything read after this call
     * returns, for the remainder of the transaction, cannot be
     * concurrently changed by another transaction taking the same lock.
     */
    private function lockProject(int $tenantId, int $projectId): void
    {
        $stmt = $this->db->prepare(
            'SELECT id FROM tasker_projects WHERE id = :project_id AND tenant_id = :tenant_id FOR UPDATE'
        );
        $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->execute();
    }

    /**
     * Re-derives and re-stamps flow_step for every current member of
     * $flowId, from the edges among ITS OWN members only — mirroring
     * {@see \Tasker\Api\FlowsApiHandler::name()}'s own initial-stamp query
     * (both source and target IN-clauses scoped to the member set). Shared
     * by Tasks 7, 8 and 10's own edge/membership mutations — written once
     * here.
     *
     * MUST run inside a transaction the CALLER already opened AND ALREADY
     * HOLDS {@see self::lockProject()}'s lock on this flow's own project
     * (REVIEW FIX, round 2): the member SELECT below and the stamp UPDATEs
     * further down are separated by the edge SELECT and the sort, and under
     * READ COMMITTED a task committed INTO this flow in that window is
     * absent from $taskIds, never stamped, and nothing detects it — a
     * duplicated or missing step number with no error. The project lock
     * closes this by serialising any concurrent membership change against
     * the SAME project; without it, this method has no equivalent of
     * {@see \Tasker\Api\FlowsApiHandler::name()}'s own `flow_id IS NULL`
     * stamp guard for a member arriving mid-window (only for one LEAVING,
     * via the `rowCount() !== 1` check on the stamp UPDATE below).
     *
     * A thrown {@see FlowCycleException} can still be rolled back alongside
     * whatever else the caller's transaction wrote (the edge upsert/delete
     * in this class's own two public methods) — this method never begins or
     * commits a transaction of its own. NOT expected to be reachable from
     * either of this class's own two callers: setInput() already ran
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
     * Checks whether the CANDIDATE edge (source=$sourceTaskId,
     * target=$targetTaskId) — NOT YET WRITTEN anywhere — would close a
     * cycle, throwing {@see FlowCycleException} if it would. Entirely
     * read-only: this method never opens a transaction, writes a row, or
     * requires one already open, which is what lets
     * {@see self::setInput()} call it BEFORE ever starting its own write
     * phase (see that method's own docblock for why that matters —
     * matching {@see \Tasker\Api\FlowsApiHandler::name()}'s "nothing
     * written until every check has passed" bar exactly).
     *
     * DELIBERATELY NOT SCOPED TO A FLOW -- see this class's own docblock for
     * why: the brief's own cycle-rejection test constructs two tasks with no
     * flow at all, so "the flow's members" cannot be the node set here.
     *
     * THE GRAPH-THEORY SHORTCUT this relies on: in a DAG, adding edge (S, T)
     * closes a cycle if and only if T can already reach S — the standard
     * single-edge-insertion cycle test. Since every edge this method has
     * ever accepted was itself checked the same way, the EXISTING graph is
     * guaranteed acyclic, so it suffices to check whether $sourceTaskId is
     * reachable from $targetTaskId by following EXISTING edges FORWARD
     * (source -> target) starting at $targetTaskId --
     * {@see self::forwardReachable()} — and then asking whether appending
     * the candidate edge ON TOP of that (never persisted; just appended to
     * the in-memory list handed to {@see FlowStepSorter::sort()}) closes a
     * loop.
     *
     * Bounding the node set to {$targetTaskId} ∪ forwardReachable($targetTaskId)
     * ∪ {$sourceTaskId} — rather than every task in the project — also avoids
     * a false rejection: running {@see FlowStepSorter::sort()} over an
     * OVER-broad set (e.g. "every task in the project") would report failure
     * on ANY cycle anywhere in that set, including one entirely unrelated to
     * this edge (theoretically reachable only through direct, validation-
     * bypassing writes such as this test suite's own insertEdgeDirect()
     * helper) -- this bounded set can only ever contain a cycle that this
     * specific candidate edge is part of.
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
        // The CANDIDATE edge -- appended in memory only. It is never written
        // here; this is what lets the whole check run before any transaction
        // opens.
        $edges[] = ['source' => $sourceTaskId, 'target' => $targetTaskId];

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
