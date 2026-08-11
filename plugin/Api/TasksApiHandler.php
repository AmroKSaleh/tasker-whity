<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Tasker\Domain\ShortIdAllocator;
use Whity\Core\Audit\AuditLogger;
use Whity\Core\Taxonomy\EntityTagRepository;
use Whity\Core\Taxonomy\TagRepository;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD, move, pin/unpin, complete/uncomplete, and entity-tag
 * attachment for tasker_tasks, plus the OU-scoped readyWork()/getOne()/
 * moveToGroup() queries.
 *
 * update()/move()/delete()/complete()/uncomplete()/pin()/unpin()/tag() are
 * tenant-scoped only — a caller only ever reaches an individual task's id
 * after already holding it from an OU-scoped list (listForSection()/
 * listFiltered() or get_board), so re-checking OU scope on every
 * single-task mutation would be redundant. readyWork() is one exception: it
 * is reached directly by project id, not through a task the caller already
 * holds, so it re-derives and checks OU visibility itself, exactly like
 * get_board. getOne() (D1b Task 8) and moveToGroup() (D1b Task 9) are two
 * more: both are the caller's FIRST hop straight to a task by identifier —
 * a get and, more seriously, a MUTATION — reachable by simply guessing a
 * sequential BIGSERIAL id, so both re-derive and check OU visibility via
 * {@see self::findVisible()} rather than trusting the task id the way
 * update()/move()/etc. do. See getOne()'s own docblock for the full
 * reasoning, which moveToGroup()'s docblock refers back to.
 *
 * create()'s section-existence check is ALSO OU-aware (whole-branch review
 * finding C1): {sectionId} is a discovered value with its own separate
 * existence, not one the caller already holds a task through, so that one
 * check (unlike the single-task-id mutations above) must confirm the
 * section's own project is within the caller's OU scope, not merely their
 * tenant — see create()'s own inline comment.
 *
 * TASK REVIEW NOTE (D1b Task 6): TaskerPlugin::createTask() ALSO resolves
 * section_id via IdentifierResolver::resolveSection() (itself OU-aware)
 * before ever calling create() — so today this check is belt-and-braces,
 * not the only barrier. It is kept anyway, deliberately, matching
 * SectionsApiHandler::create()/GroupsApiHandler::create()'s own precedent of
 * keeping their internal OU check even after their routes started
 * pre-resolving the parent identifier: a handler that is safe only because
 * every current caller happens to be careful is one future refactor (a new
 * route, a test double, a slimmed-down call site) away from not being safe.
 * listForSection()/listFiltered() were never part of C1's scope to begin
 * with (finding I7) and stay tenant-scoped only, as always.
 */
final class TasksApiHandler
{
    private const MAX_TEXT_LENGTH = 2000;

    /**
     * @var list<string>
     */
    private const VALID_PRIORITIES = ['rush', 'high', 'medium', 'low'];

    /**
     * D1b Task 11 round 3: the original's live update_task declares
     * `status: { enum: ["pending", "in_progress", "done"] }` — this plugin
     * had no way to reach 'in_progress' at all before this addition
     * (create() hardcodes 'pending'; complete()/uncomplete() only ever write
     * 'done'/'pending'), which is a real parity gap: it is also why
     * AttentionApiHandler's `stale` bucket (status = 'in_progress' AND
     * quiet 2+ days) could never populate through any real write path. The
     * tasker_tasks.status COLUMN itself carries no CHECK constraint by
     * design (see CreateTaskerTasksTable's own docblock — deferred custom
     * statuses must stay purely additive), so this three-value enum is
     * enforced at the API layer only, exactly like VALID_PRIORITIES above.
     *
     * @var list<string>
     */
    private const VALID_STATUSES = ['pending', 'in_progress', 'done'];

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/tasks — the original's list_tasks contract.
     *
     * project_id, section_id and group_id are all optional filters; status
     * defaults to excluding done. The tenant predicate is unconditional text
     * and is never part of the optional conditions.
     *
     * DEVIATION FROM THE BRIEF: the SELECT list keys off {@see self::idColumn()}
     * (`rowid` under the SQLite unit-test double, `id` on real PostgreSQL)
     * rather than a literal `id`, and orders by the same dynamic column —
     * exactly like every other read path in this class (findScoped(), the old
     * listForSection()). A literal `id` would silently return NULL for every
     * row under SQLite (see idColumn()'s own docblock for why: a row inserted
     * without specifying `id` gets a permanent NULL there, and
     * PDO::lastInsertId() only ever reports SQLite's own rowid) — divergent,
     * untested behaviour from production Postgres that no test in this file
     * happens to catch today, but is exactly the kind of gap this task's
     * other carry-over fixes exist to close.
     *
     * TASK REVIEW FIX: $status = null (the default, meaning "not supplied")
     * used to be treated identically to the literal string 'pending' — a
     * literal `status = 'pending'` predicate that silently excluded
     * `in_progress` tasks too. The original's own documented contract
     * (quoted above) is "excluding DONE tasks", not "pending only" —
     * in_progress is a live status the directive playbook tells agents to
     * set — and readyWork() right below already implements the correct
     * `status != 'done'` semantic, making the inconsistency visible within
     * this same file. Now: null (not supplied) means `status != 'done'`;
     * an explicit 'pending'/'in_progress'/'done' is a plain equality
     * predicate (unchanged); 'all' removes the status predicate entirely
     * (unchanged).
     *
     * @param 'pending'|'in_progress'|'done'|'all'|null $status
     */
    public function listFiltered(
        int $tenantId,
        ?int $projectId,
        ?int $sectionId,
        ?int $groupId,
        ?string $status = null
    ): Response {
        $conditions = [];
        $params     = [':tenant_id' => $tenantId];

        if ($projectId !== null) {
            $conditions[] = 'project_id = :project_id';
            $params[':project_id'] = $projectId;
        }
        if ($sectionId !== null) {
            $conditions[] = 'section_id = :section_id';
            $params[':section_id'] = $sectionId;
        }
        if ($groupId !== null) {
            $conditions[] = 'group_id = :group_id';
            $params[':group_id'] = $groupId;
        }
        if ($status === null) {
            $conditions[] = "status != 'done'";
        } elseif ($status !== 'all') {
            $conditions[] = 'status = :status';
            $params[':status'] = $status;
        }

        $extra = $conditions === [] ? '' : ' AND ' . implode(' AND ', $conditions);

        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "SELECT {$idCol} AS id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                        due_date, pinned, pinned_at, sort_order, completed_at, short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id{$extra}
                 ORDER BY sort_order ASC, {$idCol} ASC"
            );
            $stmt->execute($params);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch tasks', 500);
        }
    }

    /**
     * REGRESSION FIX (whole-branch review finding I7): this used to have NO
     * existence check on its parent {sectionId} at all — a nonexistent or
     * cross-tenant section returned `200 []` instead of 404, unlike
     * SectionsApiHandler::list()/GroupsApiHandler::list(). Tenant-scoped
     * only, matching the established parent-existence-check pattern
     * (list_tasks by section id is explicitly NOT part of finding C1's
     * OU-scoping fix — only its sibling create_task route is).
     *
     * Kept as a thin wrapper around {@see self::listFiltered()} — introduced
     * by D1b Task 6, which generalised list_tasks into project/section/
     * group/status filters rather than a section-only listing — so nothing
     * that already calls listForSection() breaks.
     */
    public function listForSection(int $tenantId, int $sectionId): Response
    {
        if (!$this->sectionExistsInTenant($tenantId, $sectionId)) {
            return Response::error('Section not found', 404);
        }

        return $this->listFiltered($tenantId, null, $sectionId, null, 'all');
    }

    public function create(int $tenantId, ?int $callerOuId, int $sectionId, int $createdBy, string $body): Response
    {
        $decoded = json_decode($body, true);
        $text = is_array($decoded) ? trim((string) ($decoded['text'] ?? '')) : '';
        if ($text === '' || mb_strlen($text) > self::MAX_TEXT_LENGTH) {
            return Response::error('text must be a non-empty string of at most ' . self::MAX_TEXT_LENGTH . ' characters', 400);
        }

        $priority = null;
        // Parenthesized deliberately: `&&` binds tighter than `??` in PHP, so
        // the unparenthesized `is_array($decoded) && $decoded['priority'] ?? null`
        // actually parses as `(is_array($decoded) && $decoded['priority']) ?? null`
        // — the boolean `&&` result is never null, so the `?? null` is dead
        // code, AND `$decoded['priority']` is accessed unguarded, raising a
        // PHP "Undefined array key" warning whenever the request omits
        // priority entirely (confirmed empirically: every test that creates a
        // task without a priority field triggered this warning under
        // PHPUnit's `--display-warnings`). This parenthesization is the fix.
        if (is_array($decoded) && ($decoded['priority'] ?? null)) {
            $priority = (string) $decoded['priority'];
            if (!in_array($priority, self::VALID_PRIORITIES, true)) {
                return Response::error('priority must be one of: ' . implode(', ', self::VALID_PRIORITIES), 400);
            }
        }

        // detail/due_date are optional, free-form pass-through fields —
        // mirrors update()'s own treatment of the same two columns (no format
        // validation on due_date beyond a plain string cast).
        $detail = is_array($decoded) && array_key_exists('detail', $decoded) && $decoded['detail'] !== null
            ? (string) $decoded['detail']
            : null;
        $dueDate = is_array($decoded) && array_key_exists('due_date', $decoded) && $decoded['due_date'] !== null
            ? (string) $decoded['due_date']
            : null;

        // REGRESSION FIX (whole-branch review finding C1): this existence
        // check is OU-aware, not merely tenant-scoped — see this class's own
        // docblock for why it stays that way even though
        // TaskerPlugin::createTask() also resolves section_id (OU-aware)
        // before ever calling create(). tasker_sections carries no ou_id
        // column, so this joins up to tasker_projects (the only table that
        // does) and applies OuScopeResolver there. Confines create() to a
        // real PostgreSQL connection — see TenantIsolationOuTest.
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');
        $section = $this->db->prepare(
            "SELECT s.id, s.project_id FROM tasker_sections s
             JOIN tasker_projects p ON p.id = s.project_id
             WHERE s.id = :id AND s.tenant_id = :tenant_id AND {$ouClause}"
        );
        $section->bindValue(':id', $sectionId, PDO::PARAM_INT);
        $section->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $section->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $section->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $section->execute();
        $sectionRow = $section->fetch(PDO::FETCH_ASSOC);
        if (!is_array($sectionRow)) {
            return Response::error('Section not found', 404);
        }

        try {
            $publicId = self::generateUuidV4();
            // ShortIdAllocator::withRetry() computes MAX(short_id)+1 for this
            // project and lets UNIQUE (project_id, short_id) — see
            // AddTaskerTaskShortIdUnique — reject a concurrent race, retrying
            // with a freshly recomputed candidate rather than holding a lock
            // (see ShortIdAllocator's own docblock for why: this must also
            // work under SQLite, which supports neither
            // pg_advisory_xact_lock nor SELECT ... FOR UPDATE).
            ShortIdAllocator::withRetry(
                $this->db,
                $tenantId,
                (int) $sectionRow['project_id'],
                function (int $candidate) use ($publicId, $tenantId, $sectionRow, $sectionId, $text, $detail, $priority, $dueDate, $createdBy): void {
                    $insert = $this->db->prepare(
                        'INSERT INTO tasker_tasks
                            (public_id, tenant_id, project_id, section_id, text, detail, priority, due_date, status,
                             short_id, created_by, created_at, updated_at)
                         VALUES
                            (:public_id, :tenant_id, :project_id, :section_id, :text, :detail, :priority, :due_date, :status,
                             :short_id, :created_by, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
                    );
                    $insert->execute([
                        ':public_id'  => $publicId,
                        ':tenant_id'  => $tenantId,
                        ':project_id' => $sectionRow['project_id'],
                        ':section_id' => $sectionId,
                        ':text'       => $text,
                        ':detail'     => $detail,
                        ':priority'   => $priority,
                        ':due_date'   => $dueDate,
                        ':status'     => 'pending',
                        ':short_id'   => $candidate,
                        ':created_by' => $createdBy,
                    ]);
                }
            );

            // lastInsertId() is the row's true identity on BOTH engines
            // (SQLite's rowid; PostgreSQL's BIGSERIAL sequence via
            // lastval()), but findScoped() must look it up through the SAME
            // column this value actually came from — see idColumn()'s doc.
            $id = (int) $this->db->lastInsertId();

            $row = $this->findScoped($id, $tenantId);
            if ($row === null) {
                return Response::error('Failed to create task', 500);
            }

            (new AuditLogger($this->db))->record('tasker_task.created', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $id,
            ]);

            return Response::json(['data' => $this->toPublicTask($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create task', 500);
        }
    }

    /**
     * PATCH /api/tasker/tasks/{id} — content-only edit. section_id/group_id/
     * sort_order are NOT editable here; that's move()'s job (structural
     * placement vs. content are kept as two separate, smaller operations,
     * matching the design spec's own naming: update_task vs. move_task).
     *
     * status (D1b Task 11 round 3, completed_at fix in round 4) accepts the
     * original's own three-value enum (pending/in_progress/done), validated
     * exactly like priority above. completed_at is kept consistent with
     * whichever status this call REQUESTS, matching complete()/uncomplete()'s
     * own unconditional semantics exactly (see this method's own status
     * branch below) rather than a third, independently-invented convention:
     * both of those methods stamp/clear completed_at regardless of the
     * task's PRIOR status (complete() re-stamps even an already-done task;
     * uncomplete() clears even an already-pending one), and both therefore
     * maintain the same invariant — completed_at is non-null exactly when
     * status is 'done'. This addition preserves that same invariant across
     * the third status value (in_progress) this route introduces. Before
     * round 4, this docblock instead documented completed_at as a
     * deliberately-unaddressed gap; round 4 fixed it rather than ledgering
     * it, since it was a defect this same task introduced, not a
     * pre-existing one.
     */
    public function update(int $tenantId, int $taskId, string $body): Response
    {
        $row = $this->findScoped($taskId, $tenantId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $taskId, ':tenant_id' => $tenantId];

        if (array_key_exists('text', $decoded)) {
            $text = trim((string) $decoded['text']);
            if ($text === '' || mb_strlen($text) > self::MAX_TEXT_LENGTH) {
                return Response::error('text must be a non-empty string of at most ' . self::MAX_TEXT_LENGTH . ' characters', 400);
            }
            $fields[] = 'text = :text';
            $params[':text'] = $text;
        }
        if (array_key_exists('detail', $decoded)) {
            $fields[] = 'detail = :detail';
            $params[':detail'] = $decoded['detail'] !== null ? (string) $decoded['detail'] : null;
        }
        if (array_key_exists('priority', $decoded)) {
            $priority = $decoded['priority'] !== null ? (string) $decoded['priority'] : null;
            if ($priority !== null && !in_array($priority, self::VALID_PRIORITIES, true)) {
                return Response::error('priority must be one of: ' . implode(', ', self::VALID_PRIORITIES), 400);
            }
            $fields[] = 'priority = :priority';
            $params[':priority'] = $priority;
        }
        if (array_key_exists('due_date', $decoded)) {
            $fields[] = 'due_date = :due_date';
            $params[':due_date'] = $decoded['due_date'] !== null ? (string) $decoded['due_date'] : null;
        }
        if (array_key_exists('status', $decoded)) {
            $status = is_string($decoded['status']) ? $decoded['status'] : '';
            if (!in_array($status, self::VALID_STATUSES, true)) {
                return Response::error('status must be one of: ' . implode(', ', self::VALID_STATUSES), 400);
            }
            $fields[] = 'status = :status';
            $params[':status'] = $status;
            // Mirrors complete()/uncomplete()'s own unconditional
            // completed_at handling exactly (D1b Task 11 round 4): the
            // REQUESTED status becoming 'done' always (re-)stamps
            // completed_at to now, regardless of the task's prior status —
            // exactly like complete() itself, which never checks whether
            // the task was already done before stamping. Any other
            // requested status always clears it, regardless of prior
            // status — exactly like uncomplete()'s own unconditional NULL.
            // $status is already validated above, never caller-supplied SQL
            // text, so this fixed two-armed literal is safe the same way
            // setPinned()'s own $pinnedAtClause is. completed_at is left
            // completely untouched when this whole block never runs (the
            // array_key_exists() guard above) — that is what keeps a plain
            // {"text": "..."} update on an already-done task from silently
            // clearing its completion timestamp.
            $fields[] = $status === 'done' ? 'completed_at = CURRENT_TIMESTAMP' : 'completed_at = NULL';
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicTask($row)], 200);
        }
        $fields[] = 'updated_at = CURRENT_TIMESTAMP';

        try {
            $sql = 'UPDATE tasker_tasks SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($taskId, $tenantId);
            if ($updated === null) {
                return Response::error('Task not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_task.updated', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(['data' => $this->toPublicTask($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update task', 500);
        }
    }

    /**
     * POST /api/tasker/tasks/{id}/move — structural placement only:
     * section_id, group_id, sort_order. A task can move between sections and
     * groups within the SAME project only; there is no cross-project move in
     * this plan (moving a task's project_id would need to reconcile it
     * against a different OU/project scope entirely, out of D1's scope).
     *
     * REGRESSION FIX (whole-branch review finding I1): section_id and
     * group_id used to be validated INDEPENDENTLY of each other — group_id
     * only had to belong to the task's own PROJECT, never to its (possibly
     * newly-changed) section_id. Moving a task to a different section while
     * a group_id from the OLD section was left in place made
     * BoardApiHandler::get() render it under the OLD section (it places a
     * task by its group's section, not the task's own section_id) while
     * listForSection() for the NEW section returned it — the two read paths
     * disagreed. Now: when section_id changes and group_id is NOT supplied
     * in the SAME request, group_id is cleared to null (the task becomes
     * ungrouped in its new section — the old group has no relationship to
     * the new one). When group_id IS supplied, it is validated against the
     * TARGET section (the new section_id if this same request is also
     * changing it, otherwise the task's current section_id) — 422 if it
     * doesn't belong there.
     *
     * CARRY-OVER BUG FIX (D1b Task 6): $sectionChanging used to be set from
     * `array_key_exists('section_id', $decoded)` alone — SUPPLIED, not
     * CHANGED, contradicting this very docblock's "when section_id changes"
     * wording above. A plain reorder that echoes the task's CURRENT
     * section_id (`{"task_id": ..., "section_id": <same>, "sort_order": 5}`)
     * — exactly what a drag-and-drop client sends — was silently treated as a
     * section change, which cleared group_id via the `elseif` branch below
     * and un-grouped an already-grouped task. Comparing against the row's
     * actual current value closes that.
     */
    public function move(int $tenantId, int $taskId, string $body): Response
    {
        $row = $this->findScoped($taskId, $tenantId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $projectId = (int) $row['project_id'];
        $fields = [];
        $params = [':id' => $taskId, ':tenant_id' => $tenantId];

        $sectionChanging = array_key_exists('section_id', $decoded)
            && (int) $decoded['section_id'] !== (int) $row['section_id'];
        $groupProvided = array_key_exists('group_id', $decoded);
        // The section a supplied group_id must belong to: the NEW section_id
        // if this same request is also changing it, otherwise the task's
        // current (unchanged) section_id.
        $targetSectionId = (int) $row['section_id'];

        if ($sectionChanging) {
            $sectionId = (int) $decoded['section_id'];
            if (!$this->sectionBelongsToProject($tenantId, $sectionId, $projectId)) {
                return Response::error('section_id must belong to the task\'s own project', 422);
            }
            $fields[] = 'section_id = :section_id';
            $params[':section_id'] = $sectionId;
            $targetSectionId = $sectionId;
        }

        if ($groupProvided) {
            $groupId = $decoded['group_id'] !== null ? (int) $decoded['group_id'] : null;
            // Validated against the TARGET section directly (tasker_groups
            // already stores section_id) — not merely the task's project —
            // so a group_id from a different section can never be attached,
            // even if that section belongs to the same project.
            if ($groupId !== null && !$this->groupBelongsToSection($tenantId, $groupId, $targetSectionId)) {
                return Response::error('group_id must belong to the target section', 422);
            }
            $fields[] = 'group_id = :group_id';
            $params[':group_id'] = $groupId;
        } elseif ($sectionChanging) {
            // section_id changed but group_id was not supplied in the same
            // request: the task's old group has no relationship to the new
            // section, so it becomes ungrouped rather than silently keeping a
            // stale, cross-section group_id.
            $fields[] = 'group_id = :group_id';
            $params[':group_id'] = null;
        }

        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicTask($row)], 200);
        }
        $fields[] = 'updated_at = CURRENT_TIMESTAMP';

        try {
            $sql = 'UPDATE tasker_tasks SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($taskId, $tenantId);
            if ($updated === null) {
                return Response::error('Task not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_task.moved', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(['data' => $this->toPublicTask($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to move task', 500);
        }
    }

    /**
     * Whether $sectionId exists, belongs to $tenantId, AND to $projectId —
     * the project-membership check {@see self::move()}'s own $sectionChanging
     * branch has always run. Extracted (D1b Task 9) so
     * {@see self::moveToGroup()} reuses the identical, already-reviewed SQL
     * rather than a second, subtly different copy of it.
     */
    private function sectionBelongsToProject(int $tenantId, int $sectionId, int $projectId): bool
    {
        $section = $this->db->prepare(
            'SELECT id FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id AND project_id = :project_id'
        );
        $section->execute([':id' => $sectionId, ':tenant_id' => $tenantId, ':project_id' => $projectId]);

        return $section->fetch() !== false;
    }

    /**
     * Whether $groupId exists, belongs to $tenantId, AND to $sectionId
     * (tasker_groups already stores section_id directly, so this is never
     * merely a project-membership check) — the cross-section-grouping check
     * {@see self::move()}'s own $groupProvided branch has always run.
     * Extracted (D1b Task 9 brief resolution #4) so
     * {@see self::moveToGroup()} reuses move()'s own already-reviewed logic
     * rather than a second convention for the identical rule.
     */
    private function groupBelongsToSection(int $tenantId, int $groupId, int $sectionId): bool
    {
        $group = $this->db->prepare(
            'SELECT id FROM tasker_groups WHERE id = :id AND tenant_id = :tenant_id AND section_id = :section_id'
        );
        $group->execute([':id' => $groupId, ':tenant_id' => $tenantId, ':section_id' => $sectionId]);

        return $group->fetch() !== false;
    }

    /**
     * POST /api/tasker/tasks/group — the original's move_task_to_group:
     * dedicated to group membership only, deliberately narrower than
     * move()'s combined section/group/sort_order scope. section_id is
     * accepted alongside group_id only to let a caller re-target the
     * group's OWN section in the same call (see the cross-section
     * validation below) — when supplied, it is written to the task exactly
     * like move()'s own $sectionChanging branch, keeping the task's
     * section_id and its group's actual section in agreement (the same
     * invariant move()'s own docblock — whole-branch review finding I1 —
     * exists to protect).
     *
     * OU-AWARE — DEVIATION FROM THE BRIEF (D1b Task 9 brief resolution #2):
     * the brief's own stated interface is
     * `moveToGroup(int $tenantId, int $taskId, ?int $groupId, ?int $sectionId): Response`,
     * tenant-scoped only, matching move()'s own single-task-id mutations
     * (see this class's own docblock for why those stay tenant-scoped:
     * a caller only ever reaches an individual task id after already
     * holding it from an OU-scoped list/get_board). This method is a
     * mutation reachable by guessing a sequential BIGSERIAL task id — a
     * strictly STRONGER case than {@see self::getOne()}'s own OU-aware read
     * (D1b Task 8), which was made OU-aware for the identical reason. Its
     * coverage therefore lives entirely in TenantIsolationOuTest.php
     * (Postgres), never in TasksApiHandlerTest.php (SQLite) — see that
     * file's own docblock for the full reasoning every other OU-aware
     * method in this class already documents.
     *
     * group_id ABSENT and group_id EXPLICIT NULL are IDENTICAL at this
     * layer: both arrive here as a plain `null` (D1b Task 9 brief
     * resolution #3 — the route layer, TaskerPlugin::moveTaskToGroup(),
     * collapses the two statuses via its own resolveGroupMembership()
     * before ever calling this method). move_task_to_group exists SOLELY to
     * set group membership, so there is no "leave unchanged" form the way
     * move()'s own array_key_exists()-based group_id handling has — and
     * that is a deliberate divergence, not an oversight: it is exactly what
     * keeps this method from reproducing move()'s own known carry-over
     * defect (see move()'s docblock) of conflating "supplied" with
     * "changed".
     */
    public function moveToGroup(int $tenantId, ?int $callerOuId, int $taskId, ?int $groupId, ?int $sectionId): Response
    {
        $row = $this->findVisible($tenantId, $callerOuId, $taskId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        $projectId = (int) $row['project_id'];

        if ($sectionId !== null && !$this->sectionBelongsToProject($tenantId, $sectionId, $projectId)) {
            return Response::error('section_id must belong to the task\'s own project', 422);
        }

        // The section a supplied group_id must belong to: the NEW section_id
        // when this same request is also changing it, otherwise the task's
        // current (unchanged) section_id — identical rule to move()'s own
        // $targetSectionId.
        $targetSectionId = $sectionId ?? (int) $row['section_id'];

        if ($groupId !== null && !$this->groupBelongsToSection($tenantId, $groupId, $targetSectionId)) {
            return Response::error('group_id must belong to the target section', 422);
        }

        $fields = ['group_id = :group_id'];
        $params = [':id' => $taskId, ':tenant_id' => $tenantId, ':group_id' => $groupId];
        if ($sectionId !== null) {
            $fields[] = 'section_id = :section_id';
            $params[':section_id'] = $sectionId;
        }
        $fields[] = 'updated_at = CURRENT_TIMESTAMP';

        try {
            $sql = 'UPDATE tasker_tasks SET ' . implode(', ', $fields) . " WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($taskId, $tenantId);
            if ($updated === null) {
                return Response::error('Task not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_task.moved_to_group', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(['data' => $this->toPublicTask($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to move task to group', 500);
        }
    }

    /**
     * DELETE /api/tasker/tasks/{id} — cascades to the task's own milestones
     * and discussion (Tasks 6-7's FKs).
     *
     * CARRY-OVER FIX (D1b Task 6): entity_tags rows referencing this task
     * used to be left behind as orphans (entity_tags carries no FK to
     * tasker_tasks). Now cleaned up via core's own
     * {@see EntityTagRepository::detachAll()} — the canonical writer for
     * entity_tags, same as tag()'s own attach() call above — BEFORE the
     * DELETE, since the row still needs to exist for the earlier
     * findScoped() 404 check but detachAll() itself does not depend on it.
     */
    public function delete(int $tenantId, int $taskId): Response
    {
        $row = $this->findScoped($taskId, $tenantId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        try {
            // Core's opt-in cleanup. Without it a deleted task leaves
            // entity_tags rows pointing at an id that no longer exists —
            // harmless today, but it accumulates and would confuse any later
            // tag-usage reporting.
            (new EntityTagRepository($this->db))->detachAll($tenantId, 'tasker_task', $taskId);

            $stmt = $this->db->prepare("DELETE FROM tasker_tasks WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id");
            $stmt->execute([':id' => $taskId, ':tenant_id' => $tenantId]);

            (new AuditLogger($this->db))->record('tasker_task.deleted', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete task', 500);
        }
    }

    /**
     * POST /api/tasker/tasks/{id}/complete
     */
    public function complete(int $tenantId, int $taskId): Response
    {
        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET status = 'done', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE {$idCol} = :id AND tenant_id = :tenant_id"
            );
            $stmt->execute([':id' => $taskId, ':tenant_id' => $tenantId]);

            if ($stmt->rowCount() === 0) {
                return Response::error('Task not found', 404);
            }

            $row = $this->findScoped($taskId, $tenantId);
            if ($row === null) {
                return Response::error('Task not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_task.completed', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(['data' => $this->toPublicTask($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to complete task', 500);
        }
    }

    /**
     * POST /api/tasker/tasks/{id}/uncomplete — the opposite of complete().
     * Restores status to 'pending' (there is no "previous status" tracked to
     * restore instead — plain pending/in_progress/done only, per §5).
     */
    public function uncomplete(int $tenantId, int $taskId): Response
    {
        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET status = 'pending', completed_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE {$idCol} = :id AND tenant_id = :tenant_id"
            );
            $stmt->execute([':id' => $taskId, ':tenant_id' => $tenantId]);

            if ($stmt->rowCount() === 0) {
                return Response::error('Task not found', 404);
            }

            $row = $this->findScoped($taskId, $tenantId);
            if ($row === null) {
                return Response::error('Task not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_task.uncompleted', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_task',
                'target_id' => $taskId,
            ]);

            return Response::json(['data' => $this->toPublicTask($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to uncomplete task', 500);
        }
    }

    public function pin(int $tenantId, int $taskId): Response
    {
        return $this->setPinned($tenantId, $taskId, true);
    }

    public function unpin(int $tenantId, int $taskId): Response
    {
        return $this->setPinned($tenantId, $taskId, false);
    }

    private function setPinned(int $tenantId, int $taskId, bool $pinned): Response
    {
        // $pinnedAtClause is a fixed internal literal, never user input — kept
        // consistent with this plugin's CURRENT_TIMESTAMP convention rather
        // than computing a PHP-side timestamp that could drift from the DB's.
        $pinnedAtClause = $pinned ? 'CURRENT_TIMESTAMP' : 'NULL';

        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET pinned = :pinned, pinned_at = {$pinnedAtClause}, updated_at = CURRENT_TIMESTAMP
                 WHERE {$idCol} = :id AND tenant_id = :tenant_id"
            );
            // bindValue(..., PDO::PARAM_BOOL) deliberately, NOT execute([...]):
            // PDOStatement::execute(array) binds every value as PDO::PARAM_STR
            // regardless of PHP type (the same quirk OuScopeResolver::descendantIds()
            // already documents), and PHP's (string) false is '' — which
            // PostgreSQL's boolean parser rejects outright
            // (SQLSTATE[22P02]: invalid input syntax for type boolean: '').
            // Confirmed empirically against real Postgres: unpin() (pinned =
            // false) threw exactly that error and surfaced as a bare 500
            // before this fix, while pin() (pinned = true) happened to work
            // only by accident, since (string) true is the numeric string
            // "1", which Postgres's boolean parser does accept.
            $stmt->bindValue(':pinned', $pinned, PDO::PARAM_BOOL);
            $stmt->bindValue(':id', $taskId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();

            if ($stmt->rowCount() === 0) {
                return Response::error('Task not found', 404);
            }

            $row = $this->findScoped($taskId, $tenantId);
            if ($row === null) {
                return Response::error('Task not found', 404);
            }

            return Response::json(['data' => $this->toPublicTask($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update task', 500);
        }
    }

    /**
     * POST /api/tasker/tasks/{id}/tags — attach an existing tag to a task.
     *
     * Mirrors {@see \Tasker\Api\PingApiHandler::tag()} exactly: the tag must
     * belong to the caller's tenant (checked via core's own
     * {@see TagRepository::find()}, which already binds tenant_id — a
     * foreign/absent tag_id is a 422 validation failure, never a cross-tenant
     * existence leak) BEFORE the association is written, and the actual
     * write is delegated to core's own {@see EntityTagRepository::attach()}
     * — the canonical, single writer for entity_tags — rather than a
     * hand-rolled INSERT here. A task outside the caller's tenant reports
     * 404, never a cross-tenant existence leak.
     */
    public function tag(int $tenantId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $tagId = is_array($decoded) && isset($decoded['tag_id']) ? (int) $decoded['tag_id'] : 0;
        if ($tagId <= 0) {
            return Response::error('tag_id is required and must be a positive integer', 400);
        }

        $idCol = $this->idColumn();
        $find = $this->db->prepare("SELECT {$idCol} FROM tasker_tasks WHERE {$idCol} = :id AND tenant_id = :tenant_id");
        $find->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        if ($find->fetch() === false) {
            return Response::error('Task not found', 404);
        }

        // The tag must belong to the caller's tenant. TagRepository::find()
        // already binds tenant_id, so a foreign-tenant tag_id is
        // indistinguishable from a non-existent one — a validation failure
        // (422), never a cross-tenant leak.
        if ((new TagRepository($this->db))->find($tenantId, $tagId) === null) {
            return Response::error('tag not found', 422, ['tag_id' => $tagId]);
        }

        try {
            // Delegates the actual INSERT to core's own EntityTagRepository —
            // the canonical, single writer for entity_tags — rather than
            // re-issuing the raw SQL here.
            $created = (new EntityTagRepository($this->db))
                ->attach($tenantId, 'tasker_task', $taskId, $tagId);

            return Response::json([
                'data' => ['entity_type' => 'tasker_task', 'entity_id' => $taskId, 'tag_id' => $tagId],
            ], $created ? 201 : 200);
        } catch (\Throwable) {
            return Response::error('Failed to attach tag', 500);
        }
    }

    /**
     * GET /api/tasker/projects/{id}/ready-work — non-done tasks across the
     * whole project, ordered for "what should I work on next": pinned first,
     * then by priority (rush > high > medium > low > none), then by nearest
     * due_date (nulls last), then by each section's own sort_order.
     * OU-scoped like get_board: visibility is checked once, up front, against
     * the project — a caller outside scope gets 404, never a silently empty
     * list (an empty list would leak "this project id exists" information).
     */
    public function readyWork(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        if (!$this->isProjectVisible($tenantId, $callerOuId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        try {
            $idCol = $this->idColumn();
            $stmt = $this->db->prepare(
                "SELECT {$idCol} AS id, public_id, tenant_id, project_id, section_id, group_id, text, detail,
                        status, priority, due_date, pinned, pinned_at, sort_order, completed_at,
                        short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id AND project_id = :project_id AND status != 'done'
                 ORDER BY pinned DESC, " . self::priorityRankCase() . " ASC, due_date ASC NULLS LAST, sort_order ASC"
            );
            $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch ready work', 500);
        }
    }

    /**
     * The CASE expression ranking priority rush > high > medium > low > none
     * — shared (D1b Task 11) by this method's own ORDER BY above AND
     * {@see \Tasker\Api\AttentionApiHandler::rank()}'s own priority-led
     * ordering, so the two never drift into independently-typed copies of
     * the same expression. (An earlier round of D1b Task 11 also factored
     * the FULL pinned/priority/due-date/sort-order clause out into a
     * `readyWorkOrderBy()` sibling method for a 'sorting_order' rank_tasks
     * option — that option turned out not to exist on the live original
     * tool and was withdrawn; `readyWorkOrderBy()` was re-inlined here once
     * it had gone back to having exactly one caller.)
     */
    public static function priorityRankCase(): string
    {
        return "CASE priority WHEN 'rush' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END";
    }

    /**
     * GET /api/tasker/task?task_id= — the original's get_task: a single task
     * plus its milestones, ordered by sort_order then id for a deterministic
     * response.
     *
     * OU-AWARE — DEVIATION FROM THE BRIEF (D1b Task 8 brief resolution #2):
     * the brief's own stated interface is `getOne(int $tenantId, int $taskId):
     * Response`, tenant-scoped only, matching every other single-task method
     * in this class (update/move/delete/complete/uncomplete/pin/unpin/tag).
     * Those all stay tenant-scoped only because a caller only ever reaches
     * one of THEIR task ids through an OU-scoped list/get_board first — by
     * the time a caller holds a task id, OU visibility has already been
     * proven once. get_task is different: it is the caller's FIRST hop
     * straight to a task by identifier, and `tasker_tasks.id` is a sequential
     * BIGSERIAL, so a tenant-scoped-only lookup would let an OU-restricted
     * caller reach a sibling OU's task simply by counting upward through ids
     * — exactly the reasoning that made create()'s own section check (see
     * this class's own docblock) and
     * {@see \Tasker\Api\MilestonesApiHandler::taskVisible()} real in the
     * previous slice's review. {@see \Tasker\Api\ProjectsApiHandler::getOne()}
     * (this task's sibling method) takes the identical `?int $callerOuId`
     * shape for the same reason.
     *
     * Confines this method to a real PostgreSQL connection (see
     * TenantIsolationOuTest), same as every other OU-aware method in this
     * codebase: {@see self::findVisible()} joins to tasker_projects (the only
     * table with an ou_id column) and applies
     * {@see OuScopeResolver::whereFragment()} there, unconditionally, one
     * static SQL template — which embeds PostgreSQL's `= ANY(:scope)` in the
     * SQL TEXT regardless of whether the caller's OU is null, so SQLite's
     * PDO::prepare() rejects it before any parameter is ever bound. There is
     * consequently NO SQLite-tier coverage for this method at all — see
     * TasksApiHandlerTest's own docblock for the full reasoning.
     */
    public function getOne(int $tenantId, ?int $callerOuId, int $taskId): Response
    {
        $row = $this->findVisible($tenantId, $callerOuId, $taskId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        $task = $this->toPublicTask($row);
        $task['milestones'] = $this->fetchMilestonesForTask($tenantId, (int) $row['id']);

        return Response::json(['data' => $task], 200);
    }

    /**
     * OU-aware task lookup for {@see self::getOne()} — see that method's own
     * docblock for why this differs from the tenant-scoped-only
     * {@see self::findScoped()} above. tenant_id is bound explicitly on BOTH
     * sides of the join (`:tenant_id` on tasker_tasks, `:tenant_id_p` on
     * tasker_projects) — matching
     * {@see \Tasker\Access\IdentifierResolver::taskByColumn()}'s own
     * precedent — rather than the child-table-only binding some of this
     * codebase's older OU-aware joins carry (create()'s own section check
     * above, and MilestonesApiHandler::taskVisible()/
     * TaskDiscussionsApiHandler::taskVisible() only bind tenant_id on the
     * child table's side); that gap is a known, separately-tracked
     * carry-over item, not a pattern to repeat in new code.
     *
     * @return array<string, mixed>|null
     */
    private function findVisible(int $tenantId, ?int $callerOuId, int $taskId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $this->db->prepare(
            "SELECT t.id, t.public_id, t.tenant_id, t.project_id, t.section_id, t.group_id, t.text, t.detail,
                    t.status, t.priority, t.due_date, t.pinned, t.pinned_at, t.sort_order, t.completed_at,
                    t.short_id, t.created_by, t.created_at, t.updated_at
             FROM tasker_tasks t
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

        return is_array($row) ? $row : null;
    }

    /**
     * $taskId's milestones, ordered by sort_order then id — matching
     * {@see \Tasker\Api\MilestonesApiHandler::listForTask()}'s own ordering
     * and shape for the milestone fields it selects.
     *
     * @return list<array<string, mixed>>
     */
    private function fetchMilestonesForTask(int $tenantId, int $taskId): array
    {
        $stmt = $this->db->prepare(
            'SELECT id, summary, detail, checked, sort_order
             FROM tasker_milestones
             WHERE tenant_id = :tenant_id AND task_id = :task_id
             ORDER BY sort_order ASC, id ASC'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':task_id' => $taskId]);

        $milestones = [];
        /** @var array<string, mixed> $row */
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $milestones[] = [
                'id' => (int) $row['id'],
                'summary' => (string) $row['summary'],
                'detail' => $row['detail'],
                'checked' => self::dbTruthy($row['checked']),
                'sortOrder' => (int) $row['sort_order'],
            ];
        }

        return $milestones;
    }

    /**
     * Whether $sectionId exists and belongs to $tenantId — tenant-scoped
     * only, per this method's own I7 note (listForSection() is explicitly
     * not part of C1's OU-scoping fix).
     */
    private function sectionExistsInTenant(int $tenantId, int $sectionId): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id');
        $stmt->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);

        return $stmt->fetch() !== false;
    }

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
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $idCol = $this->idColumn();
        $stmt = $this->db->prepare(
            "SELECT {$idCol} AS id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                    due_date, pinned, pinned_at, sort_order, completed_at, short_id, created_by, created_at, updated_at
             FROM tasker_tasks WHERE {$idCol} = :id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * The physical column every id-keyed SELECT/UPDATE/DELETE above matches
     * against.
     *
     * On PostgreSQL (production; see CreateTaskerTasksTable) `id BIGSERIAL
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
     * through update()/move()/delete()/complete()/uncomplete()/pin()/tag()
     * within the same test run.
     *
     * Mirrors the identical id/rowid branch already established in
     * {@see \Tasker\Api\SectionsApiHandler::idColumn()} and
     * {@see \Tasker\Api\GroupsApiHandler::idColumn()} for the exact same
     * reason.
     */
    private function idColumn(): string
    {
        return $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? 'rowid' : 'id';
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
     * Coerce a DB boolean column to a real bool across drivers.
     *
     * CRITICAL: pdo_pgsql can return a boolean column as the STRING "f" for
     * false, and PHP's (bool) cast treats the non-empty string "f" as TRUE
     * — a naive `(bool) $row['pinned']` would therefore report every
     * unpinned task as pinned over the real API. SQLite's in-memory double
     * (this plugin's own unit tests) yields 0/1 (int) instead; either engine
     * may also hand back a native PHP bool directly (e.g. a plain, unbound
     * SELECT literal). This mirrors the identical, four-times-repeated fix
     * already established elsewhere in this codebase for the exact same
     * driver quirk — see {@see \Whity\Core\Identity\IdentityProviderRepository::toBool()},
     * {@see \Whity\Core\Identity\ProfileEmailRepository::toBool()},
     * {@see \Whity\Core\Relations\RelationRepository::toBool()}, and
     * `TwoFactorHandler::dbTruthy()`/`AuthHandler::dbTruthy()`/
     * `TwoFactorPoliciesApiHandler::dbTruthy()` (all private-static, so
     * replicated here rather than reused directly).
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
