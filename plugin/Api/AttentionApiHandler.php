<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * GET /api/tasker/rank-tasks and GET /api/tasker/attention — the original's
 * rank_tasks and get_my_attention.
 *
 * Both are OU-scoped reads that call {@see OuScopeResolver::whereFragment()}
 * unconditionally, on a single static SQL template per query — exactly like
 * {@see TasksApiHandler::readyWork()} and {@see BoardApiHandler::get()} — so
 * every method here needs a real PostgreSQL connection and has no SQLite-tier
 * coverage. See TenantIsolationOuTest.php for the full suite.
 *
 * CORRECTED AGAINST THE LIVE ORIGINAL SURFACE (D1b Task 11, round 2): this
 * class's first draft trusted `app/src/docs/contentMcpV2.js` — the original
 * app's in-app documentation PAGE — as the source of truth for both tools'
 * real contracts. That page is STALE relative to the live MCP server: it
 * documents `rank_tasks` as a bulk reorder-by-task-list MUTATION
 * (`rank_tasks(tasks: [...])`) and omits `get_my_attention` entirely. The
 * live server (queried directly, authoritative over its own docs page) shows
 * both tools genuinely exist as reads, with contracts closer to (but not
 * identical to) this task's original brief/rulings — see this task's own
 * report for the full writeup and the corrected contracts below. The
 * docs-page-vs-live-surface disagreement is itself carried forward as a
 * standing finding, not just a footnote of this one task.
 *
 * rank_tasks: "Return pending tasks ranked by priority, due date, and skip
 * count... If no project_id is provided, the user's default project is used
 * when set; otherwise this requires confirmed: true to rank across ALL
 * projects." No `rank_by` parameter exists on the real tool — it was this
 * task's earlier ruling's own invention, now withdrawn in full. D1 dropped
 * skip_count (see CreateTaskerTasksTable's own docblock), so ranking here is
 * priority then due date then an id tiebreak — never skip-decay, stated in
 * the route's own summary text (the only field that actually surfaces as an
 * MCP tool's `description`; verified against
 * {@see \Whity\Mcp\Tools\ToolDeriver::deriveTool()}).
 *
 * get_my_attention: "the 'what needs me?' triage... tasks awaiting review
 * verdict, pending human GUIDANCE (unconsumed), agent sessions AWAITING
 * INPUT, STALE in-progress tasks (quiet 2+ days), and OVERDUE items." Of
 * these five, only stale and overdue are implementable on this backend today
 * — review, guidance, and agent-session concepts do not exist in this D1
 * schema at all. `pinned` (this task's earlier, withdrawn ruling #7) was
 * NEVER one of the original's five and has been removed entirely. The three
 * unimplementable buckets are named explicitly, as missing, in the route's
 * own summary text — the same honesty the skip_count disclosure above
 * already established, extended to this tool.
 */
final class AttentionApiHandler
{
    // D1b Task 11 ruling #4 (upheld through the round-2 correction above):
    // stale is a FIXED 2-day interval, never a caller parameter — accepting
    // a stale_days argument would mean either interpolating a caller-supplied
    // value into SQL text (forbidden) or building a parameterised INTERVAL
    // expression for no real benefit, so the literal is hardcoded here
    // instead.
    private const STALE_CUTOFF_SQL = "CURRENT_TIMESTAMP - INTERVAL '2 days'";

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/rank-tasks?project_id= — the original's rank_tasks:
     * non-done tasks ranked by priority, then due date (D1 dropped
     * skip_count — see this class's own docblock), then `id` as this task's
     * own determinism tiebreak (ruling #9). No `rank_by` parameter — the
     * live original tool has none; this task's earlier `rank_by` ruling was
     * withdrawn in full after the docs-page-vs-live-surface correction (see
     * this class's own docblock).
     *
     * $projectId is nullable here (a deviation from this task's ORIGINAL
     * interface, which took a required `int $projectId`): the live
     * original's own contract is "if no project_id is provided, the user's
     * default project is used when set; otherwise this requires
     * confirmed: true to rank across ALL projects" — a caller-identity- and
     * preference-dependent decision this handler has no access to (no
     * Request, no profile id), so the FOUR-case gating logic (supplied /
     * default / confirmed / neither) lives entirely in the route method,
     * {@see \Tasker\TaskerPlugin::rankTasks()} — see that method's own
     * docblock. By the time $projectId reaches here, it is either a single,
     * already-resolved project (ranked alone, OU-checked again below,
     * belt-and-braces like readyWork()) or null (ranked across every
     * project in $callerOuId's scope, the route's own confirmed:true case).
     */
    public function rank(int $tenantId, ?int $callerOuId, ?int $projectId): Response
    {
        if ($projectId !== null && !$this->isProjectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        try {
            $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
            $ouClause = OuScopeResolver::whereFragment('p.ou_id');
            $projectClause = $projectId !== null ? ' AND t.project_id = :project_id' : '';

            // t.tenant_id/p.tenant_id kept as LITERAL SQL text (not folded
            // into an interpolated variable) for the same reason
            // fetchBucket() below does — see that method's own docblock for
            // the tenant-predicate-scanner rationale. `t.id` (not a bare
            // `id`) in the ORDER BY is required here, unlike readyWork()'s
            // own single-table query: this JOINs tasker_projects, which also
            // has its own `id` column, so an unqualified `id` would be
            // ambiguous.
            $stmt = $this->db->prepare(
                "SELECT t.id, t.public_id, t.tenant_id, t.project_id, t.section_id, t.group_id, t.text, t.detail,
                        t.status, t.priority, t.due_date, t.pinned, t.pinned_at, t.sort_order, t.completed_at,
                        t.short_id, t.created_by, t.created_at, t.updated_at
                 FROM tasker_tasks t
                 JOIN tasker_projects p ON p.id = t.project_id
                 WHERE t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}
                   AND t.status != 'done'{$projectClause}
                 ORDER BY " . TasksApiHandler::priorityRankCase() . " ASC, t.due_date ASC NULLS LAST, t.id ASC"
            );
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
            $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
            if ($projectId !== null) {
                $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
            }
            $stmt->execute();

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to rank tasks', 500);
        }
    }

    /**
     * GET /api/tasker/attention?project_id= — the live original's actual
     * get_my_attention: "tasks awaiting review verdict, pending human
     * GUIDANCE (unconsumed), agent sessions AWAITING INPUT, STALE
     * in-progress tasks (quiet 2+ days), and OVERDUE items." Of those five,
     * only `stale` and `overdue` are implementable here — this D1 schema has
     * no review/guidance/agent-session concept at all. `pinned` (this task's
     * earlier, now-withdrawn ruling #7) was NEVER one of the original's five
     * and is not returned. Two named buckets: `overdue`, `stale`. A task
     * qualifying for both appears in EACH — buckets are deliberately not
     * deduplicated against each other. A completed (`status = 'done'`) task
     * appears in NO bucket regardless of how many it would otherwise qualify
     * for (ruling #8, upheld through the round-2 correction).
     *
     * PERSONAL, NOT TEAM-WIDE (ruling #5): tasker_tasks has no assignee/owner
     * column, only `created_by` (see CreateTaskerTasksTable) — the closest
     * available analogue to "mine", and the one used here, over the
     * alternative of leaving this OU-scoped-only. OU-scoped-only would make
     * `get_my_attention` return every task in scope regardless of who
     * created it — a tool named "MY attention" quietly returning everyone's
     * work is exactly the contract lie ruling #8's own text warns an agent
     * cannot detect from the tool surface alone. $callerId is therefore a
     * REQUIRED 4th parameter here.
     *
     * DEVIATION FROM THE BRIEF: the brief's own stated interface is
     * `attention(int $tenantId, ?int $callerOuId, ?int $projectId): Response`
     * — no caller-identity parameter at all. That shape cannot implement
     * ruling #5's created_by filter, which this task's rulings make binding
     * over the brief's own text per this slice's own stated precedence
     * ("where the brief and my rulings disagree, follow the rulings").
     * $callerId is resolved by the route method (TaskerPlugin::getMyAttention())
     * from the SAME caller identity {@see \Tasker\TaskerPlugin::resolveCallerOu()}
     * already resolves to reach this point at all — see that route method's
     * own docblock for why a second, independent null-check on it is kept
     * anyway rather than trusted as a program invariant.
     *
     * PROJECT SCOPING (ruling #6): $projectId is optional, but UNLIKE this
     * plugin's every other project-scoped read, an absent $projectId does
     * NOT mean "the caller's default project" — the route method never
     * calls defaultProjectIdFor() for this tool at all. It means "every
     * project in the caller's OU scope". A caller who DOES supply a
     * project_id is still scoped to exactly that one project, and 404s if
     * it is outside their tenant/OU scope — re-checked by THIS method itself
     * (see the isProjectVisible() call right below), not merely trusted from
     * the route's own pre-resolution, matching readyWork()'s belt-and-braces
     * precedent.
     */
    public function attention(int $tenantId, ?int $callerOuId, ?int $projectId, int $callerId): Response
    {
        // Belt-and-braces, matching readyWork()'s own established precedent
        // (see TasksApiHandler's class docblock): a supplied $projectId is a
        // discovered value reached directly, not one the caller already
        // holds through an OU-scoped list, so this re-derives and checks OU
        // visibility itself rather than trusting that the ROUTE layer
        // (TaskerPlugin::getMyAttention()) already resolved it. A null
        // $projectId (ruling #6's "span every project" case) has nothing to
        // check here.
        if ($projectId !== null && !$this->isProjectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        try {
            $overdue = $this->fetchBucket(
                $tenantId,
                $callerOuId,
                $projectId,
                $callerId,
                't.due_date < CURRENT_DATE',
                't.due_date ASC, t.id ASC'
            );
            $stale = $this->fetchBucket(
                $tenantId,
                $callerOuId,
                $projectId,
                $callerId,
                "t.status = 'in_progress' AND t.updated_at <= " . self::STALE_CUTOFF_SQL,
                't.updated_at ASC, t.id ASC'
            );

            return Response::json([
                'data' => [
                    'overdue' => array_map([$this, 'toPublicTask'], $overdue),
                    'stale'   => array_map([$this, 'toPublicTask'], $stale),
                ],
            ], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch attention items', 500);
        }
    }

    /**
     * One bucket's rows: tenant + OU (unconditional, one static SQL
     * template per {@see OuScopeResolver::whereFragment()}) + created_by +
     * "not done" + the bucket's own predicate, optionally narrowed to one
     * project. $bucketPredicate and $orderBy are ALWAYS one of the two fixed
     * literals {@see self::attention()} passes (overdue, stale) — never
     * caller input — so this is not a runtime-branched WHERE/ORDER BY text
     * in the sense the architecture forbids; it is two separate static
     * templates selected by which of the two fixed call sites invoked this
     * method, the same shape as {@see TasksApiHandler::listFiltered()}'s own
     * optional, presence-controlled (never value-controlled) predicate text.
     *
     * The `t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p` predicate
     * is kept as LITERAL SQL text below (not folded into a `$conditions`
     * array and imploded into one opaque interpolated variable, as an
     * earlier version of this method did) — TenantIsolationTest's own
     * tenant-predicate scanner statically greps each route's SQL string
     * literals for a `tenant_id` comparison and cannot see inside a runtime
     * `{$where}` variable at all; folding it in there tripped that scanner
     * even though the query is genuinely tenant-scoped at runtime. Matches
     * {@see TasksApiHandler::listFiltered()}'s own established `{$extra}`
     * pattern: the ALWAYS-present predicates stay literal, only the
     * genuinely optional project_id clause is a separate, presence-controlled
     * (never value-controlled) interpolated string.
     *
     * @return list<array<string, mixed>>
     */
    private function fetchBucket(
        int $tenantId,
        ?int $callerOuId,
        ?int $projectId,
        int $callerId,
        string $bucketPredicate,
        string $orderBy
    ): array {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');
        $projectClause = $projectId !== null ? ' AND t.project_id = :project_id' : '';

        $stmt = $this->db->prepare(
            "SELECT t.id, t.public_id, t.tenant_id, t.project_id, t.section_id, t.group_id, t.text, t.detail,
                    t.status, t.priority, t.due_date, t.pinned, t.pinned_at, t.sort_order, t.completed_at,
                    t.short_id, t.created_by, t.created_at, t.updated_at
             FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.tenant_id = :tenant_id AND p.tenant_id = :tenant_id_p AND {$ouClause}
               AND t.created_by = :created_by AND t.status != 'done' AND {$bucketPredicate}{$projectClause}
             ORDER BY {$orderBy}"
        );
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':created_by', $callerId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        if ($projectId !== null) {
            $stmt->bindValue(':project_id', $projectId, PDO::PARAM_INT);
        }
        $stmt->execute();

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * OU-scoped, tenant-scoped project visibility check — byte-for-byte the
     * same structure as {@see TasksApiHandler::isProjectVisible()} and
     * {@see BoardApiHandler}'s own findProject() predicate. Replicated here
     * rather than reused directly, matching this codebase's own established
     * precedent for small private per-handler helpers (see e.g.
     * TasksApiHandler::dbTruthy()'s own docblock, which documents the same
     * choice for a different helper).
     */
    private function isProjectVisible(int $tenantId, ?int $callerOuId, int $projectId): bool
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
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicTask(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'projectId' => (int) $row['project_id'],
            'sectionId' => (int) $row['section_id'],
            'groupId' => $row['group_id'] !== null ? (int) $row['group_id'] : null,
            'text' => (string) $row['text'],
            'detail' => $row['detail'],
            'status' => (string) $row['status'],
            'priority' => $row['priority'],
            'dueDate' => $row['due_date'],
            'pinned' => self::dbTruthy($row['pinned']),
            'sortOrder' => (int) $row['sort_order'],
            'completedAt' => $row['completed_at'],
            'shortId' => $row['short_id'] !== null ? (int) $row['short_id'] : null,
            'createdBy' => (int) $row['created_by'],
            'createdAt' => (string) $row['created_at'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }

    /**
     * Coerce a DB boolean column to a real bool across drivers — see
     * {@see TasksApiHandler::dbTruthy()}'s own docblock for the full
     * pdo_pgsql "f" string quirk this guards against. Replicated (not
     * reused) per that same method's own documented precedent.
     *
     * @param mixed $value Raw column value from a boolean field.
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
}
