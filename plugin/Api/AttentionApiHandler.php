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
 * NAME COLLISION (D1b Task 11 — flagged, not silently worked around): the
 * ORIGINAL app already documents a DIFFERENT tool also called `rank_tasks`:
 * `rank_tasks(tasks: ["TDE-3", "TDE-1", "TDE-5"])`, "Reorder tasks within a
 * group" (app/src/docs/contentMcpV2.js:485-492) — a bulk reorder-by-list-of-ids
 * MUTATION, not a read. This task's brief and this task's binding rulings both
 * independently specify the read-only, rank_by-driven tool implemented below,
 * so that is what ships — but the two are NOT contract-compatible under the
 * same name: an agent that learned the original's rank_tasks(tasks: [...])
 * contract will find this tool takes different arguments and does something
 * unrelated. Given this whole slice's stated purpose is contract parity with
 * the original app's MCP surface, shipping a same-named, differently-shaped
 * tool is itself a parity gap, not a fix for one. See this task's own report
 * for the full writeup; nothing here silently reinterprets or renames around
 * it, since both controlling instructions were explicit and in agreement.
 *
 * get_my_attention has NO PRE-EXISTING original counterpart found anywhere in
 * this repo's copy of the original app (app/src/docs/contentMcpV2.js documents
 * ~70 tools and none of them is get_my_attention, nor does any grep for
 * "attention" turn up a match) — also noted in the report rather than assumed.
 */
final class AttentionApiHandler
{
    /**
     * @var list<string>
     */
    private const VALID_RANK_BY = ['sorting_order', 'priority', 'due_date', 'pinned'];

    // Ruling #4 (D1b Task 11): stale is a FIXED 2-day interval, never a
    // caller parameter — accepting a stale_days argument would mean either
    // interpolating a caller-supplied value into SQL text (forbidden) or
    // building a parameterised INTERVAL expression for no real benefit, so
    // the literal is hardcoded here instead.
    private const STALE_CUTOFF_SQL = "CURRENT_TIMESTAMP - INTERVAL '2 days'";

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/rank-tasks?project_id=&rank_by= — exposes explicitly
     * the pinned/priority/due-date/sort-order ordering
     * {@see TasksApiHandler::readyWork()} already applies implicitly, over
     * the SAME task set (non-done tasks in the project).
     *
     * rank_by is a closed, whitelisted vocabulary (ruling #2): an
     * unrecognised value is a 400 naming the allowed set, never a silent
     * fallback to the default — a silent fallback would make an agent's
     * typo look like success. Each valid value maps, via match() over this
     * already-validated string, to one of four fully literal ORDER BY
     * clauses — never a clause built by concatenating or interpolating the
     * caller's own string, which is the load-bearing constraint for this
     * task.
     *
     * D1 deliberately dropped skip_count (see CreateTaskerTasksTable's own
     * docblock), so this cannot rank by skip-decay the way the original
     * app's rank_tasks reportedly does for its own (differently-shaped —
     * see this class's own docblock) tool of the same name; that limit is
     * stated in the route's own summary text, which is the only field that
     * actually surfaces as this tool's MCP description (verified against
     * {@see \Whity\Mcp\Tools\ToolDeriver::deriveTool()}: only schema.summary
     * becomes the tool's `description` — a route-level schema.description
     * key, if one were added instead, would be silently dropped).
     */
    public function rank(int $tenantId, ?int $callerOuId, int $projectId, string $rankBy): Response
    {
        if (!in_array($rankBy, self::VALID_RANK_BY, true)) {
            return Response::error(
                'rank_by must be one of: ' . implode(', ', self::VALID_RANK_BY),
                400
            );
        }

        if (!$this->isProjectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        // Ruling #9 (determinism): id ASC is appended as the final tiebreak
        // on every branch here — a query this handler owns outright, unlike
        // readyWork() itself, which is left completely untouched below.
        $orderBy = match ($rankBy) {
            // The EXACT expression readyWork() uses (see
            // TasksApiHandler::readyWorkOrderBy()'s own docblock for why
            // this is extracted rather than retyped), plus the id tiebreak.
            'sorting_order' => TasksApiHandler::readyWorkOrderBy() . ', id ASC',
            'priority'      => TasksApiHandler::priorityRankCase() . ' ASC, sort_order ASC, id ASC',
            'due_date'      => 'due_date ASC NULLS LAST, sort_order ASC, id ASC',
            'pinned'        => 'pinned DESC, sort_order ASC, id ASC',
        };

        try {
            $stmt = $this->db->prepare(
                "SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail,
                        status, priority, due_date, pinned, pinned_at, sort_order, completed_at,
                        short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id AND project_id = :project_id AND status != 'done'
                 ORDER BY {$orderBy}"
            );
            $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to rank tasks', 500);
        }
    }

    /**
     * GET /api/tasker/attention?project_id= — overdue items, stale
     * in-progress work, and pinned tasks, in three named buckets: `overdue`,
     * `stale`, `pinned` (ruling #7). A task qualifying for more than one
     * bucket appears in EACH — buckets are deliberately not deduplicated
     * against each other. A completed (`status = 'done'`) task appears in
     * NO bucket regardless of how many of the three it would otherwise
     * qualify for (ruling #8).
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
            $pinned = $this->fetchBucket(
                $tenantId,
                $callerOuId,
                $projectId,
                $callerId,
                't.pinned = TRUE',
                't.pinned_at ASC NULLS LAST, t.id ASC'
            );

            return Response::json([
                'data' => [
                    'overdue' => array_map([$this, 'toPublicTask'], $overdue),
                    'stale'   => array_map([$this, 'toPublicTask'], $stale),
                    'pinned'  => array_map([$this, 'toPublicTask'], $pinned),
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
     * project. $bucketPredicate and $orderBy are ALWAYS one of the three
     * fixed literals {@see self::attention()} passes — never caller input —
     * so this is not a runtime-branched WHERE/ORDER BY text in the sense the
     * architecture forbids; it is three separate static templates selected
     * by which of the three fixed call sites invoked this method, the same
     * shape as {@see TasksApiHandler::listFiltered()}'s own optional,
     * presence-controlled (never value-controlled) predicate text.
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
