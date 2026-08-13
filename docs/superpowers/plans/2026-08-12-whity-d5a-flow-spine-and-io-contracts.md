# D5a — Flow Spine and I/O Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Tasker-on-whity flows that exist, connect through typed I/O edges with contracts, and order themselves topologically — 15 new MCP tools, nothing executing yet.

**Architecture:** A `tasker_flows` table (dual-key, OU-scoped through its project) plus a normalised `tasker_task_edges` table replacing the original's `tasks.input` JSON array, plus four additive columns on `tasker_tasks`. Two pure domain classes carry the only non-trivial logic — a topological sorter with cycle detection, and a contract deriver that merges consumers' demands into a producer's definition-of-done. Two thin API handlers and 15 route methods sit on top.

**Tech Stack:** PHP 8.4, PostgreSQL 15 (production + the OU test tier), SQLite (the pure/unit test tier), FrankenPHP, whity-core as a pinned vendored clone at `host/.core/` (never patched), PHPUnit, PHPStan level 6.

**Spec:** [2026-08-12-d5a-flow-spine-and-io-contracts-design.md](../specs/2026-08-12-d5a-flow-spine-and-io-contracts-design.md)
**Binding cross-slice decisions:** [2026-08-12-cross-slice-architecture-decisions.md](../specs/2026-08-12-cross-slice-architecture-decisions.md)

**Baseline at the start of this plan** (`origin/trunk` `5e2289f`): 378 tests / 883 assertions / **0 skipped**; PHPStan clean at level 6 via the repo's own unmodified script; 49 MCP tools; parity allowlist 19 entries / 56 divergences / 4 semantic.

## Global Constraints

Every task's requirements implicitly include this section.

- Every query binds `tenant_id` explicitly. No implicit tenant filtering.
- **One static SQL template per OU predicate — never branch WHERE or ORDER BY text at runtime.** A caller-supplied value must never reach SQL text.
- A resource outside the caller's tenant or OU scope reports **404**, never a distinguishable error. A malformed short id returns **400**. Caller identity or OU membership that cannot be resolved must **fail closed with 403**.
- Dual keys everywhere: internal `id BIGSERIAL PRIMARY KEY` plus external `public_id UUID NOT NULL UNIQUE`, PHP-generated.
- Routes declared without `/v1`; every route declares an explicit `schema.operationId`.
- `host/.core/` is **never** hand-patched. Reading it, and using its classes from test code, is expected.
- Booleans bind with `PDO::PARAM_BOOL` explicitly — array-`execute()` binds `false` as an empty string, which Postgres rejects.
- Migrations use `CURRENT_TIMESTAMP`, never `NOW()`; UUIDs are PHP-generated, never `gen_random_uuid()` — the SQLite tier must be able to run them.
- Query parameters are read via `TaskerPlugin::queryParam()` (which reads `$_GET`), **never** `parse_url($request->getPath())` — `Request::fromGlobals()` strips the query from `getPath()`, so path-based parsing silently returns null in production.
- **Core merges all remaining MCP tool arguments into the query string and empties the body for `GET`, `DELETE` and `HEAD`.** So a DELETE identifier must be read via `identifierFromRequest()`, which covers body-then-query.
- **A mutating route never resolves its own target from a caller default.** Confirming a request only means something if the caller also named what they confirmed.
- Defence in depth: handlers keep their own OU-aware checks *in addition to* the route-level `IdentifierResolver` call.
- **Test tiers:** `plugin/tests/Api/*Test.php` and `plugin/tests/Domain/*Test.php` run on **SQLite**; `plugin/tests/TenantIsolationOuTest.php` runs on **PostgreSQL**. `OuScopeResolver::whereFragment()` emits `= ANY(:scope)` unconditionally and fails at `PDO::prepare()` under SQLite even with a null caller OU — so **any OU-aware method gets all of its coverage in the Postgres tier**.
- Every OU-boundary test pairs a sibling-OU 404 with a **same-OU positive control**. A 404-only test can pass because the fixture was never visible in the first place.
- Use the `Edit` tool on PHP files. **Never** PowerShell `Set-Content` — it added a BOM and CRLF once in this project and broke `declare(strict_types=1)`.
- PHPStan is run as CI runs it: `npm run plugin:stan`, no manual flags.

## Existing interfaces this plan builds on

Copied verbatim from the code at `5e2289f` so no task has to guess:

```php
// plugin/Access/IdentifierResolver.php
public static function classify(string|int|null $raw): string
//   returns exactly one of: 'empty' 'integer' 'uuid' 'short_id' 'prefix' 'slug' 'malformed_short_id'
public static function resolveTask(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw): ?int
public static function resolveProject(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw, ?int $defaultProjectId = null): ?int

// plugin/Access/OuScopeResolver.php
public static function scopeParams(PDO $pdo, int $tenantId, ?int $callerOuId): array
public static function whereFragment(string $column): string
//   emits: (:unrestricted = TRUE OR {$column} IS NULL OR {$column} = ANY(:scope))

// plugin/Domain/ShortIdAllocator.php  -- NOTE: hardcoded to tasker_tasks; Task 1 generalises it
public static function next(PDO $db, int $tenantId, int $projectId): int
public static function isRaceLoss(PDOException $e): bool
public static function withRetry(PDO $db, int $tenantId, int $projectId, callable $insert): int

// plugin/TaskerPlugin.php private helpers -- reuse, never reimplement
private function identifierFromRequest(Request $request, string $key): string|int|null
private function wrongTypedIdentifierError(Request $request, string ...$keys): ?Response
private function queryParam(Request $request, string $name): ?string
private function queryParamBool(Request $request, string $name, bool $default): bool
private function paramBool(Request $request, string $name, bool $default): bool
private function defaultProjectIdFor(Request $request, int $tenantId): ?int
private function callerProfileId(Request $request): ?int
private function resolveCallerOu(\PDO $pdo, Request $request, int $tenantId): array  // ['resolved'=>bool,'ouId'=>?int]
private function requireTenantId(): ?int
private function resolvePdo(): \PDO
private function toHostRequest(Request $request): \Whity\Core\Request
```

A route entry's exact shape (copy this structure):

```php
[
    'method' => 'POST',
    'path' => '/api/tasker/flows/name',
    'handler' => [$this, 'nameFlow'],
    'requiredRole' => null,
    'requiredPermission' => 'tasker_project:manage',
    'schema' => [
        'operationId' => 'name_flow',
        'summary' => '...',
        'tags' => ['tasker'],
        'request' => ['type' => 'object', 'required' => [...], 'properties' => [...]],
        'responses' => [200 => ['description' => '...'], 400 => [...], 404 => [...], 422 => [...]],
    ],
],
```

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `plugin/Migrations/CreateTaskerFlowsTable.php` | The flows table, both unique constraints, the project index |
| `plugin/Migrations/CreateTaskerTaskEdgesTable.php` | The edge table, both cascading FKs, pair-uniqueness, no-self-edge check, two directional indexes |
| `plugin/Migrations/AddTaskerTaskFlowAndContractColumns.php` | Four additive `tasker_tasks` columns + the `(flow_id, flow_step)` index |
| `plugin/Domain/FlowStepSorter.php` | Pure topological sort + cycle detection. No PDO, no tenant, no OU. |
| `plugin/Domain/ContractDeriver.php` | Pure merge of consumer edge rules into a producer draft contract + an `assumptions` list |
| `plugin/Api/FlowsApiHandler.php` | Flow lifecycle, context, order, recompute |
| `plugin/Api/TaskEdgesApiHandler.php` | Edges, producer contract, blessing, connections |
| `plugin/tests/Domain/FlowStepSorterTest.php` | SQLite tier — the sorter is pure |
| `plugin/tests/Domain/ContractDeriverTest.php` | SQLite tier — the deriver is pure |

**Modify**

| File | Change |
|---|---|
| `plugin/Domain/ShortIdAllocator.php` | Generalise to a second table without changing task behaviour |
| `plugin/Access/IdentifierResolver.php` | New `flow_short_id` form in `classify()`, plus `resolveFlow()` |
| `plugin/TaskerPlugin.php` | 15 route definitions + 15 route methods |
| `plugin/Api/TasksApiHandler.php` | Board retrofit: exclude flow steps from `listFiltered()`, `readyWork()` |
| `plugin/Api/ProjectsApiHandler.php` | Board retrofit: `getOne()` sections/tasks + tallies |
| `plugin/Api/BoardApiHandler.php` | Board retrofit: `get()` + tallies |
| `plugin/Api/AttentionApiHandler.php` | Board retrofit: `rank()` + both attention buckets |
| `plugin/tests/Contract/parity-allowlist.php` | Entries for the SEMANTIC divergences |
| `host/scripts/mcp-tools.ps1` | Allowlist 49 → 64 |
| `plugin/tests/TenantIsolationOuTest.php` | All OU-scoped coverage |

---

## Task 1: Generalise `ShortIdAllocator` for a second table

The spec says flow short ids "reuse the D1b `ShortIdAllocator`". **They cannot, as written.** `next()` hardcodes `FROM tasker_tasks`, and `isRaceLoss()` narrows SQLite's broad `23000` by matching the message against `tasker_tasks` **and both column names** — read that method's docblock before touching it. It records that an earlier version matched on the index name instead and consequently *never matched a real SQLite error at all*, silently turning the SQLite retry path into dead code. Repeating that mistake for flows is the specific risk here.

**Files:**
- Modify: `plugin/Domain/ShortIdAllocator.php`
- Test: `plugin/tests/Domain/ShortIdAllocatorTest.php`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ShortIdAllocator::next(PDO $db, int $tenantId, int $projectId, string $table = 'tasker_tasks'): int`, `isRaceLoss(PDOException $e, string $table = 'tasker_tasks'): bool`, `withRetry(PDO $db, int $tenantId, int $projectId, callable $insert, string $table = 'tasker_tasks'): int`. Defaults keep every existing call site byte-compatible.

- [ ] **Step 1: Write the failing tests**

Add to `plugin/tests/Domain/ShortIdAllocatorTest.php`:

```php
    public function testNextAllocatesPerTableSoFlowsAndTasksDoNotShareASequence(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_flows (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL, short_id INTEGER)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 40)');
        $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 2)');

        self::assertSame(41, ShortIdAllocator::next($this->pdo, 7, 3));
        self::assertSame(3, ShortIdAllocator::next($this->pdo, 7, 3, 'tasker_flows'));
    }

    public function testIsRaceLossMatchesTheFlowTablesOwnSqliteMessage(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_flows (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL, short_id INTEGER)');
        $this->pdo->exec('CREATE UNIQUE INDEX idx_tasker_flows_project_short_id ON tasker_flows (project_id, short_id)');
        $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (1, 7, 3, 1)');

        try {
            $this->pdo->exec('INSERT INTO tasker_flows (id, tenant_id, project_id, short_id) VALUES (2, 7, 3, 1)');
            self::fail('expected a unique violation');
        } catch (\PDOException $e) {
            self::assertTrue(
                ShortIdAllocator::isRaceLoss($e, 'tasker_flows'),
                'the flow table must get REAL race detection, not a check that silently never matches'
            );
            self::assertFalse(
                ShortIdAllocator::isRaceLoss($e, 'tasker_tasks'),
                'a flow violation must not read as a task violation'
            );
        }
    }
```

- [ ] **Step 2: Run them and confirm they fail**

```powershell
npm run plugin:test
```

Expected: FAIL — `next()` takes three arguments, `isRaceLoss()` takes one.

- [ ] **Step 3: Generalise, keeping the task path identical**

In `next()`, interpolate the table name **from a whitelist**, never from a caller value — the global constraint forbids caller-derived SQL text:

```php
    private const ALLOWED_TABLES = ['tasker_tasks', 'tasker_flows'];

    public static function next(PDO $db, int $tenantId, int $projectId, string $table = 'tasker_tasks'): int
    {
        $table = self::assertTable($table);

        $stmt = $db->prepare(
            "SELECT COALESCE(MAX(short_id), 0) + 1 FROM {$table}
             WHERE project_id = :project_id AND tenant_id = :tenant_id"
        );
        $stmt->execute([':project_id' => $projectId, ':tenant_id' => $tenantId]);

        return (int) $stmt->fetchColumn();
    }

    private static function assertTable(string $table): string
    {
        if (!in_array($table, self::ALLOWED_TABLES, true)) {
            throw new \InvalidArgumentException('Unknown short-id table: ' . $table);
        }

        return $table;
    }
```

`isRaceLoss()` keeps its existing Postgres `23505` check unchanged, and parameterises only the SQLite message narrowing so it matches `{$table}.project_id` and `{$table}.short_id`. Preserve the existing docblock and extend it to say the check is now per-table and why that matters.

- [ ] **Step 4: Run the full suite**

```powershell
npm run plugin:test
```

Expected: PASS with **0 skipped**, and every pre-existing `ShortIdAllocator` test still green — the defaults mean no call site changed.

- [ ] **Step 5: Commit**

```bash
git add plugin/Domain/ShortIdAllocator.php plugin/tests/Domain/ShortIdAllocatorTest.php
git commit -m "refactor: let ShortIdAllocator serve a second table, with real per-table race detection"
```

---

## Task 2: Migrations — flows, edges, and the task columns

**Files:**
- Create: `plugin/Migrations/CreateTaskerFlowsTable.php`, `plugin/Migrations/CreateTaskerTaskEdgesTable.php`, `plugin/Migrations/AddTaskerTaskFlowAndContractColumns.php`
- Test: `plugin/tests/TenantIsolationOuTest.php` (schema assertions), plus the SQLite fixture files that build these tables

**Interfaces:**
- Produces: the three tables/columns every later task depends on. Column names are fixed here and must not drift: `tasker_flows(id, public_id, tenant_id, project_id, name, context, step_list_open, short_id, created_by, created_at, updated_at)`; `tasker_task_edges(id, public_id, tenant_id, source_task_id, target_task_id, expected_type, contract, created_at)`; `tasker_tasks(+flow_id, +flow_step, +output_contract, +output_contract_blessed)`.

- [ ] **Step 1: Write the failing schema test**

Add to `plugin/tests/TenantIsolationOuTest.php`:

```php
    public function testFlowAndEdgeSchemaEnforcesItsOwnInvariants(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Flow Schema');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');

        // A self-edge is refused by CHECK.
        try {
            $this->pdo->exec("INSERT INTO tasker_task_edges (public_id, tenant_id, source_task_id, target_task_id)
                              VALUES ('11111111-1111-4111-8111-111111111111', 7, {$a}, {$a})");
            self::fail('a self-edge must be refused');
        } catch (\PDOException $e) {
            self::assertNotSame('', $e->getMessage());
        }

        // Deleting the producer removes the edge by cascade -- no dangling source.
        $this->pdo->exec("INSERT INTO tasker_task_edges (public_id, tenant_id, source_task_id, target_task_id)
                          VALUES ('22222222-2222-4222-8222-222222222222', 7, {$a}, {$b})");
        $this->pdo->exec("DELETE FROM tasker_tasks WHERE id = {$a}");

        $left = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_edges')->fetchColumn();
        self::assertSame(0, $left, 'deleting a producer must cascade its edges away');
    }
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL — `tasker_task_edges` does not exist.

- [ ] **Step 3: Write the three migrations**

Follow the shape of `plugin/Migrations/AddTaskerTaskShortIdUnique.php` exactly (namespace `Tasker\Migrations`, `use Whity\Sdk\MigrationInterface`).

`CreateTaskerFlowsTable`:

```sql
CREATE TABLE IF NOT EXISTS tasker_flows (
    id              BIGSERIAL PRIMARY KEY,
    public_id       UUID        NOT NULL UNIQUE,
    tenant_id       BIGINT      NOT NULL,
    project_id      BIGINT      NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    context         JSONB       NOT NULL DEFAULT '{}',
    step_list_open  BOOLEAN     NOT NULL DEFAULT FALSE,
    short_id        INTEGER,
    created_by      BIGINT,
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_flows_project_name     ON tasker_flows (project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_flows_project_short_id ON tasker_flows (project_id, short_id);
CREATE INDEX        IF NOT EXISTS idx_tasker_flows_project          ON tasker_flows (project_id);
```

`CreateTaskerTaskEdgesTable`:

```sql
CREATE TABLE IF NOT EXISTS tasker_task_edges (
    id             BIGSERIAL PRIMARY KEY,
    public_id      UUID      NOT NULL UNIQUE,
    tenant_id      BIGINT    NOT NULL,
    source_task_id BIGINT    NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
    target_task_id BIGINT    NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
    expected_type  TEXT,
    contract       JSONB,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tasker_task_edges_no_self CHECK (source_task_id <> target_task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_task_edges_pair   ON tasker_task_edges (target_task_id, source_task_id);
CREATE INDEX        IF NOT EXISTS idx_tasker_task_edges_source ON tasker_task_edges (source_task_id);
CREATE INDEX        IF NOT EXISTS idx_tasker_task_edges_target ON tasker_task_edges (target_task_id);
```

`AddTaskerTaskFlowAndContractColumns` — additive `ALTER`s, no data migration, since no existing row is a flow step:

```sql
ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS flow_id                 BIGINT  REFERENCES tasker_flows(id) ON DELETE SET NULL;
ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS flow_step               INTEGER;
ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS output_contract         JSONB;
ALTER TABLE tasker_tasks ADD COLUMN IF NOT EXISTS output_contract_blessed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_tasker_tasks_flow_step ON tasker_tasks (flow_id, flow_step);
```

**SQLite caveat:** SQLite does not enforce foreign keys unless `PRAGMA foreign_keys = ON`. Check how the existing fixture opens its connection; if the pragma is off, the cascade assertion belongs in the Postgres tier only, and the SQLite fixture gets a docblock saying it cannot prove cascade — the same note `SectionsApiHandlerTest` already carries.

- [ ] **Step 4: Run and commit**

```powershell
npm run plugin:test
```

```bash
git add plugin/Migrations plugin/tests
git commit -m "feat: flows table, normalised task edges, and the flow/contract task columns"
```

---

## Task 3: `FlowStepSorter` — topological order and cycle detection

The only algorithmically interesting piece, and deliberately **pure** so it tests on SQLite while everything else in this slice is Postgres-only.

**Files:**
- Create: `plugin/Domain/FlowStepSorter.php`, `plugin/tests/Domain/FlowStepSorterTest.php`

**Interfaces:**
- Produces:
  ```php
  /** @param list<array{source:int,target:int}> $edges
   *  @param list<int> $taskIds
   *  @return array{ok:true,positions:array<int,int>}|array{ok:false,cycle:list<int>} */
  public static function sort(array $taskIds, array $edges): array
  ```
  `positions` maps task id → 1-based `flow_step`. On a cycle, `cycle` is the offending path so the error message can name it.

- [ ] **Step 1: Write the failing tests**

```php
    public function testOrdersAChainAndNumbersFromOne(): void
    {
        $r = FlowStepSorter::sort([10, 20, 30], [
            ['source' => 10, 'target' => 20],
            ['source' => 20, 'target' => 30],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame([10 => 1, 20 => 2, 30 => 3], $r['positions']);
    }

    public function testADiamondPutsTheJoinLast(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 1, 'target' => 3],
            ['source' => 2, 'target' => 4],
            ['source' => 3, 'target' => 4],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame(1, $r['positions'][1]);
        self::assertSame(4, $r['positions'][4]);
        self::assertGreaterThan($r['positions'][1], $r['positions'][2]);
        self::assertGreaterThan($r['positions'][3], $r['positions'][4]);
    }

    public function testIndependentSiblingsOrderStablyByTaskId(): void
    {
        // No edges at all: order must be deterministic, not hash order.
        $r = FlowStepSorter::sort([30, 10, 20], []);

        self::assertTrue($r['ok']);
        self::assertSame([10 => 1, 20 => 2, 30 => 3], $r['positions']);
    }

    public function testDisconnectedComponentsAreBothOrdered(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 3, 'target' => 4],
        ]);

        self::assertTrue($r['ok']);
        self::assertCount(4, $r['positions']);
        self::assertGreaterThan($r['positions'][1], $r['positions'][2]);
        self::assertGreaterThan($r['positions'][3], $r['positions'][4]);
    }

    public function testASingleNodeFlowIsPositionOne(): void
    {
        $r = FlowStepSorter::sort([99], []);

        self::assertTrue($r['ok']);
        self::assertSame([99 => 1], $r['positions']);
    }

    public function testACycleIsReportedWithItsPath(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3], [
            ['source' => 1, 'target' => 2],
            ['source' => 2, 'target' => 3],
            ['source' => 3, 'target' => 1],
        ]);

        self::assertFalse($r['ok']);
        self::assertNotEmpty($r['cycle'], 'the caller needs the path to name it in a 422');
    }

    public function testAnEdgeTouchingATaskOutsideTheFlowIsIgnored(): void
    {
        // Edges may reference tasks in the project that are not flow members.
        $r = FlowStepSorter::sort([1, 2], [
            ['source' => 1, 'target' => 2],
            ['source' => 999, 'target' => 2],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame([1 => 1, 2 => 2], $r['positions']);
        self::assertArrayNotHasKey(999, $r['positions']);
    }
```

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — class does not exist.

- [ ] **Step 3: Implement Kahn's algorithm with a deterministic tiebreak**

```php
    /**
     * @param list<int> $taskIds
     * @param list<array{source:int,target:int}> $edges
     * @return array{ok:true,positions:array<int,int>}|array{ok:false,cycle:list<int>}
     */
    public static function sort(array $taskIds, array $edges): array
    {
        $members = [];
        foreach ($taskIds as $id) {
            $members[$id] = true;
        }

        /** @var array<int, list<int>> $out */
        $out = [];
        /** @var array<int, int> $inDegree */
        $inDegree = array_fill_keys($taskIds, 0);

        foreach ($edges as $edge) {
            // An edge may reference a task in the project that is NOT a flow
            // member; it constrains nothing inside this flow, so skip it.
            if (!isset($members[$edge['source']], $members[$edge['target']])) {
                continue;
            }
            $out[$edge['source']][] = $edge['target'];
            $inDegree[$edge['target']]++;
        }

        // Ready set drained in ascending task-id order, so independent siblings
        // get stable positions instead of PHP's array-insertion order.
        $ready = [];
        foreach ($inDegree as $id => $degree) {
            if ($degree === 0) {
                $ready[] = $id;
            }
        }
        sort($ready);

        $positions = [];
        $step      = 1;

        while ($ready !== []) {
            $id             = array_shift($ready);
            $positions[$id] = $step++;
            $freed          = [];

            foreach ($out[$id] ?? [] as $next) {
                if (--$inDegree[$next] === 0) {
                    $freed[] = $next;
                }
            }

            if ($freed !== []) {
                $ready = array_merge($ready, $freed);
                sort($ready);
            }
        }

        if (count($positions) !== count($taskIds)) {
            return ['ok' => false, 'cycle' => self::cyclePath($taskIds, $positions, $out)];
        }

        return ['ok' => true, 'positions' => $positions];
    }

    /**
     * Every task with no assigned position is in, or downstream of, a cycle.
     * Walk from the lowest such id following unassigned successors until a node
     * repeats — that repeat closes the loop, and the slice from its first
     * appearance is the path to name in the 422.
     *
     * @param list<int>              $taskIds
     * @param array<int, int>        $positions
     * @param array<int, list<int>>  $out
     * @return list<int>
     */
    private static function cyclePath(array $taskIds, array $positions, array $out): array
    {
        $stuck = array_values(array_filter($taskIds, static fn(int $id): bool => !isset($positions[$id])));
        sort($stuck);

        $path = [];
        $seen = [];
        $at   = $stuck[0];

        while (!isset($seen[$at])) {
            $seen[$at] = count($path);
            $path[]    = $at;

            $nextUnassigned = null;
            foreach ($out[$at] ?? [] as $candidate) {
                if (!isset($positions[$candidate])) {
                    $nextUnassigned = $candidate;
                    break;
                }
            }

            if ($nextUnassigned === null) {
                return $path;
            }
            $at = $nextUnassigned;
        }

        return array_slice($path, $seen[$at]);
    }
```

- [ ] **Step 4: Run and commit**

```bash
git add plugin/Domain/FlowStepSorter.php plugin/tests/Domain/FlowStepSorterTest.php
git commit -m "feat: pure topological sorter with cycle detection for flow step order"
```

---

## Task 4: `IdentifierResolver` — the `F`-prefixed flow form

Flows are addressed as `TDE-F1` (per the original's `resolve_reference`). `classify()` gains one form, and `resolveFlow()` joins to `tasker_projects` for OU scope exactly as `resolveTask()` does.

**Files:**
- Modify: `plugin/Access/IdentifierResolver.php`
- Test: `plugin/tests/TenantIsolationOuTest.php` (OU-scoped) and the existing SQLite `classify()` test file (pure)

**Interfaces:**
- Produces: `classify()` may now return `'flow_short_id'`; `public static function resolveFlow(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw): ?int`.

- [ ] **Step 1: Write the failing tests**

`classify()` is pure, so its cases go in the SQLite tier:

```php
    public function testClassifyRecognisesTheFlowShortIdForm(): void
    {
        self::assertSame('flow_short_id', IdentifierResolver::classify('TDE-F1'));
        self::assertSame('flow_short_id', IdentifierResolver::classify('tde-f12'));
        self::assertSame('short_id', IdentifierResolver::classify('TDE-1'), 'a task short id must not become a flow one');
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-F'), 'F with no number is malformed, not a slug');
    }
```

OU scope goes in the Postgres tier, with the mandatory positive control:

```php
    public function testResolveFlowRefusesASiblingOusFlowButFindsItsOwn(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $mine    = $this->makeFlowDirect(7, $this->makeProjectDirect(7, 2, 'Mine', 'MIN'), 'Mine flow', 1);
        $sibling = $this->makeFlowDirect(7, $this->makeProjectDirect(7, 3, 'Theirs', 'THR'), 'Their flow', 1);

        self::assertSame($mine, IdentifierResolver::resolveFlow($this->pdo, 7, 2, 'MIN-F1'));
        self::assertNull(IdentifierResolver::resolveFlow($this->pdo, 7, 2, 'THR-F1'));
    }
```

Add a `makeFlowDirect(int $tenantId, int $projectId, string $name, int $shortId): int` fixture helper alongside the existing `make*Direct` helpers.

- [ ] **Step 2: Run and confirm failure** — `classify()` returns `'slug'` for `TDE-F1`, and `resolveFlow()` does not exist.

- [ ] **Step 3: Implement**

Add the flow-short-id pattern to `classify()` **before** the task short-id pattern so `TDE-F1` cannot be swallowed by it, and make `TDE-F` (prefix + F with no digits) classify as `malformed_short_id` rather than falling through to `slug`.

Read the existing task short-id branch first and mirror its style. The two patterns, anchored and case-insensitive:

```php
    // A flow: PREFIX-F<n>, e.g. TDE-F1. MUST be tested before the task
    // pattern below, which would otherwise treat "F1" as a malformed number.
    if (preg_match('/^[A-Za-z]{2,5}-F\d+$/', $value) === 1) {
        return 'flow_short_id';
    }

    // PREFIX-F with no digits is a malformed flow id, NOT a slug. Without
    // this, "TDE-F" resolves as a slug lookup that silently finds nothing
    // instead of telling the caller their identifier is wrong.
    if (preg_match('/^[A-Za-z]{2,5}-F$/', $value) === 1) {
        return 'malformed_short_id';
    }
```

Then in `resolveFlow()`, split the matched value on `-F` to get the project prefix and the flow number, and resolve with one static template:

```php
    $stmt = $db->prepare(
        'SELECT f.id FROM tasker_flows f
         JOIN tasker_projects p ON p.id = f.project_id
         WHERE UPPER(p.prefix) = :prefix
           AND f.short_id = :short_id
           AND f.tenant_id = :tenant_id
           AND p.tenant_id = :tenant_id_p
           AND ' . OuScopeResolver::whereFragment('p.ou_id') . '
         LIMIT 1'
    );
```

Bind the OU scope params from `OuScopeResolver::scopeParams()`, exactly as `taskByColumn()` does — read that method and match its binding style rather than inventing one.

`resolveFlow()` mirrors `resolveTask()`'s structure: return null for `'empty'` and `'malformed_short_id'`; resolve `'uuid'` on `public_id`, `'integer'` on `id`, `'flow_short_id'` by splitting prefix and number then joining `tasker_projects p ON p.id = f.project_id`. Bind `tenant_id` on **both** sides — `f.tenant_id` and `p.tenant_id` — and apply `OuScopeResolver::whereFragment('p.ou_id')`. One static template per form.

- [ ] **Step 4: Run and commit**

```bash
git add plugin/Access/IdentifierResolver.php plugin/tests
git commit -m "feat: resolve flows by the F-prefixed short id, OU-scoped"
```

---

## Task 5: `FlowsApiHandler` + `name_flow` / `list_flows` / `delete_flow`

`name_flow` is the flow-**creating** call: it inserts the row, stamps `flow_id` on the members, and computes the initial `flow_step` ordering. There is no separate create tool.

**Files:**
- Create: `plugin/Api/FlowsApiHandler.php`
- Modify: `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Consumes: `FlowStepSorter::sort()` (Task 3), `ShortIdAllocator::withRetry(..., 'tasker_flows')` (Task 1), `IdentifierResolver::resolveFlow()` (Task 4).
- Produces:
  ```php
  public function name(int $tenantId, ?int $callerOuId, int $projectId, string $name, array $taskIds, ?array $context, bool $stepListOpen, ?int $createdBy): Response
  public function list(int $tenantId, ?int $callerOuId, ?int $projectId): Response
  public function delete(int $tenantId, ?int $callerOuId, int $flowId): Response
  private function flowVisible(int $tenantId, ?int $callerOuId, int $flowId): ?array
  ```

- [ ] **Step 1: Write the failing tests**

```php
    public function testNameFlowStampsMembershipAndInitialOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Naming', 'NAM');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'First');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'Second');
        $this->insertEdgeDirect(7, $a, $b);

        $handler = new FlowsApiHandler($this->pdo);
        $payload = json_decode($handler->name(7, null, $projectId, 'Build flow', [$a, $b], null, false, 2)->getBody(), true);

        self::assertSame('Build flow', $payload['data']['name']);
        self::assertSame('NAM-F1', $payload['data']['shortId']);

        $rows = $this->pdo->query("SELECT id, flow_step FROM tasker_tasks WHERE flow_id IS NOT NULL ORDER BY flow_step")->fetchAll(\PDO::FETCH_ASSOC);
        self::assertSame([$a, $b], array_map(static fn($r) => (int) $r['id'], $rows));
        self::assertSame([1, 2], array_map(static fn($r) => (int) $r['flow_step'], $rows));
    }

    public function testNameFlowRefusesATaskFromAnotherProject(): void
    {
        $mine    = $this->makeProjectDirect(7, null, 'Mine', 'MI2');
        $other   = $this->makeProjectDirect(7, null, 'Other', 'OT2');
        $foreign = $this->makeTaskDirect(7, $other, $this->makeSectionDirect(7, $other), 'Foreign');

        $handler = new FlowsApiHandler($this->pdo);

        self::assertSame(422, $handler->name(7, null, $mine, 'Bad flow', [$foreign], null, false, 2)->getStatusCode());
    }

    public function testDeleteFlowReturnsTasksToTheBoardAndKeepsTheirEdges(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Dismantle', 'DIS');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');
        $this->insertEdgeDirect(7, $a, $b);

        $handler = new FlowsApiHandler($this->pdo);
        $flowId  = (int) json_decode($handler->name(7, null, $projectId, 'Doomed', [$a, $b], null, false, 2)->getBody(), true)['data']['id'];

        self::assertSame(200, $handler->delete(7, null, $flowId)->getStatusCode());

        self::assertSame(2, (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_tasks WHERE flow_id IS NULL AND project_id = {$projectId}")->fetchColumn());
        self::assertSame(1, (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_edges')->fetchColumn(),
            'dismantling a flow must NOT dismantle the I/O graph its tasks share');
    }

    public function testNameFlowRejectsACycle(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Cyclic', 'CYC');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');
        $this->insertEdgeDirect(7, $a, $b);
        $this->insertEdgeDirect(7, $b, $a);

        $handler = new FlowsApiHandler($this->pdo);

        self::assertSame(422, $handler->name(7, null, $projectId, 'Loop', [$a, $b], null, false, 2)->getStatusCode());
    }

    public function testFlowsDeleteRejects404ForASiblingOusFlowAndDeletesItsOwn(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $sibling = $this->makeFlowDirect(7, $this->makeProjectDirect(7, 3, 'Sib', 'SB2'), 'Sib flow', 1);
        $mine    = $this->makeFlowDirect(7, $this->makeProjectDirect(7, 2, 'Own', 'OW2'), 'Own flow', 1);

        $handler = new FlowsApiHandler($this->pdo);

        self::assertSame(404, $handler->delete(7, 2, $sibling)->getStatusCode());
        self::assertSame(200, $handler->delete(7, 2, $mine)->getStatusCode());
    }
```

Add an `insertEdgeDirect(int $tenantId, int $sourceId, int $targetId): int` fixture helper.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the handler and the three routes**

`name()` runs in **one transaction**: validate every task id belongs to `$projectId` (422 naming the offender if not), load the edges among those tasks, call `FlowStepSorter::sort()` (422 with the cycle path if `ok` is false), insert the flow via `ShortIdAllocator::withRetry(..., 'tasker_flows')`, then `UPDATE tasker_tasks SET flow_id = :flow_id, flow_step = :step` per member.

`delete()` deletes the flow row only; `ON DELETE SET NULL` returns the tasks. Do **not** touch `tasker_task_edges`.

`flowVisible()` is the handler-level OU check — joins `tasker_projects` and applies `whereFragment('p.ou_id')`, binding tenant on both sides. Keep it even though the route already resolved OU-scoped: that is the standing defence-in-depth rule.

Routes: `POST /api/tasker/flows/name` → `name_flow`; `GET /api/tasker/flows` → `list_flows` (optional `project_id` with the `defaultProjectIdFor()` fallback, matching `list_sections`); `DELETE /api/tasker/flows` → `delete_flow`, reading `flow_id` via `identifierFromRequest()` because **core empties the DELETE body**. `delete_flow` must **400 on an absent `flow_id`** and never fall back to a default — the mutating-route rule.

- [ ] **Step 4: Run, verify the allowlist, commit**

```powershell
npm run plugin:test
```

```bash
git add plugin/Api/FlowsApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: name_flow creates a flow with membership and topological order"
```

---

## Task 6: `build_new_flow`, `get_flow_context`, `update_flow_context`

**Files:**
- Modify: `plugin/Api/FlowsApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Produces: `FlowsApiHandler::getContext(int $tenantId, ?int $callerOuId, int $flowId): Response`, `updateContext(int $tenantId, ?int $callerOuId, int $flowId, array $context, bool $merge, ?bool $stepListOpen): Response`.

- [ ] **Step 1: Write the failing tests**

```php
    public function testFlowContextMergesByDefaultAndReplacesWhenAsked(): void
    {
        $flowId  = $this->makeFlowDirect(7, $this->makeProjectDirect(7, null, 'Ctx', 'CTX'), 'Ctx flow', 1);
        $handler = new FlowsApiHandler($this->pdo);

        $handler->updateContext(7, null, $flowId, ['goal' => 'First', 'why' => 'Because'], true, null);
        $merged = json_decode($handler->updateContext(7, null, $flowId, ['goal' => 'Second'], true, null)->getBody(), true);

        self::assertSame('Second', $merged['data']['context']['goal']);
        self::assertSame('Because', $merged['data']['context']['why'], 'merge must preserve keys not being written');

        $replaced = json_decode($handler->updateContext(7, null, $flowId, ['goal' => 'Only'], false, null)->getBody(), true);
        self::assertArrayNotHasKey('why', $replaced['data']['context']);
    }

    public function testStepListOpenRoundTrips(): void
    {
        $flowId  = $this->makeFlowDirect(7, $this->makeProjectDirect(7, null, 'Open', 'OPN'), 'Open flow', 1);
        $handler = new FlowsApiHandler($this->pdo);

        $handler->updateContext(7, null, $flowId, [], true, true);
        self::assertTrue(json_decode($handler->getContext(7, null, $flowId)->getBody(), true)['data']['stepListOpen']);

        $handler->updateContext(7, null, $flowId, [], true, false);
        self::assertFalse(json_decode($handler->getContext(7, null, $flowId)->getBody(), true)['data']['stepListOpen']);
    }
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

Merge in SQL atomically: `context = context || :context::jsonb` for merge, `context = :context::jsonb` for replace — two hardcoded literals selected by a strictly-typed bool, never composed from caller input. This is the pattern `ProjectsApiHandler::updateContext()` already uses; read it and match. Bind `step_list_open` with `PDO::PARAM_BOOL`. A `context` that is not a JSON object → **422**.

**`replace: true` must require a named `flow_id`** — 400 on an absent one, no default fallback. This is the exact defect the D1b review caught on `update_project_context`, where `replace` could wipe an unnamed project.

`build_new_flow` is a **read**: compose the static interview playbook with project grounding and return it. No handler, no writes — model it on `__init_tasker_session`'s route method. `project_id` optional with the `defaultProjectIdFor()` fallback.

- [ ] **Step 4: Run and commit**

```bash
git commit -am "feat: flow context read/write and the build_new_flow playbook"
```

---

## Task 7: `set_task_input` / `remove_task_input` — edges, auto-recompute, cycle rejection

The heart of the slice. Every edge mutation re-stamps `flow_step` **in the same transaction**, and a cycle is refused.

**Files:**
- Create: `plugin/Api/TaskEdgesApiHandler.php`
- Modify: `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Consumes: `FlowStepSorter::sort()`.
- Produces:
  ```php
  public function setInput(int $tenantId, ?int $callerOuId, int $targetTaskId, int $sourceTaskId, ?string $expectedType, ?array $contract, bool $replaceAll): Response
  public function removeInput(int $tenantId, ?int $callerOuId, int $targetTaskId, int $sourceTaskId): Response
  private function recomputeFlowOrder(int $tenantId, int $flowId): void
  ```

- [ ] **Step 1: Write the failing tests**

```php
    public function testSetInputUpsertsTheEdgeAndRestampsFlowOrder(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Wire', 'WIR');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');

        $flows = new FlowsApiHandler($this->pdo);
        $flowId = (int) json_decode($flows->name(7, null, $projectId, 'Wired', [$a, $b], null, false, 2)->getBody(), true)['data']['id'];

        // Independent at creation: order is by task id.
        self::assertSame(1, (int) $this->pdo->query("SELECT flow_step FROM tasker_tasks WHERE id = {$a}")->fetchColumn());

        // Now make B depend on A -- order must be re-stamped WITHOUT calling recompute_flow_steps.
        $edges = new TaskEdgesApiHandler($this->pdo);
        self::assertSame(200, $edges->setInput(7, null, $b, $a, 'markdown', ['rules' => [['label' => 'Non-empty']]], false)->getStatusCode());

        self::assertSame(1, (int) $this->pdo->query("SELECT flow_step FROM tasker_tasks WHERE id = {$a}")->fetchColumn());
        self::assertSame(2, (int) $this->pdo->query("SELECT flow_step FROM tasker_tasks WHERE id = {$b}")->fetchColumn());
    }

    public function testSetInputRefusesAnEdgeThatWouldCloseACycle(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Loopy', 'LOO');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setInput(7, null, $b, $a, null, null, false);

        $refused = $edges->setInput(7, null, $a, $b, null, null, false);
        self::assertSame(422, $refused->getStatusCode());
        self::assertStringContainsString('cycle', strtolower((string) $refused->getBody()));

        self::assertSame(1, (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_edges')->fetchColumn(),
            'a refused edge must not be written');
    }

    public function testSetInputRefusesACrossProjectEdge(): void
    {
        $mine  = $this->makeProjectDirect(7, null, 'Here', 'HER');
        $other = $this->makeProjectDirect(7, null, 'There', 'THE');
        $a = $this->makeTaskDirect(7, $mine,  $this->makeSectionDirect(7, $mine),  'A');
        $b = $this->makeTaskDirect(7, $other, $this->makeSectionDirect(7, $other), 'B');

        $edges = new TaskEdgesApiHandler($this->pdo);

        self::assertSame(422, $edges->setInput(7, null, $b, $a, null, null, false)->getStatusCode());
    }

    public function testReplaceAllDropsTheOtherInboundEdges(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Replace', 'RPL');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');
        $c = $this->makeTaskDirect(7, $projectId, $sectionId, 'C');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setInput(7, null, $c, $a, null, null, false);
        $edges->setInput(7, null, $c, $b, null, null, true);   // replace_all

        $sources = $this->pdo->query("SELECT source_task_id FROM tasker_task_edges WHERE target_task_id = {$c}")->fetchAll(\PDO::FETCH_COLUMN);
        self::assertSame([$b], array_map('intval', $sources));
    }

    public function testSetInputRejects404ForASiblingOusTaskAndSucceedsInItsOwn(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $sibProject = $this->makeProjectDirect(7, 3, 'Sib', 'SB3');
        $sibTask    = $this->makeTaskDirect(7, $sibProject, $this->makeSectionDirect(7, $sibProject), 'Sib');

        $ownProject = $this->makeProjectDirect(7, 2, 'Own', 'OW3');
        $ownSection = $this->makeSectionDirect(7, $ownProject);
        $p = $this->makeTaskDirect(7, $ownProject, $ownSection, 'P');
        $q = $this->makeTaskDirect(7, $ownProject, $ownSection, 'Q');

        $edges = new TaskEdgesApiHandler($this->pdo);

        self::assertSame(404, $edges->setInput(7, 2, $sibTask, $p, null, null, false)->getStatusCode());
        self::assertSame(200, $edges->setInput(7, 2, $q, $p, null, null, false)->getStatusCode());
    }
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

`setInput()` in one transaction: OU-check both tasks via a `taskVisible()` join (404); refuse if their `project_id` differs (422); if `replace_all`, delete the target's other inbound edges; upsert on `(target_task_id, source_task_id)`; load the edges among the flow's members and re-sort; on a cycle, **roll back** and 422 naming the path; else re-stamp `flow_step`.

`recomputeFlowOrder()` is shared by Tasks 7, 8 and 10 — write it once here.

Both tasks might be unflowed (`flow_id IS NULL`), in which case there is no order to stamp. Edges are still legal between unflowed tasks: the original permits I/O edges outside a flow, and `name_flow` reads pre-existing edges. So skip the re-stamp when `flow_id` is null, and **test that path** — it is the case most likely to be missed.

Routes: `POST /api/tasker/tasks/input` → `set_task_input`; `DELETE /api/tasker/tasks/input` → `remove_task_input` (identifiers via `identifierFromRequest()`).

- [ ] **Step 4: Run and commit**

```bash
git add plugin/Api/TaskEdgesApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: I/O edges with in-transaction order re-stamping and cycle rejection"
```

---

## Task 8: `set_task_output` / `clear_task_output` / `confirm_contract`

The producer's own contract, and the blessing flag that writes invalidate.

**Files:**
- Modify: `plugin/Api/TaskEdgesApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Produces: `setOutput(int $tenantId, ?int $callerOuId, int $taskId, array $contract): Response`, `clearOutput(int $tenantId, ?int $callerOuId, int $taskId): Response`, `confirmContract(int $tenantId, ?int $callerOuId, int $taskId): Response`.

- [ ] **Step 1: Write the failing tests**

```php
    public function testConfirmBlessesAndAnyContractWriteUnblessesAgain(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Bless', 'BLS');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $p = $this->makeTaskDirect(7, $projectId, $sectionId, 'Producer');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setOutput(7, null, $p, ['rules' => [['label' => 'Has a summary']]]);

        self::assertFalse($this->blessedFor($p), 'an agent-authored contract starts AI-QA d');

        $edges->confirmContract(7, null, $p);
        self::assertTrue($this->blessedFor($p));

        $edges->setOutput(7, null, $p, ['rules' => [['label' => 'Changed']]]);
        self::assertFalse($this->blessedFor($p), 'rewriting the contract must reset the blessing');
    }

    public function testAConsumerEdgeWriteUnblessesTheProducerToo(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Cascade', 'CAS');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $p = $this->makeTaskDirect(7, $projectId, $sectionId, 'Producer');
        $c = $this->makeTaskDirect(7, $projectId, $sectionId, 'Consumer');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setOutput(7, null, $p, ['rules' => [['label' => 'Derived from consumers']]]);
        $edges->confirmContract(7, null, $p);
        self::assertTrue($this->blessedFor($p));

        $edges->setInput(7, null, $c, $p, null, ['rules' => [['label' => 'Stricter demand']]], false);

        self::assertFalse($this->blessedFor($p),
            'a derived contract is only as valid as the consumer rules it came from');
    }

    public function testANonObjectContractIsRefused(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'BadShape', 'BAD');
        $p = $this->makeTaskDirect(7, $projectId, $this->makeSectionDirect(7, $projectId), 'P');

        $edges = new TaskEdgesApiHandler($this->pdo);

        self::assertSame(422, $edges->setOutput(7, null, $p, [])->getStatusCode());
    }
```

Add a `blessedFor(int $taskId): bool` test helper reading `output_contract_blessed` directly.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement, and verify the cascade against the original first**

**Before implementing the cascade, read the original's `confirm_contract` / `set_task_input` handlers in `c:\Projects\tasker\supabase\functions\mcp\index.ts` and determine whether it cascades the un-blessing to the producer.** The spec chose to cascade on reasoning, not evidence. Report what you find:

- If the original **does** cascade — no divergence, no allowlist entry.
- If it does **not** — implement the cascade anyway (the spec's decision stands) and add a SEMANTIC allowlist entry naming `testAConsumerEdgeWriteUnblessesTheProducerToo` as its `dischargedBy` test.

Bind `output_contract_blessed` with `PDO::PARAM_BOOL`. A contract must be a non-empty JSON object → 422 otherwise.

- [ ] **Step 4: Run and commit**

```bash
git commit -am "feat: producer output contracts and human blessing, invalidated by writes"
```

---

## Task 9: `ContractDeriver` + `derive_output_contract`

Pure logic, so it tests on SQLite. Merges the consumers' input-edge rules into a producer draft, and surfaces where the merge was lossy.

**Files:**
- Create: `plugin/Domain/ContractDeriver.php`, `plugin/tests/Domain/ContractDeriverTest.php`
- Modify: `plugin/Api/TaskEdgesApiHandler.php`, `plugin/TaskerPlugin.php`

**Interfaces:**
- Produces:
  ```php
  /** @param list<array{source_label:string,contract:?array}> $consumerEdges
   *  @return array{rules:list<array>,assumptions:list<string>} */
  public static function derive(array $consumerEdges): array
  ```

- [ ] **Step 1: Write the failing tests**

```php
    public function testASingleConsumerYieldsItsRulesWithNoAssumptions(): void
    {
        $r = ContractDeriver::derive([
            ['source_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary', 'kind' => 'check']]]],
        ]);

        self::assertCount(1, $r['rules']);
        self::assertSame([], $r['assumptions']);
    }

    public function testTwoConsumersMergeAndTheMergeIsDeclaredAnAssumption(): void
    {
        $r = ContractDeriver::derive([
            ['source_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary', 'kind' => 'check']]]],
            ['source_label' => 'TDE-3', 'contract' => ['rules' => [['label' => 'Cites a source', 'kind' => 'judgment']]]],
        ]);

        self::assertCount(2, $r['rules']);
        self::assertNotEmpty($r['assumptions'], 'a multi-consumer merge is exactly what a human must review');
    }

    public function testIdenticalRulesFromTwoConsumersDeduplicate(): void
    {
        $rule = ['label' => 'Has a summary', 'kind' => 'check'];
        $r = ContractDeriver::derive([
            ['source_label' => 'TDE-2', 'contract' => ['rules' => [$rule]]],
            ['source_label' => 'TDE-3', 'contract' => ['rules' => [$rule]]],
        ]);

        self::assertCount(1, $r['rules']);
    }

    public function testAConsumerWithNoContractIsReportedAsMissingCriteria(): void
    {
        $r = ContractDeriver::derive([
            ['source_label' => 'TDE-2', 'contract' => null],
        ]);

        self::assertSame([], $r['rules']);
        self::assertNotEmpty($r['assumptions']);
        self::assertStringContainsString('TDE-2', implode(' ', $r['assumptions']),
            'the human needs to know WHICH consumer declared nothing');
    }

    public function testNoConsumersAtAllIsReportedRatherThanReturningAnEmptyDraft(): void
    {
        $r = ContractDeriver::derive([]);

        self::assertSame([], $r['rules']);
        self::assertNotEmpty($r['assumptions']);
    }
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement, then wire the route**

`derive()` collects every consumer's rules, deduplicates identical ones, and appends an assumption for each of: more than one contributing consumer, a consumer with no contract (naming it), and no consumers at all.

The route loads the producer's inbound-consumer edges — i.e. edges where the producer is the **source** — labels each by the consumer's short id, calls `derive()`, and returns `{rules, assumptions}`. With `apply: true`, persist `rules` as the producer's `output_contract` and set `output_contract_blessed = false`.

- [ ] **Step 4: Run and commit**

```bash
git add plugin/Domain/ContractDeriver.php plugin/tests/Domain/ContractDeriverTest.php plugin/Api plugin/TaskerPlugin.php
git commit -m "feat: derive a producer contract from its consumers demands, with assumptions surfaced"
```

---

## Task 10: `get_task_connections`, `get_flow_order`, `recompute_flow_steps`

The three reads, plus the repair hatch that is no longer load-bearing.

**Files:**
- Modify: `plugin/Api/TaskEdgesApiHandler.php`, `plugin/Api/FlowsApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Produces: `TaskEdgesApiHandler::connections(int $tenantId, ?int $callerOuId, int $taskId): Response`, `FlowsApiHandler::order(int $tenantId, ?int $callerOuId, int $flowId): Response`, `FlowsApiHandler::recompute(int $tenantId, ?int $callerOuId, int $flowId): Response`.

- [ ] **Step 1: Write the failing tests**

```php
    public function testConnectionsReportsBlockersAndDependentsSeparately(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Conn', 'CON');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $up   = $this->makeTaskDirect(7, $projectId, $sectionId, 'Upstream');
        $mid  = $this->makeTaskDirect(7, $projectId, $sectionId, 'Middle');
        $down = $this->makeTaskDirect(7, $projectId, $sectionId, 'Downstream');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setInput(7, null, $mid,  $up,  null, null, false);
        $edges->setInput(7, null, $down, $mid, null, null, false);

        $payload = json_decode($edges->connections(7, null, $mid)->getBody(), true);

        self::assertSame([$up],   array_column($payload['data']['blockers'],  'id'));
        self::assertSame([$down], array_column($payload['data']['dependents'], 'id'));
    }

    public function testRecomputeIsANoOpWhenOrderIsAlreadyCorrect(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Idem', 'IDM');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $a = $this->makeTaskDirect(7, $projectId, $sectionId, 'A');
        $b = $this->makeTaskDirect(7, $projectId, $sectionId, 'B');

        $edges = new TaskEdgesApiHandler($this->pdo);
        $edges->setInput(7, null, $b, $a, null, null, false);

        $flows  = new FlowsApiHandler($this->pdo);
        $flowId = (int) json_decode($flows->name(7, null, $projectId, 'Already ordered', [$a, $b], null, false, 2)->getBody(), true)['data']['id'];

        $before = $this->pdo->query("SELECT id, flow_step FROM tasker_tasks WHERE flow_id = {$flowId} ORDER BY id")->fetchAll(\PDO::FETCH_ASSOC);
        self::assertSame(200, $flows->recompute(7, null, $flowId)->getStatusCode());
        $after = $this->pdo->query("SELECT id, flow_step FROM tasker_tasks WHERE flow_id = {$flowId} ORDER BY id")->fetchAll(\PDO::FETCH_ASSOC);

        self::assertSame($before, $after, 'auto-recompute means the manual hatch has nothing left to fix');
    }
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

`connections()` is **two indexed queries** — `WHERE target_task_id = :id` for blockers, `WHERE source_task_id = :id` for dependents. This is the payoff for normalising: the original scans every task's JSON. Both queries join to `tasker_projects` for the OU predicate and bind tenant on both sides.

`order()` returns the flow's members ordered by `flow_step`, then `id`. `recompute()` re-runs the sort and re-stamps; because Task 7 keeps order current, it should find nothing to change.

Routes: all three `GET`, parameters via `queryParam()`, `400` declared for a malformed short id — the nine-read-route lesson from D1b.

- [ ] **Step 4: Run and commit**

```bash
git commit -am "feat: task connections, flow order, and the recompute repair hatch"
```

---

## Task 11: The board-exclusion retrofit (TDE-320)

Flow steps leave the board. This touches **six already-shipped tools** and every tally, and the contract-parity test structurally cannot catch it, because no shape changes. Four of the D1b whole-branch review's blockers were exactly this class.

**Files:**
- Modify: `plugin/Api/TasksApiHandler.php`, `plugin/Api/ProjectsApiHandler.php`, `plugin/Api/BoardApiHandler.php`, `plugin/Api/AttentionApiHandler.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

- [ ] **Step 1: Write the failing tests — one per affected tool**

```php
    public function testFlowStepsLeaveEveryBoardSurfaceAndEveryTally(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Exclusion', 'EXC');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $plain = $this->makeTaskDirect(7, $projectId, $sectionId, 'Plain task');
        $step  = $this->makeTaskDirect(7, $projectId, $sectionId, 'Will become a step');

        // Baseline: both visible everywhere.
        self::assertCount(2, json_decode((new TasksApiHandler($this->pdo))->listFiltered(7, $projectId, null, null, 'all')->getBody(), true)['data']);

        (new FlowsApiHandler($this->pdo))->name(7, null, $projectId, 'Swallows a task', [$step], null, false, 2);

        $tasks = json_decode((new TasksApiHandler($this->pdo))->listFiltered(7, $projectId, null, null, 'all')->getBody(), true)['data'];
        self::assertSame([$plain], array_map(static fn($t) => (int) $t['id'], $tasks), 'list_tasks must exclude flow steps');

        $board = json_decode((new BoardApiHandler($this->pdo))->get(7, null, $projectId)->getBody(), true);
        self::assertSame(1, $this->countTasksIn($board), 'get_board must exclude flow steps from its tally too');

        $project = json_decode((new ProjectsApiHandler($this->pdo))->getOne(7, null, $projectId, false)->getBody(), true);
        self::assertCount(1, $project['data']['sections'][0]['tasks'], 'get_project must exclude flow steps');
    }

    public function testFlowStepsLeaveTheWorkQueuesToo(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Queues', 'QUE');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $step = $this->makeTaskDirect(7, $projectId, $sectionId, 'Stepified');
        $this->pdo->exec("UPDATE tasker_tasks SET priority = 'high' WHERE id = {$step}");

        (new FlowsApiHandler($this->pdo))->name(7, null, $projectId, 'Queue eater', [$step], null, false, 2);

        $ranked = json_decode((new AttentionApiHandler($this->pdo))->rank(7, null, $projectId, false, 2)->getBody(), true)['data'];
        self::assertSame([], array_map(static fn($t) => (int) $t['id'], $ranked), 'rank_tasks must exclude flow steps');

        $ready = json_decode((new TasksApiHandler($this->pdo))->readyWork(7, $projectId)->getBody(), true)['data'];
        self::assertSame([], array_map(static fn($t) => (int) $t['id'], $ready), 'get_ready_work must exclude flow steps');
    }
```

Add a `countTasksIn(array $board): int` helper. **Check each handler's real method signature before writing these calls** — three D1b briefs shipped with stale arity because they were written from memory rather than from the file.

- [ ] **Step 2: Run and confirm they fail** — every one, because nothing filters yet.

- [ ] **Step 3: Add `flow_id IS NULL` to each read**

Add the predicate to: `TasksApiHandler::listFiltered()` and `readyWork()`; `ProjectsApiHandler::getOne()`'s task fetch; `BoardApiHandler::get()`'s task fetch and any count; `AttentionApiHandler::rank()` and both bucket queries (`fetchOverdue`, `fetchStale`).

It is a literal predicate in each static template — no runtime branching, nothing caller-derived. Add a one-line comment at each site naming TDE-320, so the next reader knows it is a deliberate contract behaviour and not a stray filter.

- [ ] **Step 4: Run the full suite**

Expect some **pre-existing** tests to need updating if any fixture happens to set `flow_id`. None should today, since the column is new — if a test breaks, understand why before changing it.

- [ ] **Step 5: Commit**

```bash
git add plugin/Api plugin/tests
git commit -m "fix: flow steps leave the board, every listing and every tally (TDE-320)"
```

---

## Task 12: Parity — allowlist entries and the contract test

**Files:**
- Modify: `plugin/tests/Contract/parity-allowlist.php`
- Test: `plugin/tests/Contract/OriginalContractParityTest.php` (run, not modified)

- [ ] **Step 1: Run the parity test and read the failures**

```powershell
docker run --rm -v "${PWD}:/repo" -w /repo/plugin tasker-plugin-phpunit:8.4 php vendor/bin/phpunit --filter OriginalContractParityTest
```

The snapshot at `plugin/tests/Contract/original-tool-schemas.json` holds all 143 of the original's tools with real schemas, so the 15 new tools now enter comparison range. **Treat each failure as information**: either our shape is wrong — fix the route — or the divergence is deliberate — allowlist it with a reason.

**Do not blanket-allowlist to reach green.** That reproduces the exact failure this test exists to prevent.

- [ ] **Step 2: Add the SEMANTIC entries**

For each, `severity => 'semantic'` plus a `dischargedBy` naming a behavioural test that **exists and contains an assertion** — the guard checks for one:

| Divergence | `dischargedBy` |
|---|---|
| `flow_step` auto-recomputed, so `recompute_flow_steps` is no longer required for correctness | `testSetInputUpsertsTheEdgeAndRestampsFlowOrder` |
| Cycles rejected with 422 where the original permits creating one | `testSetInputRefusesAnEdgeThatWouldCloseACycle` |
| Blessing reset cascades to the producer — **only if Task 8 found the original does not cascade** | `testAConsumerEdgeWriteUnblessesTheProducerToo` |

The edge normalisation needs **no** entry: tool shapes are unchanged, so it is invisible to the comparison. Record that reasoning in the file so nobody adds a redundant entry the staleness guard would then reject.

- [ ] **Step 3: Re-run until green, then commit**

```bash
git add plugin/tests/Contract/parity-allowlist.php
git commit -m "test: allowlist D5a's three deliberate divergences with named behavioural tests"
```

---

## Task 13: Snapshot, allowlist, drift proof, acceptance

**Files:**
- Modify: `host/scripts/mcp-tools.ps1`, `docs/mcp-tool-surface.json`, `README.md`

- [ ] **Step 1: Grow the tool allowlist 49 → 64**

`host/scripts/mcp-tools.ps1` derives its filter from `TaskerPlugin.php`'s `operationId`s at runtime, so it should pick the 15 up automatically. **Verify** rather than assume: compare the derived set against the route table and report both counts.

- [ ] **Step 2: Regenerate the surface snapshot**

```powershell
npm run plugin:install
docker restart tasker_frankenphp
npm run mcp:tools
powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1 -Write
git diff docs/mcp-tool-surface.json
```

The containers run a **copied** snapshot of `plugin/` (robocopy, not a bind mount), so `plugin:install` plus the restart is mandatory — skipping it silently captures stale surface data.

**Review the diff:** 15 tools added, no existing tool losing a property or gaining a `required` it should not have. Keep the file BOM-free, and note that `mcp-check.ps1` reads it with an explicit `-Encoding UTF8` for a reason — PowerShell 5.1 falls back to the system codepage without a BOM and mangles non-ASCII text.

- [ ] **Step 3: Re-prove the drift check bites**

Rename one new `operationId` (e.g. `name_flow` → `title_flow`), reinstall, regenerate, and run `npm run mcp:check`. Expect **FAIL** naming the drift. Revert, reinstall, regenerate, confirm it passes. Capture both outputs.

- [ ] **Step 4: Full acceptance, with observed values**

```powershell
npm run plugin:test
npm run plugin:stan
npm run mcp:check
```

Record exact test/assertion counts and the **skipped count — it must be 0**. PHPStan must be clean through the repo's own unmodified script.

Then walk it live over `/mcp`: create two tasks, `set_task_input` to connect them, `name_flow` to make them a flow, `get_flow_order` to read the order back, confirm `list_tasks {}` no longer shows them, `delete_flow`, and confirm they reappear with their edge intact.

- [ ] **Step 5: Update the README and commit**

```bash
git add host/scripts/mcp-tools.ps1 docs/mcp-tool-surface.json README.md
git commit -m "test: regenerate the MCP surface for D5a's flow and contract tools"
```

---

## Plan acceptance

Mirrors the spec's Definition of Done.

1. **15 new tools derive and are invocable with real arguments**; tool count 49 → **64**, three-way agreement across `getRoutes()`, `mcp-tools.ps1` and the snapshot.
2. **The contract-parity test passes**, every divergence allowlisted with a reason, each SEMANTIC entry naming a behavioural test that exists and asserts.
3. **All six retrofitted tools provably exclude flow steps**, with tests, and their tallies drop accordingly.
4. **No edge can cross a tenant or OU boundary**, proven on real PostgreSQL — including the new `F`-prefixed flow form, with a same-OU positive control beside every 404.
5. **A cycle cannot be created**, and `flow_step` is never stale after any edge mutation.
6. **Deleting a producer cascades its edges away**; deleting a flow returns its tasks to the board with their edges intact and destroys no tasks.
7. **Full suite green with 0 skipped**; PHPStan clean at level 6 via `npm run plugin:stan` with no manual flags; `mcp:check` passing and re-proven to catch a rename.

**Not delivered by this plan:** nothing runs. No `run_flow`, `resume_flow`, `stop_flow`, `guide_flow` or `advance_guide`; no gate enforcement, validation, artifacts or audit trail; no flow templates; no flow-scoped IS/KB (D6 owns the storage). Those are D5b and D6.
