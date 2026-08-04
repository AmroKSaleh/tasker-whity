# D1 — Board Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tasker's real board backend on whity-core — projects, sections, groups, tasks, milestones, and per-task AI-discussion storage — tenant-isolated, OU-scoped, with MCP tools deriving automatically from the same routes.

**Architecture:** Nine tasks in a strict dependency chain. The first proves `entity_tags` and `audit_log` against Plan A's existing `tasker_pings` entity — no real board table exists yet, so getting the integration pattern wrong costs nothing. The second builds the OU descendant scope resolver as a standalone, directly-testable class. Every subsequent table task consumes both: tags via `entity_tags`, mutations via `audit_log`, visibility via the resolver.

**Tech Stack:** whity-core (pinned SHA), PHP 8.4, PostgreSQL 15, PHPUnit 10, PHPStan 1.10.

## Global Constraints

- Every table carries `tenant_id INTEGER NOT NULL`, bound explicitly in every query. No implicit tenant filtering.
- Dual-key pattern on every new table: `id BIGSERIAL PRIMARY KEY` internal, `public_id UUID NOT NULL UNIQUE` external.
- Permission slugs take exactly one colon: `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/`.
- Routes are **declared** without `/v1` (e.g. `/api/tasker/projects`) and are **served** at `/api/v1/tasker/projects` — the host router injects `/v1`. Every mutating request needs `X-Requested-With: XMLHttpRequest` from the caller, verified at the HTTP layer already established in prior plans — plugin route handlers do not need to check for it themselves.
- Every route declares an explicit `schema.operationId` — it becomes the derived MCP tool name.
- `host/.core/` is gitignored, pinned, and **never patched**.
- A resource outside the caller's tenant or OU scope reports **404**, never 403 — this must never confirm existence to an unauthorized caller.
- `AuditLogger` (`Whity\Core\Audit\AuditLogger`) is **not** container-registered. The real host constructs it directly in `public/index.php` via `new AuditLogger($db->getPdo(), $logger)`. Plugin code must do the same — `new \Whity\Core\Audit\AuditLogger($pdo)` — never `\Whity\app(AuditLogger::class)`, which is not registered and will throw.
- `Whity\Sdk\Http\Response::error(string $message, int $statusCode = 500, array $details = [])` and `Response::json(mixed $data, int $statusCode = 200)` are the only response factories available to plugin code — this is the SDK's `Response`, not core's internal one.
- **No database-side value generation.** `NOW()` and `gen_random_uuid()` are PostgreSQL-only; the SQLite double used by every handler's own unit tests has neither. Every timestamp is written as `CURRENT_TIMESTAMP` (a portable SQL keyword both engines accept, unlike `NOW()`), and every `public_id` is generated in PHP (a small private `generateUuidV4()` helper, duplicated per handler the same way `slugify()` already is) and bound as an explicit parameter — never a column `DEFAULT`. No migration declares a `DEFAULT` for `public_id`.
- **The OU boundary is enforced at discovery, not on every nested route.** Only `tasker_projects` carries an `ou_id` column (§4/§7 of the design spec). `list_projects`, `get_board`, and `get_ready_work` apply `OuScopeResolver` directly. Every section/group/task/milestone route below that (list, create, update, delete, move, complete, tag, pin, discussion) is **tenant-scoped only** — a caller can only ever learn a section/group/task id by first reaching it through an OU-visible project, so the OU check at that one entry point is what actually gates access. This matches the design spec's own OU testing scope (§9), which tests the four visibility cases only at the project level. A caller already holding `tasker_task:edit` who somehow already knows another OU's task id could still mutate it — closing that fully would mean joining every one of those routes through `tasker_projects.ou_id`, which is out of this plan's scope; flag it as a fast-follow only if this deployment ever needs OU boundaries to be airtight rather than list-level.

**Prerequisites:** Plan A and P1 complete (repo at commit `1242838` or later on `trunk`). Docker Desktop running. `npm run setup` has been run.

---

### Task 1: Entity-tags and audit-log proof against `tasker_pings`

**Files:**
- Modify: `plugin/Api/PingApiHandler.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/Api/PingApiHandlerTest.php`
- Modify: `plugin/tests/TenantIsolationTest.php` (only if the SDK's scanner needs a new directory declared — check first, per the note below)

**Interfaces:**
- Consumes: `PingApiHandler` from Plan A (`list(int $tenantId)`, `create(int $tenantId, string $body)`).
- Produces: `PingApiHandler::tag(int $tenantId, int $pingId, string $body): Response` — attaches an existing tag to a ping via `entity_type: 'tasker_ping'`. `PingApiHandler::create()` now also writes an `audit_log` row via a new private `AuditLogger` instance. Establishes the conventions every later table's tasks reuse: entity type names are `tasker_<entity>` (singular), audit action keys are `tasker_<entity>.<verb>` dot-separated.

- [ ] **Step 1: Write the failing test for audit logging on create**

Add to `plugin/tests/Api/PingApiHandlerTest.php`:

```php
public function testCreateWritesAnAuditLogEntry(): void
{
    $this->pdo->exec('
        CREATE TABLE audit_log (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL,
            actor_user_id INTEGER NULL,
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(100) NULL,
            target_id INTEGER NULL,
            metadata TEXT NOT NULL DEFAULT \'{}\',
            ip_address VARCHAR(45) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        )
    ');

    $this->handler->create(7, json_encode(['label' => 'audited']));

    $row = $this->pdo->query('SELECT tenant_id, action, target_type, target_id FROM audit_log')->fetch(PDO::FETCH_ASSOC);

    self::assertSame(7, (int) $row['tenant_id']);
    self::assertSame('tasker_ping.created', $row['action']);
    self::assertSame('tasker_ping', $row['target_type']);
    self::assertGreaterThan(0, (int) $row['target_id']);
}
```

Note: this test's `CREATE TABLE audit_log` uses `metadata TEXT` rather than the real host's `JSONB`, because the in-memory SQLite test double has no JSONB type — SQLite stores it as text and `AuditLogger::record()` only ever `json_encode`s into it, never queries it back structurally, so this substitution is safe for this test's purpose.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `no such table: audit_log` becomes `no such table: audit_log` initially (table now exists per Step 1's setup) but then a genuine assertion failure: `create()` never wrote a row, so the `SELECT` returns nothing and `fetch()` returns `false`, causing a PHP error when the test tries to read `$row['tenant_id']`.

- [ ] **Step 3: Implement the audit-log write**

Modify `plugin/Api/PingApiHandler.php`. Add the import and construct `AuditLogger` directly from the same PDO the handler already holds — never via `\Whity\app()`, since `AuditLogger` is not container-registered:

```php
use Whity\Core\Audit\AuditLogger;
```

Change `create()` to log after a successful insert, before returning:

```php
    public function create(int $tenantId, string $body): Response
    {
        $label = $this->validatedLabel($body);
        if ($label === null) {
            return Response::error(
                'label must be a non-empty string of at most ' . self::MAX_LABEL_LENGTH . ' characters',
                400
            );
        }

        try {
            $stmt = $this->db->prepare(
                'INSERT INTO tasker_pings (tenant_id, label, created_at) VALUES (:tenant_id, :label, CURRENT_TIMESTAMP)'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':label' => $label]);

            $id = (int) $this->db->lastInsertId();

            $find = $this->db->prepare(
                'SELECT id, tenant_id, label, created_at FROM tasker_pings
                 WHERE id = :id AND tenant_id = :tenant_id'
            );
            $find->execute([':id' => $id, ':tenant_id' => $tenantId]);
            $row = $find->fetch(PDO::FETCH_ASSOC);

            if (!is_array($row)) {
                return Response::error('Failed to create ping', 500);
            }

            // Establishes the convention every later table's create() reuses:
            // action keys are tasker_<entity>.<verb>, target_type is tasker_<entity>.
            (new AuditLogger($this->db))->record('tasker_ping.created', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_ping',
                'target_id' => $id,
            ]);

            return Response::json(['data' => $this->toPublicPing($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create ping', 500);
        }
    }
```

`AuditLogger::record()` is documented as fail-soft — a write failure is logged and swallowed internally, so it can never break this handler's own response. No try/catch is needed around the `record()` call itself.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npm run plugin:test
```

Expected: PASS. The pre-existing `PingApiHandlerTest` cases must still pass unchanged.

- [ ] **Step 5: Write the failing test for entity-tag attachment**

Add to `plugin/tests/Api/PingApiHandlerTest.php`:

```php
public function testTagAttachesAnExistingTagToAPing(): void
{
    $this->pdo->exec('
        CREATE TABLE entity_tags (
            tenant_id INTEGER NOT NULL,
            entity_type VARCHAR(128) NOT NULL,
            entity_id BIGINT NOT NULL,
            tag_id BIGINT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (entity_type, entity_id, tag_id)
        )
    ');

    $created = json_decode($this->handler->create(7, json_encode(['label' => 'taggable']))->getBody(), true);
    $pingId = $created['data']['id'];

    $response = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

    self::assertSame(201, $response->getStatusCode());

    $row = $this->pdo->query('SELECT tenant_id, entity_type, entity_id, tag_id FROM entity_tags')->fetch(PDO::FETCH_ASSOC);
    self::assertSame(7, (int) $row['tenant_id']);
    self::assertSame('tasker_ping', $row['entity_type']);
    self::assertSame($pingId, (int) $row['entity_id']);
    self::assertSame(42, (int) $row['tag_id']);
}

public function testTagIsIdempotentOnAlreadyAttachedTag(): void
{
    $this->pdo->exec('
        CREATE TABLE entity_tags (
            tenant_id INTEGER NOT NULL,
            entity_type VARCHAR(128) NOT NULL,
            entity_id BIGINT NOT NULL,
            tag_id BIGINT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (entity_type, entity_id, tag_id)
        )
    ');

    $created = json_decode($this->handler->create(7, json_encode(['label' => 'taggable']))->getBody(), true);
    $pingId = $created['data']['id'];

    $first = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));
    $second = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

    self::assertSame(201, $first->getStatusCode());
    self::assertSame(200, $second->getStatusCode());

    $count = (int) $this->pdo->query('SELECT COUNT(*) FROM entity_tags')->fetchColumn();
    self::assertSame(1, $count);
}

public function testTagRejectsAPingOutsideTheCallersTenant(): void
{
    $this->pdo->exec('
        CREATE TABLE entity_tags (
            tenant_id INTEGER NOT NULL,
            entity_type VARCHAR(128) NOT NULL,
            entity_id BIGINT NOT NULL,
            tag_id BIGINT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (entity_type, entity_id, tag_id)
        )
    ');

    $created = json_decode($this->handler->create(9, json_encode(['label' => 'belongs to tenant 9']))->getBody(), true);
    $pingId = $created['data']['id'];

    $response = $this->handler->tag(7, $pingId, json_encode(['tag_id' => 42]));

    self::assertSame(404, $response->getStatusCode());
}
```

- [ ] **Step 6: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Call to undefined method Tasker\Api\PingApiHandler::tag()`.

- [ ] **Step 7: Implement `tag()`**

Add to `plugin/Api/PingApiHandler.php`, after `create()`:

```php
    /**
     * POST /api/tasker/pings/{id}/tags — attach an existing tag to a ping.
     *
     * The tag itself must already exist (created via core's own /api/tags,
     * gated on tags:manage) — this plugin never creates tags, only attaches
     * them. A ping outside the caller's tenant reports 404, never a
     * cross-tenant existence leak.
     */
    public function tag(int $tenantId, int $pingId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $tagId = is_array($decoded) && isset($decoded['tag_id']) ? (int) $decoded['tag_id'] : 0;
        if ($tagId <= 0) {
            return Response::error('tag_id is required and must be a positive integer', 400);
        }

        $find = $this->db->prepare('SELECT id FROM tasker_pings WHERE id = :id AND tenant_id = :tenant_id');
        $find->execute([':id' => $pingId, ':tenant_id' => $tenantId]);
        if ($find->fetch() === false) {
            return Response::error('Ping not found', 404);
        }

        try {
            $insert = $this->db->prepare(
                'INSERT INTO entity_tags (tenant_id, entity_type, entity_id, tag_id, created_at)
                 VALUES (:tenant_id, :entity_type, :entity_id, :tag_id, CURRENT_TIMESTAMP)
                 ON CONFLICT (entity_type, entity_id, tag_id) DO NOTHING'
            );
            $insert->execute([
                ':tenant_id' => $tenantId,
                ':entity_type' => 'tasker_ping',
                ':entity_id' => $pingId,
                ':tag_id' => $tagId,
            ]);

            $created = $insert->rowCount() > 0;

            return Response::json([
                'data' => ['entity_type' => 'tasker_ping', 'entity_id' => $pingId, 'tag_id' => $tagId],
            ], $created ? 201 : 200);
        } catch (\Throwable) {
            return Response::error('Failed to attach tag', 500);
        }
    }
```

Note: SQLite's `ON CONFLICT ... DO NOTHING` syntax is identical to PostgreSQL's, so this statement runs unmodified on both engines — matching the portability discipline every migration in this plugin already follows.

- [ ] **Step 8: Run to verify it passes**

Run:

```powershell
npm run plugin:test
```

Expected: PASS, all three new tests plus the pre-existing suite.

- [ ] **Step 9: Wire the route into `TaskerPlugin.php`**

Add to `getRoutes()` in `plugin/TaskerPlugin.php`, alongside the existing ping routes:

```php
            [
                'method' => 'POST',
                'path' => '/api/tasker/pings/{id:\d+}/tags',
                'handler' => [$this, 'tagPing'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_ping:manage',
                'schema' => [
                    'operationId' => 'tag_ping',
                    'summary' => 'Attach an existing tag to a ping',
                    'tags' => ['tasker'],
                    'request' => 'TaskerTagAttachRequest',
                    'responses' => [
                        201 => 'TaskerEntityTagResponse',
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        403 => ['description' => 'Missing tasker_ping:manage or unresolved tenant context'],
                        404 => ['description' => 'Ping not found in the caller\'s tenant'],
                    ],
                    'components' => [
                        'TaskerTagAttachRequest' => [
                            'type' => 'object',
                            'required' => ['tag_id'],
                            'properties' => ['tag_id' => ['type' => 'integer', 'minimum' => 1]],
                        ],
                        'TaskerEntityTagResponse' => [
                            'type' => 'object',
                            'required' => ['data'],
                            'properties' => [
                                'data' => [
                                    'type' => 'object',
                                    'required' => ['entity_type', 'entity_id', 'tag_id'],
                                    'properties' => [
                                        'entity_type' => ['type' => 'string'],
                                        'entity_id' => ['type' => 'integer'],
                                        'tag_id' => ['type' => 'integer'],
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
```

Add the route method near `createPing`:

```php
    /**
     * POST /api/tasker/pings/{id}/tags
     *
     * @param array<string, string> $params
     */
    public function tagPing(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pingId = (int) ($params['id'] ?? 0);

        return (new PingApiHandler($this->resolvePdo()))->tag($tenantId, $pingId, $request->getBody());
    }
```

- [ ] **Step 10: Run PHPStan**

Run:

```powershell
npm run plugin:stan
```

Expected: clean at level 6.

- [ ] **Step 11: Verify against the running host**

```powershell
npm run host:up
npm run plugin:install
```

```powershell
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"email":"admin@example.com","password":"admin123"}' -WebSession $s | Out-Null

# Create a tag group and a tag to attach (core's own tags feature — the plugin never creates tags).
$group = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tag-groups -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"Tasker"}' -WebSession $s
$tag = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tags -Method Post -ContentType 'application/json' -Headers $csrf -Body (@{group_id=$group.data.id; name='example'} | ConvertTo-Json) -WebSession $s

$ping = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/pings -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"label":"tag me"}' -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/pings/$($ping.data.id)/tags" -Method Post -ContentType 'application/json' -Headers $csrf -Body (@{tag_id=$tag.data.id} | ConvertTo-Json) -WebSession $s

docker exec tasker_postgres psql -U tasker -d tasker -c "SELECT action, target_type, target_id FROM audit_log ORDER BY id DESC LIMIT 3;"
docker exec tasker_postgres psql -U tasker -d tasker -c "SELECT entity_type, entity_id, tag_id FROM entity_tags;"
```

Expected: the `audit_log` query shows a `tasker_ping.created` row; the `entity_tags` query shows the attachment. If `admin@example.com` was password-rotated during earlier manual work in this environment, use the current value from `host/.env`'s `INITIAL_ADMIN_PASSWORD` instead of `admin123`.

- [ ] **Step 12: Commit**

```bash
git add plugin/Api/PingApiHandler.php plugin/TaskerPlugin.php plugin/tests/Api/PingApiHandlerTest.php
git commit -m "feat: prove entity_tags and audit_log against tasker_pings"
```

---

### Task 2: The OU descendant scope resolver

**Files:**
- Create: `plugin/Access/OuScopeResolver.php`
- Test: `plugin/tests/Access/OuScopeResolverTest.php`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is a standalone class over the host's own `organizational_units` table.
- Produces: `OuScopeResolver::descendantIds(PDO $pdo, int $tenantId, int $ouId, int $maxDepth = 50): array` — returns the array of OU ids in `$ouId`'s subtree, inclusive of `$ouId` itself, bounded by depth. `OuScopeResolver::scopeParams(PDO $pdo, int $tenantId, ?int $callerOuId): array{unrestricted: bool, scope: int[]}` — the higher-level entry point every later table's query binds directly.

- [ ] **Step 1: Write the failing tests**

Create `plugin/tests/Access/OuScopeResolverTest.php`. This tests against a real `organizational_units` table shape (SQLite is sufficient — the traversal is pure recursive SQL, no Postgres-specific features), built fresh per test:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Access;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Access\OuScopeResolver;

final class OuScopeResolverTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('
            CREATE TABLE organizational_units (
                id INTEGER PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                parent_id INTEGER NULL REFERENCES organizational_units(id)
            )
        ');
    }

    private function makeOu(int $id, int $tenantId, ?int $parentId): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO organizational_units (id, tenant_id, parent_id) VALUES (?, ?, ?)'
        );
        $stmt->execute([$id, $tenantId, $parentId]);
    }

    public function testDescendantIdsIncludesSelfAndChildren(): void
    {
        // 1 (root) -> 2 (child) -> 3 (grandchild); 4 is a sibling of 2, not a descendant.
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 2);
        $this->makeOu(4, 7, 1);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1);

        sort($ids);
        self::assertSame([1, 2, 3, 4], $ids);
    }

    public function testDescendantIdsExcludesAncestorsAndSiblings(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 2);
        $this->makeOu(4, 7, 1);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 2);

        sort($ids);
        self::assertSame([2, 3], $ids, 'OU 2\'s subtree must not include its parent (1) or its sibling (4)');
    }

    public function testDescendantIdsIsScopedToTenant(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        // A different tenant's OU, same id-space shape, must never leak in.
        $this->makeOu(10, 9, null);
        $this->makeOu(11, 9, 10);

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1);

        sort($ids);
        self::assertSame([1, 2], $ids);
    }

    public function testDescendantIdsIsBoundedAgainstACycle(): void
    {
        // whity's own schema permits a node to be its own parent, or a cycle
        // through several nodes. The traversal must terminate, not hang.
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->pdo->exec('UPDATE organizational_units SET parent_id = 2 WHERE id = 1'); // 1 -> 2 -> 1

        $ids = OuScopeResolver::descendantIds($this->pdo, 7, 1, maxDepth: 5);

        // The exact membership is secondary; termination is the point. Both
        // nodes are reachable from 1 within 5 hops around the cycle.
        sort($ids);
        self::assertSame([1, 2], $ids);
    }

    public function testScopeParamsForANullCallerOuIsUnrestricted(): void
    {
        $params = OuScopeResolver::scopeParams($this->pdo, 7, null);

        self::assertTrue($params['unrestricted']);
    }

    public function testScopeParamsForARealCallerOuIsNotUnrestricted(): void
    {
        $this->makeOu(1, 7, null);

        $params = OuScopeResolver::scopeParams($this->pdo, 7, 1);

        self::assertFalse($params['unrestricted']);
        self::assertSame([1], $params['scope']);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Access\OuScopeResolver" not found`.

- [ ] **Step 3: Implement**

Create `plugin/Access/OuScopeResolver.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Access;

use PDO;

/**
 * Computes OU-descendant visibility scope for Tasker's resources.
 *
 * A user in OU X sees resources whose ou_id is X or any descendant of X, plus
 * every resource with ou_id IS NULL (tenant-root, visible to all). This is the
 * DESCENDANT direction — the opposite of whity-core's own RoleChecker, which
 * walks UP the parent chain for permission inheritance. There is no existing
 * host function for this traversal; it is Tasker's own.
 *
 * A null caller OU means tenant-root: unrestricted visibility across every OU
 * in the tenant. This matches whity-core's own seeded bootstrap accounts,
 * which are given ou_id = NULL explicitly — the alternative (null OU sees only
 * ou_id IS NULL resources) would leave the platform's own admin unable to see
 * anything once real OUs exist.
 *
 * organizational_units.parent_id can be made to cycle (including a node being
 * its own parent) per the host's own schema comments, which document this as
 * the API layer's responsibility to guard. Every traversal here is bounded by
 * $maxDepth.
 */
final class OuScopeResolver
{
    private const DEFAULT_MAX_DEPTH = 50;

    /**
     * The set of OU ids in $ouId's subtree, inclusive of $ouId itself.
     *
     * @return list<int>
     */
    public static function descendantIds(PDO $pdo, int $tenantId, int $ouId, int $maxDepth = self::DEFAULT_MAX_DEPTH): array
    {
        $stmt = $pdo->prepare(
            'WITH RECURSIVE subtree(id, depth) AS (
                SELECT id, 0 FROM organizational_units WHERE id = :ou_id AND tenant_id = :tenant_id
                UNION ALL
                SELECT ou.id, s.depth + 1
                FROM organizational_units ou
                JOIN subtree s ON ou.parent_id = s.id
                WHERE ou.tenant_id = :tenant_id AND s.depth < :max_depth
            )
            SELECT id FROM subtree'
        );
        $stmt->execute([
            ':ou_id' => $ouId,
            ':tenant_id' => $tenantId,
            ':max_depth' => $maxDepth,
        ]);

        /** @var list<int> $ids */
        $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

        return $ids;
    }

    /**
     * The scope parameters a query binds directly: whether the caller is
     * unrestricted (null OU), and their descendant OU id set otherwise.
     *
     * Callers always bind BOTH parameters against the SAME static SQL text
     * (see the WHERE fragment below) — never a runtime-branched query — so
     * the tenant_id predicate is never conditionally assembled.
     *
     * @return array{unrestricted: bool, scope: list<int>}
     */
    public static function scopeParams(PDO $pdo, int $tenantId, ?int $callerOuId): array
    {
        if ($callerOuId === null) {
            return ['unrestricted' => true, 'scope' => []];
        }

        return ['unrestricted' => false, 'scope' => self::descendantIds($pdo, $tenantId, $callerOuId)];
    }

    /**
     * The static WHERE fragment every OU-scoped query on a table with its own
     * ou_id column uses, unconditionally. $column is the table-qualified
     * column name (e.g. "p.ou_id") so callers can use this directly or
     * through a join.
     */
    public static function whereFragment(string $column): string
    {
        return "(:unrestricted = TRUE OR {$column} IS NULL OR {$column} = ANY(:scope))";
    }
}
```

Note: SQLite has no native boolean type and no `= ANY(array)` operator, so `whereFragment()`'s exact text is a PostgreSQL-only fragment — it is not exercised by this task's SQLite-backed unit tests, only by `descendantIds()`/`scopeParams()`, which are pure integer/array logic. `whereFragment()` is proven against the real Postgres host in Task 3, the first task with a real `ou_id` column to query.

- [ ] **Step 4: Run to verify it passes**

Run:

```powershell
npm run plugin:test
```

Expected: PASS, all 6 new tests.

- [ ] **Step 5: Run PHPStan**

Run:

```powershell
npm run plugin:stan
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add plugin/Access/OuScopeResolver.php plugin/tests/Access/OuScopeResolverTest.php
git commit -m "feat: OU descendant scope resolver"
```

---

### Task 3: `tasker_projects` and `tasker_sections`

These two are built together because project creation must atomically create a default "Backlog" section in the same transaction — a project is never in a state of existing without at least one section.

**Files:**
- Create: `plugin/Migrations/CreateTaskerProjectsTable.php`
- Create: `plugin/Migrations/CreateTaskerSectionsTable.php`
- Create: `plugin/Migrations/GrantTaskerProjectPermissions.php`
- Create: `plugin/Api/ProjectsApiHandler.php`
- Create: `plugin/Api/SectionsApiHandler.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`
- Test: `plugin/tests/Api/SectionsApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/TenantIsolationTest.php`

**Interfaces:**
- Consumes: `OuScopeResolver` from Task 2.
- Produces: `ProjectsApiHandler::list(int $tenantId, ?int $callerOuId): Response`, `::create(int $tenantId, ?int $callerOuId, int $createdBy, string $body): Response`, `::update(int $tenantId, ?int $callerOuId, int $projectId, string $body): Response`, `::delete(int $tenantId, ?int $callerOuId, int $projectId): Response`. `SectionsApiHandler::list(int $tenantId, int $projectId): Response`, `::create(int $tenantId, int $projectId, string $body): Response`, `::update(int $tenantId, int $sectionId, string $body): Response`, `::delete(int $tenantId, int $sectionId): Response` — tenant-scoped only, no OU check (only `tasker_projects` carries an `ou_id` column; the discovery-time OU boundary at `list_projects`/`get_board` is what actually gates who ever learns a section id exists — see the Global Constraints note on this plan's OU-scoping boundary). Public project shape: `{id, publicId, tenantId, ouId, name, slug, context, prefix, sortOrder, createdBy, createdAt}`. Public section shape: `{id, publicId, tenantId, projectId, name, slug, description, sortOrder, viewPrefs, createdAt}`. Later tasks (`tasker_groups` onward) reference `tasker_sections.id` as their `section_id` foreign key.

- [ ] **Step 1: Write the failing migration test**

Add a new test file `plugin/tests/TenantIsolationOuTest.php` — this is a SEPARATE conformance-style suite from `TenantIsolationTest.php`, specifically for the four OU-visibility cases, run against a REAL PostgreSQL connection (the OU traversal's `whereFragment()` uses `= ANY(:scope)`, which is PostgreSQL-only and cannot run against the SDK conformance kit's SQLite double):

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;

/**
 * Proves the four OU-descendant visibility cases against a REAL PostgreSQL
 * connection — required because OuScopeResolver::whereFragment() uses
 * PostgreSQL's `= ANY(array)`, which SQLite does not support. Run against the
 * host's own tasker_test database (created fresh per run) rather than the
 * conformance kit's in-memory SQLite double.
 */
final class TenantIsolationOuTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $dsn = getenv('TASKER_TEST_PG_DSN') ?: 'pgsql:host=localhost;port=5433;dbname=tasker';
        $user = getenv('TASKER_TEST_PG_USER') ?: 'tasker';
        $pass = getenv('TASKER_TEST_PG_PASS') ?: 'tasker_dev';

        try {
            $this->pdo = new PDO($dsn, $user, $pass);
        } catch (\PDOException $e) {
            self::markTestSkipped('No reachable Postgres test database: ' . $e->getMessage());
        }
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec('DROP TABLE IF EXISTS tasker_sections CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_projects CASCADE');
        $this->pdo->exec('
            CREATE TABLE IF NOT EXISTS organizational_units (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                parent_id INTEGER NULL REFERENCES organizational_units(id)
            )
        ');
        $this->pdo->exec('DELETE FROM organizational_units');

        (new CreateTaskerProjectsTable())->up($this->pdo);
        (new CreateTaskerSectionsTable())->up($this->pdo);
    }

    private function makeOu(int $id, int $tenantId, ?int $parentId): void
    {
        $stmt = $this->pdo->prepare('INSERT INTO organizational_units (id, tenant_id, parent_id) VALUES (?, ?, ?)');
        $stmt->execute([$id, $tenantId, $parentId]);
    }

    private function makeProjectDirect(int $tenantId, ?int $ouId, string $name): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_projects (public_id, tenant_id, ou_id, name, slug, created_by, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :ou_id, :name, :slug, 1, CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->execute([':tenant_id' => $tenantId, ':ou_id' => $ouId, ':name' => $name, ':slug' => strtolower($name)]);

        return (int) $stmt->fetchColumn();
    }

    public function testUserInParentOuSeesProjectInChildOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $childProjectId = $this->makeProjectDirect(7, 2, 'child project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 1)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($childProjectId, $ids);
    }

    public function testUserInChildOuDoesNotSeeProjectInParentOu(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $parentProjectId = $this->makeProjectDirect(7, 1, 'parent project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 2)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertNotContains($parentProjectId, $ids, 'visibility must never flow upward');
    }

    public function testUserInOneBranchDoesNotSeeASiblingBranchsProject(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $siblingProjectId = $this->makeProjectDirect(7, 3, 'sibling project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 2)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertNotContains($siblingProjectId, $ids);
    }

    public function testNullOuCallerSeesEveryProjectInTheTenant(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $rootId = $this->makeProjectDirect(7, null, 'root project');
        $childId = $this->makeProjectDirect(7, 2, 'deep project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, null)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($rootId, $ids);
        self::assertContains($childId, $ids);
    }

    public function testNullOuIdProjectIsVisibleToEveryone(): void
    {
        $this->makeOu(1, 7, null);
        $rootId = $this->makeProjectDirect(7, null, 'tenant-root project');

        $handler = new ProjectsApiHandler($this->pdo);
        $payload = json_decode($handler->list(7, 1)->getBody(), true);

        $ids = array_column($payload['data'], 'id');
        self::assertContains($rootId, $ids, 'a project with no ou_id is visible tenant-wide');
    }

    public function testCreateRejectsAnEmptyName(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->create(7, null, 1, json_encode(['name' => '  ']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCreateRejectsAnOuIdOutsideTheCallersScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller is scoped to OU 2; OU 3 is a sibling, outside their scope.
        $response = $handler->create(7, 2, 1, json_encode(['name' => 'Sneaky', 'ou_id' => 3]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testUpdateChangesNameAndPrefix(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Original Name');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['name' => 'Renamed', 'prefix' => 'REN']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame('REN', $payload['data']['prefix']);
    }

    public function testUpdateRejectsAnInvalidPrefix(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Prefix test');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $projectId, json_encode(['prefix' => 'toolongprefix']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testUpdateRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $parentProjectId = $this->makeProjectDirect(7, 1, 'Parent project');

        $handler = new ProjectsApiHandler($this->pdo);
        // Caller scoped to child OU 2 cannot update a project that lives in parent OU 1.
        $response = $handler->update(7, 2, $parentProjectId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUpdateRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->update(7, null, $otherTenantProjectId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheProjectAndItsBacklogSection(): void
    {
        $handler = new ProjectsApiHandler($this->pdo);
        $created = json_decode($handler->create(7, null, 1, json_encode(['name' => 'Doomed project']))->getBody(), true);
        $projectId = (int) $created['data']['id'];

        $response = $handler->delete(7, null, $projectId);

        self::assertSame(204, $response->getStatusCode());

        $projectCount = (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();
        $sectionCount = (int) $this->pdo->query("SELECT COUNT(*) FROM tasker_sections WHERE project_id = {$projectId}")->fetchColumn();
        self::assertSame(0, $projectCount);
        self::assertSame(0, $sectionCount, 'the default Backlog section must cascade-delete with its project');
    }

    public function testDeleteRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $otherTenantProjectId = $this->makeProjectDirect(9, null, 'Other tenant project');

        $handler = new ProjectsApiHandler($this->pdo);
        $response = $handler->delete(7, null, $otherTenantProjectId);

        self::assertSame(404, $response->getStatusCode());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: either SKIPPED (if no Postgres test database is reachable from wherever `npm run plugin:test` executes — this task's containerized test runner needs network access to `localhost:5433`, which the brief below resolves) or FAIL with `Class "Tasker\Migrations\CreateTaskerProjectsTable" not found`.

If it SKIPPED rather than failing for the right reason, the container running PHPUnit cannot reach the host's Postgres on `5433`. Since the existing `plugin:test` npm script runs PHPUnit inside a `php:8.4-cli` container without host networking, add a variant that adds `--network host` (Linux Docker) is not available on Docker Desktop for Windows/Mac — instead, connect via the Docker-internal hostname. Update the DSN default in the test to try both: first attempt `pgsql:host=host.docker.internal;port=5433;dbname=tasker`, falling back to `localhost` if that fails, by trying both DSNs in `setUp()` before skipping:

```php
        $dsn = getenv('TASKER_TEST_PG_DSN');
        $user = getenv('TASKER_TEST_PG_USER') ?: 'tasker';
        $pass = getenv('TASKER_TEST_PG_PASS') ?: 'tasker_dev';
        $candidates = $dsn !== false
            ? [$dsn]
            : ['pgsql:host=host.docker.internal;port=5433;dbname=tasker', 'pgsql:host=localhost;port=5433;dbname=tasker'];

        $connected = false;
        foreach ($candidates as $candidate) {
            try {
                $this->pdo = new PDO($candidate, $user, $pass);
                $connected = true;
                break;
            } catch (\PDOException) {
                continue;
            }
        }
        if (!$connected) {
            self::markTestSkipped('No reachable Postgres test database among: ' . implode(', ', $candidates));
        }
```

Replace the single-DSN block in Step 1's code with this before proceeding. Re-run and confirm it now fails on the missing migration class, not a skip.

- [ ] **Step 3: Write the migrations**

Create `plugin/Migrations/CreateTaskerProjectsTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * The board's project table. Deliberately excludes `description` (write-only
 * in the original app — every write site sets it, no read site was found
 * anywhere in the frontend) and `environment_id` (superseded by ou_id, the
 * whity OU that replaces Tasker's own environment concept).
 */
final class CreateTaskerProjectsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_projects (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                ou_id INTEGER NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                context JSONB NOT NULL DEFAULT \'{}\'::jsonb,
                prefix VARCHAR(5) NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_projects_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_projects_tenant_slug_unique UNIQUE (tenant_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_projects_tenant_id ON tasker_projects(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_projects_ou_id ON tasker_projects(ou_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_projects CASCADE');
    }
}
```

Create `plugin/Migrations/CreateTaskerSectionsTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Sections carry a stored, frozen slug from day one — Plan A's own note not
 * to repeat the retrofit its original codebase needed for this exact field.
 */
final class CreateTaskerSectionsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_sections (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                project_id BIGINT NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                description TEXT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                view_prefs JSONB NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_sections_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_sections_project_slug_unique UNIQUE (project_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_sections_tenant_id ON tasker_sections(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_sections_project_id ON tasker_sections(project_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_sections CASCADE');
    }
}
```

- [ ] **Step 4: Write the handler**

Create `plugin/Api/ProjectsApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Core\Audit\AuditLogger;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped, OU-scoped CRUD for tasker_projects.
 *
 * Every list/read query uses OuScopeResolver::whereFragment('ou_id') bound
 * with OuScopeResolver::scopeParams()'s output — always the SAME static SQL
 * text regardless of whether the caller is OU-restricted, per the design's
 * explicit answer to the tenant-predicate-scanner risk.
 */
final class ProjectsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/projects — OU-scoped list, newest first.
     */
    public function list(int $tenantId, ?int $callerOuId): Response
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        try {
            $stmt = $this->db->prepare(
                "SELECT id, public_id, tenant_id, ou_id, name, slug, context, prefix, sort_order, created_by, created_at
                 FROM tasker_projects
                 WHERE tenant_id = :tenant_id AND {$ouClause}
                 ORDER BY sort_order ASC, id DESC"
            );
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
            $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
            $stmt->execute();

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicProject'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch projects', 500);
        }
    }

    /**
     * POST /api/tasker/projects — create a project and its default "Backlog"
     * section atomically. A project never exists without at least one
     * section, closing the null-section rendering bug the original app
     * carried as a client-side workaround.
     */
    public function create(int $tenantId, ?int $callerOuId, int $createdBy, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        $ouId = null;
        if (is_array($decoded) && isset($decoded['ou_id'])) {
            $ouId = (int) $decoded['ou_id'];
            if (!$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('ou_id is outside the caller\'s scope', 422);
            }
        }

        $slug = self::slugify($name);

        $this->db->beginTransaction();
        try {
            $insertProject = $this->db->prepare(
                'INSERT INTO tasker_projects (public_id, tenant_id, ou_id, name, slug, created_by, created_at)
                 VALUES (:public_id, :tenant_id, :ou_id, :name, :slug, :created_by, CURRENT_TIMESTAMP)
                 RETURNING id'
            );
            $insertProject->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':ou_id' => $ouId,
                ':name' => $name,
                ':slug' => $slug,
                ':created_by' => $createdBy,
            ]);
            $projectId = (int) $insertProject->fetchColumn();

            $insertSection = $this->db->prepare(
                'INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :project_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insertSection->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':project_id' => $projectId,
                ':name' => 'Backlog',
                ':slug' => 'backlog',
            ]);

            $this->db->commit();
        } catch (\Throwable) {
            $this->db->rollBack();
            return Response::error('Failed to create project', 500);
        }

        (new AuditLogger($this->db))->record('tasker_project.created', [
            'tenant_id' => $tenantId,
            'target_type' => 'tasker_project',
            'target_id' => $projectId,
        ]);

        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Failed to create project', 500);
        }

        return Response::json(['data' => $this->toPublicProject($row)], 201);
    }

    /**
     * PATCH /api/tasker/projects/{id} — partial update. Only fields present
     * in the body are changed. slug is frozen at creation and never exposed
     * as an updatable field, the same policy sections and groups use.
     */
    public function update(int $tenantId, ?int $callerOuId, int $projectId, string $body): Response
    {
        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Project not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $projectId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (array_key_exists('ou_id', $decoded)) {
            $ouId = $decoded['ou_id'] !== null ? (int) $decoded['ou_id'] : null;
            if ($ouId !== null && !$this->ouIsInCallersScope($tenantId, $callerOuId, $ouId)) {
                return Response::error('ou_id is outside the caller\'s scope', 422);
            }
            $fields[] = 'ou_id = :ou_id';
            $params[':ou_id'] = $ouId;
        }
        if (array_key_exists('prefix', $decoded)) {
            $prefix = $decoded['prefix'] !== null ? strtoupper((string) $decoded['prefix']) : null;
            if ($prefix !== null && preg_match('/^[A-Z]{2,5}$/', $prefix) !== 1) {
                return Response::error('prefix must be 2-5 uppercase letters, or null to clear it', 400);
            }
            $fields[] = 'prefix = :prefix';
            $params[':prefix'] = $prefix;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicProject($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_projects SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($projectId, $tenantId, $callerOuId);
            if ($updated === null) {
                return Response::error('Project not found', 404);
            }

            (new AuditLogger($this->db))->record('tasker_project.updated', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_project',
                'target_id' => $projectId,
            ]);

            return Response::json(['data' => $this->toPublicProject($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update project', 500);
        }
    }

    /**
     * DELETE /api/tasker/projects/{id} — cascades to the project's sections,
     * groups, tasks, milestones, and task discussions via each table's own
     * FK (all ON DELETE CASCADE, see Tasks 4-7's migrations). entity_tags
     * rows referencing a deleted task or project become orphaned — accepted,
     * since entity_tags.entity_type is opaque and unenforced by design (§6).
     */
    public function delete(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        $row = $this->findScoped($projectId, $tenantId, $callerOuId);
        if ($row === null) {
            return Response::error('Project not found', 404);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $projectId, ':tenant_id' => $tenantId]);

            (new AuditLogger($this->db))->record('tasker_project.deleted', [
                'tenant_id' => $tenantId,
                'target_type' => 'tasker_project',
                'target_id' => $projectId,
            ]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete project', 500);
        }
    }

    /**
     * Whether $ouId is within the caller's own OU-descendant scope — used to
     * stop a caller assigning a project to an OU they cannot themselves see.
     */
    private function ouIsInCallersScope(int $tenantId, ?int $callerOuId, int $ouId): bool
    {
        if ($callerOuId === null) {
            return true; // unrestricted (tenant-root) caller may assign anywhere.
        }

        return in_array($ouId, OuScopeResolver::descendantIds($this->db, $tenantId, $callerOuId), true);
    }

    /**
     * A dependency-free RFC 4122 v4 UUID, generated in PHP because neither
     * PostgreSQL's gen_random_uuid() nor a DEFAULT expression that calls it
     * is available under the SQLite double this plugin's own unit tests run
     * against.
     */
    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId, ?int $callerOuId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT id, public_id, tenant_id, ou_id, name, slug, context, prefix, sort_order, created_by, created_at
             FROM tasker_projects
             WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $id, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');

        return $slug === '' ? 'project' : $slug;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicProject(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'ouId' => $row['ou_id'] !== null ? (int) $row['ou_id'] : null,
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'context' => json_decode((string) $row['context'], true) ?? [],
            'prefix' => $row['prefix'],
            'sortOrder' => (int) $row['sort_order'],
            'createdBy' => (int) $row['created_by'],
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
```

- [ ] **Step 5: Run to verify the OU tests pass**

Run:

```powershell
npm run plugin:test
```

Expected: all 13 `TenantIsolationOuTest` cases PASS (the original 5 OU-visibility cases plus the create/update/delete cases just added). If the container cannot reach Postgres even with the `host.docker.internal` fallback, verify `tasker_postgres`'s port `5433` is actually published on the host (`docker ps` should show `0.0.0.0:5433->5432/tcp`) — it is, per every prior plan's compose file — and that no Windows firewall rule blocks container-to-host loopback traffic; document whatever you find in your report.

- [ ] **Step 6: Write the failing test for `SectionsApiHandler`**

Unlike `ProjectsApiHandler`, sections carry no `ou_id` of their own (§4/§7 of the design spec — only projects do), so `SectionsApiHandler` needs no `OuScopeResolver` call at all and can be tested entirely against the SQLite double, matching every other tenant-scoped handler in this plugin.

Create `plugin/tests/Api/SectionsApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SectionsApiHandler;
use Tasker\Migrations\CreateTaskerSectionsTable;

final class SectionsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private SectionsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_projects (id, tenant_id) VALUES (100, 7), (200, 9)');
        (new CreateTaskerSectionsTable())->up($this->pdo);
        // The project's default Backlog section, mirroring what ProjectsApiHandler::create() would have made.
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug, created_at)
            VALUES (1, 'aaaaaaaa-0000-0000-0000-000000000001', 7, 100, 'Backlog', 'backlog', CURRENT_TIMESTAMP)");

        $this->handler = new SectionsApiHandler($this->pdo);
    }

    public function testCreateAddsASecondSectionToTheProject(): void
    {
        $response = $this->handler->create(7, 100, json_encode(['name' => 'In Progress']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('In Progress', $payload['data']['name']);
        self::assertSame('in-progress', $payload['data']['slug']);
    }

    public function testCreateRejects404ForAProjectOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 200, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListReturnsSectionsForTheGivenProjectAndTenant(): void
    {
        $payload = json_decode($this->handler->list(7, 100)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('Backlog', $payload['data'][0]['name']);
    }

    public function testUpdateChangesNameAndDescription(): void
    {
        $response = $this->handler->update(7, 1, json_encode(['name' => 'Renamed', 'description' => 'New subtitle']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame('New subtitle', $payload['data']['description']);
    }

    public function testUpdateRejects404ForASectionOutsideTheCallersTenant(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug, created_at)
            VALUES (2, 'aaaaaaaa-0000-0000-0000-000000000002', 9, 200, 'Other tenant section', 'other', CURRENT_TIMESTAMP)");

        $response = $this->handler->update(7, 2, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRejectsTheProjectsLastRemainingSection(): void
    {
        $response = $this->handler->delete(7, 1);

        self::assertSame(409, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count);
    }

    public function testDeleteRemovesANonLastSection(): void
    {
        $created = json_decode($this->handler->create(7, 100, json_encode(['name' => 'Extra section']))->getBody(), true);
        $extraId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $extraId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_sections')->fetchColumn();
        self::assertSame(1, $count);
    }
}
```

- [ ] **Step 7: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Api\SectionsApiHandler" not found`.

- [ ] **Step 8: Implement `SectionsApiHandler`**

Create `plugin/Api/SectionsApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

/**
 * Tenant-scoped CRUD for tasker_sections. No OU check — see this plan's
 * Global Constraints note on where the OU boundary actually lives.
 *
 * delete() refuses to remove a project's last remaining section — every
 * project must always have at least one, the invariant ProjectsApiHandler's
 * atomic Backlog-section creation exists to guarantee (design spec §4).
 * Deleting a non-last section still cascades to that section's own groups
 * and tasks; there is no separate non-empty guard for that case, the same
 * way deleting a whole project already implies deleting everything under it
 * — a confirmation prompt for a destructive delete is the frontend's job
 * (D2), not this API's.
 */
final class SectionsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function list(int $tenantId, int $projectId): Response
    {
        if (!$this->projectExists($tenantId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs, created_at
             FROM tasker_sections WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, id ASC'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return Response::json(['data' => array_map([$this, 'toPublicSection'], $rows)], 200);
    }

    public function create(int $tenantId, int $projectId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        if (!$this->projectExists($tenantId, $projectId)) {
            return Response::error('Project not found', 404);
        }

        $slug = self::slugify($name);

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :project_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':project_id' => $projectId,
                ':name' => $name,
                ':slug' => $slug,
            ]);

            $id = (int) $this->db->lastInsertId();
            $row = $this->findScoped($id, $tenantId);
            if ($row === null) {
                return Response::error('Failed to create section', 500);
            }

            return Response::json(['data' => $this->toPublicSection($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create section', 500);
        }
    }

    public function update(int $tenantId, int $sectionId, string $body): Response
    {
        $row = $this->findScoped($sectionId, $tenantId);
        if ($row === null) {
            return Response::error('Section not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $sectionId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (array_key_exists('description', $decoded)) {
            $fields[] = 'description = :description';
            $params[':description'] = $decoded['description'] !== null ? (string) $decoded['description'] : null;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }
        if (array_key_exists('view_prefs', $decoded)) {
            $encoded = json_encode($decoded['view_prefs']);
            $fields[] = 'view_prefs = :view_prefs';
            $params[':view_prefs'] = $encoded === false ? null : $encoded;
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicSection($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_sections SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($sectionId, $tenantId);
            if ($updated === null) {
                return Response::error('Section not found', 404);
            }

            return Response::json(['data' => $this->toPublicSection($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update section', 500);
        }
    }

    public function delete(int $tenantId, int $sectionId): Response
    {
        $row = $this->findScoped($sectionId, $tenantId);
        if ($row === null) {
            return Response::error('Section not found', 404);
        }

        $countStmt = $this->db->prepare(
            'SELECT COUNT(*) FROM tasker_sections WHERE project_id = :project_id AND tenant_id = :tenant_id'
        );
        $countStmt->execute([':project_id' => $row['project_id'], ':tenant_id' => $tenantId]);
        if ((int) $countStmt->fetchColumn() <= 1) {
            return Response::error('Cannot delete a project\'s last remaining section', 409);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete section', 500);
        }
    }

    private function projectExists(int $tenantId, int $projectId): bool
    {
        $stmt = $this->db->prepare('SELECT id FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id');
        $stmt->execute([':id' => $projectId, ':tenant_id' => $tenantId]);

        return $stmt->fetch() !== false;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs, created_at
             FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');

        return $slug === '' ? 'section' : $slug;
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
    private function toPublicSection(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'projectId' => (int) $row['project_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'description' => $row['description'],
            'sortOrder' => (int) $row['sort_order'],
            'viewPrefs' => $row['view_prefs'] !== null ? (json_decode((string) $row['view_prefs'], true) ?? null) : null,
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
```

- [ ] **Step 9: Run to verify it passes**

Run:

```powershell
npm run plugin:test
```

Expected: PASS, all 7 `SectionsApiHandlerTest` cases.

- [ ] **Step 10: Write the permission-grant migration**

Create `plugin/Migrations/GrantTaskerProjectPermissions.php`, following the exact reference pattern from `plugin/Migrations/GrantTaskerPingPermissions.php` (permissions(name, description, created_at), role_permissions(role_id, permission_id, created_at), ON CONFLICT (name) / (role_id, permission_id)):

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

final class GrantTaskerProjectPermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker_project:view', 'tasker_project:manage', 'tasker_structure:manage'];

    private const DESCRIPTION_PREFIX = 'Tasker plugin permission';

    public function up(\PDO $pdo): void
    {
        $insertPermission = $pdo->prepare(
            'INSERT INTO permissions (name, description, created_at)
             VALUES (:name, :description, CURRENT_TIMESTAMP)
             ON CONFLICT (name) DO NOTHING'
        );

        foreach (self::PERMISSIONS as $permission) {
            $insertPermission->execute([
                ':name' => $permission,
                ':description' => self::DESCRIPTION_PREFIX . ' (' . $permission . ')',
            ]);
        }

        $grant = $pdo->prepare(
            "INSERT INTO role_permissions (role_id, permission_id, created_at)
             SELECT r.id, p.id, CURRENT_TIMESTAMP
             FROM roles r, permissions p
             WHERE r.name = 'admin' AND p.name = :permission
             ON CONFLICT (role_id, permission_id) DO NOTHING"
        );

        foreach (self::PERMISSIONS as $permission) {
            $grant->execute([':permission' => $permission]);
        }
    }

    public function down(\PDO $pdo): void
    {
        $dropGrants = $pdo->prepare(
            "DELETE FROM role_permissions
             WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
               AND permission_id IN (SELECT id FROM permissions WHERE name = :permission)"
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropGrants->execute([':permission' => $permission]);
        }

        $dropCatalogue = $pdo->prepare(
            'DELETE FROM permissions
             WHERE name = :permission
               AND description LIKE :marker
               AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_id = permissions.id)'
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropCatalogue->execute([':permission' => $permission, ':marker' => self::DESCRIPTION_PREFIX . '%']);
        }
    }
}
```

`tasker_structure:manage` is granted here — once, for both sections and groups — rather than in Task 4, since sections (this task) need it first; Task 4's group routes simply reuse the permission this migration already granted.

- [ ] **Step 11: Wire everything into `TaskerPlugin.php`**

Add the imports:

```php
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\SectionsApiHandler;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\GrantTaskerProjectPermissions;
```

Add to `getMigrations()`, after the ping migrations:

```php
            CreateTaskerProjectsTable::class,
            CreateTaskerSectionsTable::class,
            GrantTaskerProjectPermissions::class,
```

Add to `getPermissions()`:

```php
            'tasker_project:view',
            'tasker_project:manage',
            'tasker_structure:manage',
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects',
                'handler' => [$this, 'listProjects'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => 'list_projects',
                    'summary' => 'List the caller\'s OU-scoped projects',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The project list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/projects',
                'handler' => [$this, 'createProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'create_project',
                    'summary' => 'Create a project (with its default Backlog section)',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created project'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        422 => ['description' => 'ou_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/projects/{id:\d+}',
                'handler' => [$this, 'updateProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'update_project',
                    'summary' => 'Update a project\'s name, ou_id, prefix, or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated project'],
                        400 => ['description' => 'name empty/too long, or prefix not 2-5 uppercase letters'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                        422 => ['description' => 'ou_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/projects/{id:\d+}',
                'handler' => [$this, 'deleteProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'delete_project',
                    'summary' => 'Delete a project and everything under it',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects/{projectId:\d+}/sections',
                'handler' => [$this, 'listSections'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_sections',
                    'summary' => 'List a project\'s sections',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The section list'],
                        404 => ['description' => 'Project not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/projects/{projectId:\d+}/sections',
                'handler' => [$this, 'createSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_section',
                    'summary' => 'Create a section within a project',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created section'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        404 => ['description' => 'Project not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/sections/{id:\d+}',
                'handler' => [$this, 'updateSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_section',
                    'summary' => 'Update a section\'s name, description, sort_order, or view_prefs',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated section'],
                        400 => ['description' => 'name empty or too long'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/sections/{id:\d+}',
                'handler' => [$this, 'deleteSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_section',
                    'summary' => 'Delete a section (and its groups/tasks)',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                        409 => ['description' => 'Cannot delete a project\'s last remaining section'],
                    ],
                ],
            ],
```

Add the route methods, plus a shared helper for resolving the caller's OU:

```php
    /**
     * GET /api/tasker/projects
     *
     * @param array<string, string> $params
     */
    public function listProjects(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new ProjectsApiHandler($this->resolvePdo()))->list($tenantId, $this->callerOuId());
    }

    /**
     * POST /api/tasker/projects
     *
     * @param array<string, string> $params
     */
    public function createProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $createdBy = \Whity\Core\Tenant\TenantContext::getUserId() ?? 0;

        return (new ProjectsApiHandler($this->resolvePdo()))
            ->create($tenantId, $this->callerOuId(), $createdBy, $request->getBody());
    }

    /**
     * PATCH /api/tasker/projects/{id}
     *
     * @param array<string, string> $params
     */
    public function updateProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new ProjectsApiHandler($this->resolvePdo()))
            ->update($tenantId, $this->callerOuId(), (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/projects/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new ProjectsApiHandler($this->resolvePdo()))
            ->delete($tenantId, $this->callerOuId(), (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/projects/{projectId}/sections
     *
     * @param array<string, string> $params
     */
    public function listSections(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))->list($tenantId, (int) ($params['projectId'] ?? 0));
    }

    /**
     * POST /api/tasker/projects/{projectId}/sections
     *
     * @param array<string, string> $params
     */
    public function createSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['projectId'] ?? 0), $request->getBody());
    }

    /**
     * PATCH /api/tasker/sections/{id}
     *
     * @param array<string, string> $params
     */
    public function updateSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/sections/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * The caller's own OU (nullable — null means tenant-root/unrestricted).
     * Resolved from the membership row TenantContext exposes for the active
     * tenant.
     */
    private function callerOuId(): ?int
    {
        return \Whity\Core\Tenant\TenantContext::getOuId();
    }
```

**Before implementing `callerOuId()` and `createdBy` exactly as sketched above**, verify `TenantContext`'s real available methods — `getOuId()` and `getUserId()` are the plan's best inference from `TenantContext::getTenantId()`'s established shape, but must be confirmed against the actual class before trusting them. Run:

```powershell
docker exec tasker_frankenphp grep -n "public static function" src/Core/Tenant/TenantContext.php
```

If the real method names differ (e.g. `getProfileId()` instead of `getUserId()`, or the OU is exposed via a different accessor, or not exposed on `TenantContext` at all and instead requires a membership lookup by tenant + profile id), adapt `callerOuId()` and the `createdBy` line to whatever the real class provides, and record exactly what you found and why in your report — this is exactly the kind of assumption prior plans in this project have gotten wrong when unverified.

- [ ] **Step 12: Register the plugin's new source directory with the conformance scanner**

Confirm `plugin/tests/TenantIsolationTest.php`'s `handlerSourceDirectories()` (or its dynamic directory discovery, if already converted to that shape by an earlier plan's fix) covers `plugin/Access/` and `plugin/Api/` without further edits. If it still hardcodes a directory list rather than discovering plugin-root subdirectories automatically, add `Access` to that list explicitly and note this as a deviation in your report — the dynamic-discovery fix was applied in a prior plan and should already cover this, but confirm rather than assume.

Also add `tasker_projects` and `tasker_sections` to the registry's tenant-owned table declarations in the same test file:

```php
        return TenantTableRegistry::for([
            'tasker_pings' => 'Connectivity probe rows are per-tenant.',
            'tasker_projects' => 'Board projects are per-tenant.',
            'tasker_sections' => 'Board sections are per-tenant.',
        ]);
```

And add both migrations to `schemaMigrations()`:

```php
    protected function schemaMigrations(): array
    {
        return [
            new CreateTaskerPingTable(),
            new CreateTaskerProjectsTable(),
            new CreateTaskerSectionsTable(),
        ];
    }
```

- [ ] **Step 13: Run the full plugin suite and PHPStan**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PASS / clean, including the extended tenant-isolation conformance suite now covering three tables.

- [ ] **Step 14: Verify against the running host**

```powershell
npm run plugin:install
```

```powershell
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"email":"admin@example.com","password":"admin123"}' -WebSession $s | Out-Null

$project = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/projects -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"First Project"}' -WebSession $s
$project.data
docker exec tasker_postgres psql -U tasker -d tasker -c "SELECT name, slug FROM tasker_sections WHERE project_id = $($project.data.id);"

# Add a second section, rename it, then delete it (not the last one, so this must succeed).
$section = Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/projects/$($project.data.id)/sections" -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"In Progress"}' -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/sections/$($section.data.id)" -Method Patch -ContentType 'application/json' -Headers $csrf -Body '{"name":"Doing"}' -WebSession $s
Invoke-WebRequest -Uri "http://localhost:8010/api/v1/tasker/sections/$($section.data.id)" -Method Delete -Headers $csrf -WebSession $s | Select-Object StatusCode

# Renaming the project, then confirming the Backlog section alone can't be deleted (409).
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/projects/$($project.data.id)" -Method Patch -ContentType 'application/json' -Headers $csrf -Body '{"name":"Renamed Project"}' -WebSession $s
$backlog = Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/projects/$($project.data.id)/sections" -WebSession $s
try { Invoke-WebRequest -Uri "http://localhost:8010/api/v1/tasker/sections/$($backlog.data[0].id)" -Method Delete -Headers $csrf -WebSession $s } catch { $_.Exception.Response.StatusCode.value__ }
```

Expected: section create/rename/delete succeed (204 on delete); the project rename succeeds; the last-remaining-section delete attempt returns 409.

- [ ] **Step 15: Commit**

```bash
git add plugin/Migrations plugin/Api/ProjectsApiHandler.php plugin/Api/SectionsApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: tasker_projects and tasker_sections, full CRUD, OU-scoped project visibility"
```

---

### Task 4: `tasker_groups`

**Files:**
- Create: `plugin/Migrations/CreateTaskerGroupsTable.php`
- Create: `plugin/Api/GroupsApiHandler.php`
- Test: `plugin/tests/Api/GroupsApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/TenantIsolationTest.php`

**Interfaces:**
- Consumes: `tasker_sections.id` from Task 3.
- Produces: `GroupsApiHandler::create(int $tenantId, int $sectionId, string $body): Response`, `::list(int $tenantId, int $sectionId): Response`, `::update(int $tenantId, int $groupId, string $body): Response`, `::delete(int $tenantId, int $groupId): Response`. Public shape: `{id, publicId, tenantId, sectionId, name, slug, sortOrder, createdAt}`. Deliberately **no** `projectId` column — the original app denormalizes it onto groups; this schema derives it via `section_id`'s join when needed, so it can never drift out of sync.

- [ ] **Step 1: Write the failing test**

Create `plugin/tests/Api/GroupsApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\GroupsApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;

final class GroupsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private GroupsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_sections (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id) VALUES (1, 7), (2, 9)");
        (new CreateTaskerGroupsTable())->up($this->pdo);

        $this->handler = new GroupsApiHandler($this->pdo);
    }

    public function testCreateStampsTheCallersTenantAndTheGivenSection(): void
    {
        $response = $this->handler->create(7, 1, json_encode(['name' => 'Backend']));

        self::assertSame(201, $response->getStatusCode());

        $row = $this->pdo->query('SELECT tenant_id, section_id, name, slug FROM tasker_groups')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(7, (int) $row['tenant_id']);
        self::assertSame(1, (int) $row['section_id']);
        self::assertSame('Backend', $row['name']);
        self::assertSame('backend', $row['slug']);
    }

    public function testCreateRejectsASectionOutsideTheCallersTenant(): void
    {
        // Section 2 belongs to tenant 9, not the caller's tenant 7.
        $response = $this->handler->create(7, 2, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListReturnsOnlyGroupsForTheGivenSectionAndTenant(): void
    {
        $this->handler->create(7, 1, json_encode(['name' => 'A']));
        $this->handler->create(9, 2, json_encode(['name' => 'B']));

        $payload = json_decode($this->handler->list(7, 1)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['name']);
    }

    public function testUpdateChangesNameAndSortOrder(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['name' => 'Original']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Renamed', 'sort_order' => 3]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Renamed', $payload['data']['name']);
        self::assertSame(3, $payload['data']['sortOrder']);
    }

    public function testUpdateRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['name' => 'Other tenant group']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $groupId, json_encode(['name' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheGroup(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['name' => 'Doomed']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_groups')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAGroupOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['name' => 'Other tenant group']))->getBody(), true);
        $groupId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $groupId);

        self::assertSame(404, $response->getStatusCode());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerGroupsTable" not found`.

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerGroupsTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * No project_id column, deliberately — the original app denormalizes it
 * alongside section_id ("every insert path sets both"), a pair that can
 * silently drift out of sync. This schema derives project scope via
 * section_id's own join.
 */
final class CreateTaskerGroupsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_groups (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                section_id BIGINT NOT NULL REFERENCES tasker_sections(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_groups_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_groups_section_slug_unique UNIQUE (section_id, slug)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_groups_tenant_id ON tasker_groups(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_groups_section_id ON tasker_groups(section_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_groups CASCADE');
    }
}
```

- [ ] **Step 4: Write the handler**

Create `plugin/Api/GroupsApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

final class GroupsApiHandler
{
    private const MAX_NAME_LENGTH = 255;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function list(int $tenantId, int $sectionId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'SELECT g.id, g.public_id, g.tenant_id, g.section_id, g.name, g.slug, g.sort_order, g.created_at
                 FROM tasker_groups g
                 WHERE g.tenant_id = :tenant_id AND g.section_id = :section_id
                 ORDER BY g.sort_order ASC, g.id ASC'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':section_id' => $sectionId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicGroup'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch groups', 500);
        }
    }

    public function create(int $tenantId, int $sectionId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $name = is_array($decoded) ? trim((string) ($decoded['name'] ?? '')) : '';
        if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
        }

        $sectionCheck = $this->db->prepare('SELECT id FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id');
        $sectionCheck->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);
        if ($sectionCheck->fetch() === false) {
            return Response::error('Section not found', 404);
        }

        $slug = self::slugify($name);

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_groups (public_id, tenant_id, section_id, name, slug, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :section_id, :name, :slug, 0, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':section_id' => $sectionId,
                ':name' => $name,
                ':slug' => $slug,
            ]);

            $id = (int) $this->db->lastInsertId();
            $row = $this->findScoped($id, $tenantId);

            if ($row === null) {
                return Response::error('Failed to create group', 500);
            }

            return Response::json(['data' => $this->toPublicGroup($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create group', 500);
        }
    }

    public function update(int $tenantId, int $groupId, string $body): Response
    {
        $row = $this->findScoped($groupId, $tenantId);
        if ($row === null) {
            return Response::error('Group not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $groupId, ':tenant_id' => $tenantId];

        if (array_key_exists('name', $decoded)) {
            $name = trim((string) $decoded['name']);
            if ($name === '' || mb_strlen($name) > self::MAX_NAME_LENGTH) {
                return Response::error('name must be a non-empty string of at most ' . self::MAX_NAME_LENGTH . ' characters', 400);
            }
            $fields[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicGroup($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_groups SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($groupId, $tenantId);
            if ($updated === null) {
                return Response::error('Group not found', 404);
            }

            return Response::json(['data' => $this->toPublicGroup($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update group', 500);
        }
    }

    /**
     * DELETE /api/tasker/groups/{id} — tasks in this group are un-grouped,
     * not deleted (tasker_tasks.group_id is ON DELETE SET NULL), so removing
     * a group never loses work, unlike removing a section or a project.
     */
    public function delete(int $tenantId, int $groupId): Response
    {
        $row = $this->findScoped($groupId, $tenantId);
        if ($row === null) {
            return Response::error('Group not found', 404);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_groups WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $groupId, ':tenant_id' => $tenantId]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete group', 500);
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, section_id, name, slug, sort_order, created_at
             FROM tasker_groups WHERE id = :id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');

        return $slug === '' ? 'group' : $slug;
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
    private function toPublicGroup(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'sectionId' => (int) $row['section_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
            'sortOrder' => (int) $row['sort_order'],
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
```

Note: `lastInsertId()` here relies on the same SQLite-vs-Postgres `SERIAL`/rowid distinction Task 4 of a prior plan (P1's `PingApiHandler`) already worked around by not depending on it after insert in tests — this handler's own unit test above never asserts on the `lastInsertId()`-derived id directly, only on the row it finds, so it is not exposed to that same pitfall. If a future test does assert on the returned id under SQLite, use the values supplied to the INSERT rather than a post-insert `SELECT` keyed by `lastInsertId()`, matching the fix already applied in `PingApiHandler::create()`.

- [ ] **Step 5: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS.

- [ ] **Step 6: Wire routes into `TaskerPlugin.php`**

Add the import:

```php
use Tasker\Api\GroupsApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
```

Add to `getMigrations()`:

```php
            CreateTaskerGroupsTable::class,
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/sections/{sectionId:\d+}/groups',
                'handler' => [$this, 'listGroups'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_groups',
                    'summary' => 'List a section\'s groups',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The group list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections/{sectionId:\d+}/groups',
                'handler' => [$this, 'createGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_group',
                    'summary' => 'Create a group within a section',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created group'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/groups/{id:\d+}',
                'handler' => [$this, 'updateGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_group',
                    'summary' => 'Update a group\'s name or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated group'],
                        400 => ['description' => 'name empty or too long'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/groups/{id:\d+}',
                'handler' => [$this, 'deleteGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_group',
                    'summary' => 'Delete a group (its tasks are un-grouped, not deleted)',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
```

Add the route methods:

```php
    /**
     * @param array<string, string> $params
     */
    public function listGroups(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))->list($tenantId, (int) ($params['sectionId'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function createGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['sectionId'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function updateGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function deleteGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }
```

`'tasker_structure:manage'` was already added to `getPermissions()` and granted by `GrantTaskerProjectPermissions` in Task 3 — nothing further to add here, groups simply reuse it.

- [ ] **Step 7: Extend the conformance registry**

In `plugin/tests/TenantIsolationTest.php`, add `tasker_groups` to `tenantTableRegistry()` and `CreateTaskerGroupsTable` to `schemaMigrations()`, following the exact pattern from Task 3's Step 8.

- [ ] **Step 8: Run the full suite and PHPStan**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add plugin/Migrations/CreateTaskerGroupsTable.php plugin/Api/GroupsApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: tasker_groups, full CRUD, section-scoped, no denormalized project_id"
```

---

### Task 5: `tasker_tasks`

The largest table. CRUD, the NOT-NULL section_id (with the Backlog fallback already guaranteed by Task 3), the priority CHECK constraint, entity_tags for tagging, audit_log for mutations, and full OU visibility inherited via the parent project.

**Files:**
- Create: `plugin/Migrations/CreateTaskerTasksTable.php`
- Create: `plugin/Migrations/GrantTaskerTaskPermissions.php`
- Create: `plugin/Api/TasksApiHandler.php`
- Test: `plugin/tests/Api/TasksApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/TenantIsolationTest.php`
- Modify: `plugin/tests/TenantIsolationOuTest.php` (from Task 3 — extended here with `readyWork()`'s OU-scoping cases)

**Interfaces:**
- Consumes: `tasker_sections`/`tasker_projects` (Task 3), `tasker_groups` (Task 4), `OuScopeResolver` (Task 2).
- Produces: `TasksApiHandler::listForSection(int $tenantId, int $sectionId): Response`, `::create(int $tenantId, int $sectionId, int $createdBy, string $body): Response`, `::update(int $tenantId, int $taskId, string $body): Response`, `::move(int $tenantId, int $taskId, string $body): Response`, `::delete(int $tenantId, int $taskId): Response`, `::complete(int $tenantId, int $taskId): Response`, `::uncomplete(int $tenantId, int $taskId): Response`, `::pin(int $tenantId, int $taskId): Response`, `::unpin(int $tenantId, int $taskId): Response`, `::tag(int $tenantId, int $taskId, string $body): Response`, `::readyWork(int $tenantId, ?int $callerOuId, int $projectId): Response`. `update()`/`move()`/`delete()`/`complete()`/`uncomplete()`/`pin()`/`unpin()`/`tag()` are tenant-scoped only (see the Global Constraints note on the OU-scoping boundary); `readyWork()` is OU-scoped like `get_board`, since it is reached directly by project id, not through a task the caller already holds. Public shape: `{id, publicId, tenantId, projectId, sectionId, groupId, text, detail, status, priority, dueDate, pinned, sortOrder, completedAt, shortId, createdBy, createdAt, updatedAt}`.

- [ ] **Step 1: Write the failing test**

Create `plugin/tests/Api/TasksApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerTasksTable;

final class TasksApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private TasksApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('CREATE TABLE tasker_sections (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL)');
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id) VALUES (100, 7)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (1, 7, 100), (2, 9, 100)");
        (new CreateTaskerTasksTable())->up($this->pdo);

        $this->handler = new TasksApiHandler($this->pdo);
    }

    public function testCreateStampsTenantAndDefaultsStatusToPending(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Ship it']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertSame('Ship it', $payload['data']['text']);
        self::assertNull($payload['data']['priority']);
    }

    public function testCreateRejectsASectionOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 2, 3, json_encode(['text' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testCreateAcceptsAValidPriority(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Urgent', 'priority' => 'rush']));

        $payload = json_decode($response->getBody(), true);
        self::assertSame('rush', $payload['data']['priority']);
    }

    public function testCreateRejectsAnInvalidPriority(): void
    {
        $response = $this->handler->create(7, 1, 3, json_encode(['text' => 'Bad', 'priority' => 'urgent-ish']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testCompleteSetsStatusAndCompletedAt(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Finish me']))->getBody(), true);

        $response = $this->handler->complete(7, (int) $created['data']['id']);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('done', $payload['data']['status']);
        self::assertNotNull($payload['data']['completedAt']);
    }

    public function testCompleteRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->complete(9, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testListForSectionReturnsOnlyThatSectionsTasksForTheCallersTenant(): void
    {
        $this->handler->create(7, 1, 3, json_encode(['text' => 'A']));

        $payload = json_decode($this->handler->listForSection(7, 1)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('A', $payload['data'][0]['text']);
    }

    public function testUpdateChangesTextDetailAndPriority(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Original']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $taskId, json_encode(['text' => 'Edited', 'detail' => 'more info', 'priority' => 'high']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['text']);
        self::assertSame('more info', $payload['data']['detail']);
        self::assertSame('high', $payload['data']['priority']);
    }

    public function testUpdateRejectsAnInvalidPriority(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Original']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->update(7, $taskId, json_encode(['priority' => 'urgent-ish']));

        self::assertSame(400, $response->getStatusCode());
    }

    public function testUpdateRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->update(9, 999, json_encode(['text' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testMoveChangesSectionAndSortOrder(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Movable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 3, 'sort_order' => 5]));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame(3, $payload['data']['sectionId']);
        self::assertSame(5, $payload['data']['sortOrder']);
    }

    public function testMoveRejectsASectionFromADifferentProject(): void
    {
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id) VALUES (200, 7)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (4, 7, 200)");
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Movable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->move(7, $taskId, json_encode(['section_id' => 4]));

        self::assertSame(422, $response->getStatusCode());
    }

    public function testDeleteRemovesTheTask(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Doomed']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $taskId);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_tasks')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->delete(9, 999);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testUncompleteRestoresPendingStatusAndClearsCompletedAt(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Flip-flop']))->getBody(), true);
        $taskId = (int) $created['data']['id'];
        $this->handler->complete(7, $taskId);

        $response = $this->handler->uncomplete(7, $taskId);

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('pending', $payload['data']['status']);
        self::assertNull($payload['data']['completedAt']);
    }

    public function testPinAndUnpinToggleThePinnedFlag(): void
    {
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Pin me']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $pinned = json_decode($this->handler->pin(7, $taskId)->getBody(), true);
        self::assertTrue($pinned['data']['pinned']);

        $unpinned = json_decode($this->handler->unpin(7, $taskId)->getBody(), true);
        self::assertFalse($unpinned['data']['pinned']);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerTasksTable" not found`.

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerTasksTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * The plain board task. Deliberately excludes every flow/seed/review/
 * agent-workflow/local-mode/intake column found in the original app's live
 * schema — those are added by their owning later slice via an ordinary
 * ALTER TABLE, not ported here. See the design spec §4 for the full list and
 * the reasoning (cheap additive migration later vs. the entity_tags case,
 * which required avoiding a structural rework).
 *
 * status is free text with NO CHECK constraint, deliberately — deferred
 * custom statuses must stay purely additive. priority IS CHECK-constrained,
 * since its value set is not on any roadmap to grow.
 *
 * section_id is NOT NULL: the original app's own code carries a comment
 * that a null section breaks board rendering. Every project's own creation
 * (Task 3) guarantees a Backlog section exists before any task can be
 * created, closing that class of bug at the schema level.
 *
 * section_id is ON DELETE CASCADE, not RESTRICT: a project delete (Task 3)
 * must cascade all the way through sections to tasks in one statement, and
 * PostgreSQL's cascade/restrict interaction across multiple FK paths to the
 * same row is not something to rely on getting right by accident. The
 * "don't let someone accidentally nuke a non-empty section" protection
 * therefore lives in the API layer instead — SectionsApiHandler::delete()
 * (Task 3) only ever guards against deleting a project's LAST section, and
 * deliberately does not guard against deleting a non-empty one; deleting a
 * section always deletes its tasks, the same way deleting a project already
 * implies deleting everything under it.
 */
final class CreateTaskerTasksTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tasker_tasks (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                project_id BIGINT NOT NULL REFERENCES tasker_projects(id) ON DELETE CASCADE,
                section_id BIGINT NOT NULL REFERENCES tasker_sections(id) ON DELETE CASCADE,
                group_id BIGINT NULL REFERENCES tasker_groups(id) ON DELETE SET NULL,
                text VARCHAR(2000) NOT NULL,
                detail TEXT NULL,
                status VARCHAR(64) NOT NULL DEFAULT 'pending',
                priority VARCHAR(16) NULL,
                due_date DATE NULL,
                pinned BOOLEAN NOT NULL DEFAULT FALSE,
                pinned_at TIMESTAMP NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                completed_at TIMESTAMP NULL,
                short_id INTEGER NULL,
                created_by INTEGER NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_tasks_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_tasks_priority_check CHECK (priority IS NULL OR priority IN ('rush', 'high', 'medium', 'low'))
            )
        ");

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_tenant_id ON tasker_tasks(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_section_id ON tasker_tasks(section_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_tasks_project_id ON tasker_tasks(project_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_tasks CASCADE');
    }
}
```

Note: SQLite does not enforce named `CHECK` constraints the same way PostgreSQL does in older versions, but modern SQLite (3.8+, bundled with PHP 8.4) does enforce `CHECK` constraints fully — Step 4's failing-priority test above depends on this. If that test unexpectedly passes with an invalid priority accepted rather than rejected under the real engine (it should be rejected at the application-validation layer regardless, see Step 4's handler code, which validates before the CHECK constraint is ever reached), the constraint enforcement itself is not the actual gate for that test — the handler's own validation is. Confirm this design deliberately in your report: the `CHECK` constraint is a data-integrity backstop for any future direct-SQL writer, not the primary validation path a live test exercises.

- [ ] **Step 4: Write the handler**

Create `plugin/Api/TasksApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Core\Audit\AuditLogger;
use Whity\Sdk\Http\Response;

final class TasksApiHandler
{
    private const MAX_TEXT_LENGTH = 2000;

    /**
     * @var list<string>
     */
    private const VALID_PRIORITIES = ['rush', 'high', 'medium', 'low'];

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function listForSection(int $tenantId, int $sectionId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                        due_date, pinned, pinned_at, sort_order, completed_at, short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id AND section_id = :section_id
                 ORDER BY sort_order ASC, id ASC'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':section_id' => $sectionId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch tasks', 500);
        }
    }

    public function create(int $tenantId, int $sectionId, int $createdBy, string $body): Response
    {
        $decoded = json_decode($body, true);
        $text = is_array($decoded) ? trim((string) ($decoded['text'] ?? '')) : '';
        if ($text === '' || mb_strlen($text) > self::MAX_TEXT_LENGTH) {
            return Response::error('text must be a non-empty string of at most ' . self::MAX_TEXT_LENGTH . ' characters', 400);
        }

        $priority = null;
        if (is_array($decoded) && $decoded['priority'] ?? null) {
            $priority = (string) $decoded['priority'];
            if (!in_array($priority, self::VALID_PRIORITIES, true)) {
                return Response::error('priority must be one of: ' . implode(', ', self::VALID_PRIORITIES), 400);
            }
        }

        $section = $this->db->prepare('SELECT id, project_id FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id');
        $section->execute([':id' => $sectionId, ':tenant_id' => $tenantId]);
        $sectionRow = $section->fetch(PDO::FETCH_ASSOC);
        if (!is_array($sectionRow)) {
            return Response::error('Section not found', 404);
        }

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_tasks
                    (public_id, tenant_id, project_id, section_id, text, priority, status, created_by, created_at, updated_at)
                 VALUES
                    (:public_id, :tenant_id, :project_id, :section_id, :text, :priority, :status, :created_by, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':project_id' => $sectionRow['project_id'],
                ':section_id' => $sectionId,
                ':text' => $text,
                ':priority' => $priority,
                ':status' => 'pending',
                ':created_by' => $createdBy,
            ]);

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

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicTask($row)], 200);
        }
        $fields[] = 'updated_at = CURRENT_TIMESTAMP';

        try {
            $sql = 'UPDATE tasker_tasks SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
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

        if (array_key_exists('section_id', $decoded)) {
            $sectionId = (int) $decoded['section_id'];
            $section = $this->db->prepare(
                'SELECT id FROM tasker_sections WHERE id = :id AND tenant_id = :tenant_id AND project_id = :project_id'
            );
            $section->execute([':id' => $sectionId, ':tenant_id' => $tenantId, ':project_id' => $projectId]);
            if ($section->fetch() === false) {
                return Response::error('section_id must belong to the task\'s own project', 422);
            }
            $fields[] = 'section_id = :section_id';
            $params[':section_id'] = $sectionId;
        }
        if (array_key_exists('group_id', $decoded)) {
            $groupId = $decoded['group_id'] !== null ? (int) $decoded['group_id'] : null;
            if ($groupId !== null) {
                $group = $this->db->prepare(
                    'SELECT g.id FROM tasker_groups g
                     JOIN tasker_sections s ON s.id = g.section_id
                     WHERE g.id = :id AND g.tenant_id = :tenant_id AND s.project_id = :project_id'
                );
                $group->execute([':id' => $groupId, ':tenant_id' => $tenantId, ':project_id' => $projectId]);
                if ($group->fetch() === false) {
                    return Response::error('group_id must belong to the task\'s own project', 422);
                }
            }
            $fields[] = 'group_id = :group_id';
            $params[':group_id'] = $groupId;
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
            $sql = 'UPDATE tasker_tasks SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
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
     * DELETE /api/tasker/tasks/{id} — cascades to the task's own milestones
     * and discussion (Tasks 6-7's FKs). entity_tags rows referencing this
     * task become orphaned — accepted, see §6/the project delete() docblock.
     */
    public function delete(int $tenantId, int $taskId): Response
    {
        $row = $this->findScoped($taskId, $tenantId);
        if ($row === null) {
            return Response::error('Task not found', 404);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
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
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET status = 'done', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id"
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
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET status = 'pending', completed_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id"
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
            $stmt = $this->db->prepare(
                "UPDATE tasker_tasks
                 SET pinned = :pinned, pinned_at = {$pinnedAtClause}, updated_at = CURRENT_TIMESTAMP
                 WHERE id = :id AND tenant_id = :tenant_id"
            );
            $stmt->execute([
                ':pinned' => $pinned,
                ':id' => $taskId,
                ':tenant_id' => $tenantId,
            ]);

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
            $stmt = $this->db->prepare(
                "SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail,
                        status, priority, due_date, pinned, pinned_at, sort_order, completed_at,
                        short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id AND project_id = :project_id AND status != 'done'
                 ORDER BY
                    pinned DESC,
                    CASE priority WHEN 'rush' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END ASC,
                    due_date ASC NULLS LAST,
                    sort_order ASC"
            );
            $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch ready work', 500);
        }
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
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                    due_date, pinned, pinned_at, sort_order, completed_at, short_id, created_by, created_at, updated_at
             FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
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
            'pinned' => (bool) $row['pinned'],
            'sortOrder' => (int) $row['sort_order'],
            'completedAt' => $row['completed_at'],
            'shortId' => $row['short_id'] !== null ? (int) $row['short_id'] : null,
            'createdBy' => (int) $row['created_by'],
            'createdAt' => (string) $row['created_at'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }
}
```

Note: `pinned` is read from SQLite as `0`/`1` and from PostgreSQL as `f`/`t` or a native bool depending on PDO driver configuration — `(bool) $row['pinned']` handles the SQLite integer case correctly; if a PHPUnit run against the real Postgres double in a later task shows this cast producing `true` for the string `'f'` (a real PHP gotcha — non-empty strings are always truthy), tighten this to an explicit comparison (`$row['pinned'] === true || $row['pinned'] === 't' || $row['pinned'] === 1`) and note the fix in your report. Confirm which behavior the actual driver exhibits rather than assuming.

- [ ] **Step 5: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS. Pay particular attention to `testCreateRejectsAnInvalidPriority` — confirm it fails for the RIGHT reason (the handler's own `in_array` check returning 400), not by coincidentally erroring elsewhere.

- [ ] **Step 6: Entity-tags integration for tasks**

Add a `tag()` method to `TasksApiHandler`, following the exact pattern already proven in Task 1's `PingApiHandler::tag()` — same tenant-scoped existence check, same `ON CONFLICT DO NOTHING` idempotent insert, `entity_type: 'tasker_task'`:

```php
    /**
     * POST /api/tasker/tasks/{id}/tags — attach an existing tag to a task.
     * Mirrors PingApiHandler::tag() exactly; see Task 1 for why entity_tags
     * requires no new plugin schema at all.
     */
    public function tag(int $tenantId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $tagId = is_array($decoded) && isset($decoded['tag_id']) ? (int) $decoded['tag_id'] : 0;
        if ($tagId <= 0) {
            return Response::error('tag_id is required and must be a positive integer', 400);
        }

        $find = $this->db->prepare('SELECT id FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
        $find->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        if ($find->fetch() === false) {
            return Response::error('Task not found', 404);
        }

        try {
            $insert = $this->db->prepare(
                'INSERT INTO entity_tags (tenant_id, entity_type, entity_id, tag_id, created_at)
                 VALUES (:tenant_id, :entity_type, :entity_id, :tag_id, CURRENT_TIMESTAMP)
                 ON CONFLICT (entity_type, entity_id, tag_id) DO NOTHING'
            );
            $insert->execute([
                ':tenant_id' => $tenantId,
                ':entity_type' => 'tasker_task',
                ':entity_id' => $taskId,
                ':tag_id' => $tagId,
            ]);

            $created = $insert->rowCount() > 0;

            return Response::json([
                'data' => ['entity_type' => 'tasker_task', 'entity_id' => $taskId, 'tag_id' => $tagId],
            ], $created ? 201 : 200);
        } catch (\Throwable) {
            return Response::error('Failed to attach tag', 500);
        }
    }
```

Add a test proving this specifically for tasks (do not skip it on the assumption Task 1's ping test already proves the mechanism — each handler owns its own tenant-scoping check, and a copy-paste error in `tag()`'s SQL for this table is exactly the kind of thing a per-table test catches):

```php
    public function testTagAttachesAnExistingTagToATask(): void
    {
        $this->pdo->exec('
            CREATE TABLE entity_tags (
                tenant_id INTEGER NOT NULL, entity_type VARCHAR(128) NOT NULL, entity_id BIGINT NOT NULL,
                tag_id BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                PRIMARY KEY (entity_type, entity_id, tag_id)
            )
        ');

        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Taggable']))->getBody(), true);
        $response = $this->handler->tag(7, (int) $created['data']['id'], json_encode(['tag_id' => 11]));

        self::assertSame(201, $response->getStatusCode());
    }
```

- [ ] **Step 7: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

- [ ] **Step 8: Write the permission-grant migration**

Create `plugin/Migrations/GrantTaskerTaskPermissions.php`, identical shape to `GrantTaskerPingPermissions`/`GrantTaskerProjectPermissions`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

final class GrantTaskerTaskPermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker_task:view', 'tasker_task:edit', 'tasker_task:complete', 'tasker_task:delete'];

    private const DESCRIPTION_PREFIX = 'Tasker plugin permission';

    public function up(\PDO $pdo): void
    {
        $insertPermission = $pdo->prepare(
            'INSERT INTO permissions (name, description, created_at)
             VALUES (:name, :description, CURRENT_TIMESTAMP)
             ON CONFLICT (name) DO NOTHING'
        );

        foreach (self::PERMISSIONS as $permission) {
            $insertPermission->execute([
                ':name' => $permission,
                ':description' => self::DESCRIPTION_PREFIX . ' (' . $permission . ')',
            ]);
        }

        $grant = $pdo->prepare(
            "INSERT INTO role_permissions (role_id, permission_id, created_at)
             SELECT r.id, p.id, CURRENT_TIMESTAMP
             FROM roles r, permissions p
             WHERE r.name = 'admin' AND p.name = :permission
             ON CONFLICT (role_id, permission_id) DO NOTHING"
        );

        foreach (self::PERMISSIONS as $permission) {
            $grant->execute([':permission' => $permission]);
        }
    }

    public function down(\PDO $pdo): void
    {
        $dropGrants = $pdo->prepare(
            "DELETE FROM role_permissions
             WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
               AND permission_id IN (SELECT id FROM permissions WHERE name = :permission)"
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropGrants->execute([':permission' => $permission]);
        }

        $dropCatalogue = $pdo->prepare(
            'DELETE FROM permissions
             WHERE name = :permission
               AND description LIKE :marker
               AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_id = permissions.id)'
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropCatalogue->execute([':permission' => $permission, ':marker' => self::DESCRIPTION_PREFIX . '%']);
        }
    }
}
```

- [ ] **Step 9: Wire routes into `TaskerPlugin.php`**

Add imports:

```php
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\Migrations\GrantTaskerTaskPermissions;
```

Add to `getMigrations()`:

```php
            CreateTaskerTasksTable::class,
            GrantTaskerTaskPermissions::class,
```

Add to `getPermissions()`:

```php
            'tasker_task:view',
            'tasker_task:edit',
            'tasker_task:complete',
            'tasker_task:delete',
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/sections/{sectionId:\d+}/tasks',
                'handler' => [$this, 'listTasksForSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'list_tasks',
                    'summary' => 'List a section\'s tasks',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The task list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections/{sectionId:\d+}/tasks',
                'handler' => [$this, 'createTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'create_task',
                    'summary' => 'Create a task in a section',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created task'],
                        400 => ['description' => 'text missing, empty, too long, or priority invalid'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/tasks/{id:\d+}',
                'handler' => [$this, 'updateTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'update_task',
                    'summary' => 'Update a task\'s text, detail, priority, or due_date',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated task'],
                        400 => ['description' => 'text empty/too long, or priority invalid'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/move',
                'handler' => [$this, 'moveTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'move_task',
                    'summary' => 'Move a task to a different section/group, or reorder it',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The moved task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                        422 => ['description' => 'section_id/group_id does not belong to the task\'s own project'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/tasks/{id:\d+}',
                'handler' => [$this, 'deleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:delete',
                'schema' => [
                    'operationId' => 'delete_task',
                    'summary' => 'Delete a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/complete',
                'handler' => [$this, 'completeTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'complete_task',
                    'summary' => 'Mark a task complete',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The completed task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/uncomplete',
                'handler' => [$this, 'uncompleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'uncomplete_task',
                    'summary' => 'Restore a completed task to pending',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The reopened task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/pin',
                'handler' => [$this, 'pinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'pin_task',
                    'summary' => 'Pin a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The pinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/unpin',
                'handler' => [$this, 'unpinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'unpin_task',
                    'summary' => 'Unpin a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The unpinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/tags',
                'handler' => [$this, 'tagTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'tag_task',
                    'summary' => 'Attach an existing tag to a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'Tag attached'],
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects/{id:\d+}/ready-work',
                'handler' => [$this, 'getReadyWork'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_ready_work',
                    'summary' => 'List a project\'s non-done tasks, ranked by what to work on next',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The ranked task list'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
```

Add the route methods:

```php
    /**
     * @param array<string, string> $params
     */
    public function listTasksForSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->listForSection($tenantId, (int) ($params['sectionId'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function createTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $createdBy = \Whity\Core\Tenant\TenantContext::getUserId() ?? 0;

        return (new TasksApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['sectionId'] ?? 0), $createdBy, $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function updateTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function moveTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))
            ->move($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function deleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function completeTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->complete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function uncompleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->uncomplete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function pinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->pin($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function unpinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->unpin($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function tagTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->tag($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function getReadyWork(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))
            ->readyWork($tenantId, $this->callerOuId(), (int) ($params['id'] ?? 0));
    }
```

- [ ] **Step 10: Extend `TenantIsolationOuTest.php` for `get_ready_work`'s OU scoping**

`readyWork()` uses `OuScopeResolver::whereFragment()`, which — like every other OU-scoped query in this plugin — is PostgreSQL-only (`= ANY(:scope)`). It cannot be exercised by `TasksApiHandlerTest`'s SQLite double, the same reason `ProjectsApiHandler` has no SQLite unit test of its own (Task 3). Extend the Postgres-based `plugin/tests/TenantIsolationOuTest.php` instead.

Add to its `setUp()`, after the existing `CreateTaskerSectionsTable` call:

```php
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_tasks CASCADE');
        $this->pdo->exec('DROP TABLE IF EXISTS tasker_groups CASCADE');
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);
```

Add the corresponding imports (`use Tasker\Api\TasksApiHandler;`, `use Tasker\Migrations\CreateTaskerGroupsTable;`, `use Tasker\Migrations\CreateTaskerTasksTable;`) and a direct-insert helper alongside `makeProjectDirect()`:

```php
    private function makeTaskDirect(int $tenantId, int $projectId, int $sectionId, string $text, ?string $priority = null, bool $pinned = false): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_tasks (public_id, tenant_id, project_id, section_id, text, priority, pinned, status, created_by, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, :section_id, :text, :priority, :pinned, 'pending', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             RETURNING id"
        );
        $stmt->execute([
            ':tenant_id' => $tenantId, ':project_id' => $projectId, ':section_id' => $sectionId,
            ':text' => $text, ':priority' => $priority, ':pinned' => $pinned,
        ]);

        return (int) $stmt->fetchColumn();
    }
```

(This test helper uses `gen_random_uuid()` directly rather than PHP-generated UUIDs, unlike the application handlers — it runs only against real Postgres, where the function genuinely exists, so there is no portability concern to design around here.)

Add the test methods:

```php
    public function testReadyWorkExcludesDoneTasks(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Ready work project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $doneTaskId = $this->makeTaskDirect(7, $projectId, $sectionId, 'Already done');
        $this->pdo->exec("UPDATE tasker_tasks SET status = 'done' WHERE id = {$doneTaskId}");
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Still open');

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->readyWork(7, null, $projectId)->getBody(), true);

        self::assertCount(1, $payload['data']);
        self::assertSame('Still open', $payload['data'][0]['text']);
    }

    public function testReadyWorkOrdersPinnedAndHigherPriorityFirst(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Ranking project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Low priority', 'low');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Rush, unpinned', 'rush');
        $this->makeTaskDirect(7, $projectId, $sectionId, 'Pinned, no priority', null, true);

        $handler = new TasksApiHandler($this->pdo);
        $payload = json_decode($handler->readyWork(7, null, $projectId)->getBody(), true);

        self::assertSame('Pinned, no priority', $payload['data'][0]['text'], 'pinned always sorts first, regardless of priority');
        self::assertSame('Rush, unpinned', $payload['data'][1]['text']);
        self::assertSame('Low priority', $payload['data'][2]['text']);
    }

    public function testReadyWorkRejects404ForAProjectOutsideTheCallersOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $projectId = $this->makeProjectDirect(7, 1, 'Parent OU project');

        $handler = new TasksApiHandler($this->pdo);
        $response = $handler->readyWork(7, 2, $projectId);

        self::assertSame(404, $response->getStatusCode());
    }
```

This relies on a `makeSectionDirect()` helper that does not exist yet in `TenantIsolationOuTest.php` — add it alongside `makeProjectDirect()`:

```php
    private function makeSectionDirect(int $tenantId, int $projectId): int
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO tasker_sections (public_id, tenant_id, project_id, name, slug, created_at)
             VALUES (gen_random_uuid(), :tenant_id, :project_id, 'Backlog', 'backlog', CURRENT_TIMESTAMP) RETURNING id"
        );
        $stmt->execute([':tenant_id' => $tenantId, ':project_id' => $projectId]);

        return (int) $stmt->fetchColumn();
    }
```

- [ ] **Step 11: Run to verify Step 10's new tests pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS, all 16 `TenantIsolationOuTest` cases (13 from Task 3 plus the 3 `readyWork` cases just added).

- [ ] **Step 12: Extend the conformance registry**

Add `tasker_tasks` to `tenantTableRegistry()` and `CreateTaskerTasksTable` to `schemaMigrations()` in `plugin/tests/TenantIsolationTest.php`.

- [ ] **Step 13: Run full suite and PHPStan**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PASS / clean.

- [ ] **Step 14: Verify against the running host**

```powershell
npm run plugin:install
```

```powershell
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"email":"admin@example.com","password":"admin123"}' -WebSession $s | Out-Null

$project = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/projects -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"Task test project"}' -WebSession $s
docker exec tasker_postgres psql -U tasker -d tasker -c "SELECT id, name FROM tasker_sections WHERE project_id = $($project.data.id);"
```

Use the `Backlog` section id from that query to exercise the full task lifecycle against the live host:

```powershell
$sectionId = 1  # replace with the id printed above
$task = Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/sections/$sectionId/tasks" -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"text":"Ship it","priority":"high"}' -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/tasks/$($task.data.id)" -Method Patch -ContentType 'application/json' -Headers $csrf -Body '{"text":"Ship it now"}' -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/tasks/$($task.data.id)/pin" -Method Post -Headers $csrf -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/tasks/$($task.data.id)/complete" -Method Post -Headers $csrf -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/tasks/$($task.data.id)/uncomplete" -Method Post -Headers $csrf -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/projects/$($project.data.id)/ready-work" -WebSession $s
Invoke-WebRequest -Uri "http://localhost:8010/api/v1/tasker/tasks/$($task.data.id)" -Method Delete -Headers $csrf -WebSession $s | Select-Object StatusCode
```

Expected: each call succeeds; `ready-work` shows the pinned, reopened task; the final delete returns 204.

- [ ] **Step 15: Commit**

```bash
git add plugin/Migrations plugin/Api/TasksApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: tasker_tasks with full CRUD, move, pin, ready-work, entity-tags and audit-log integration"
```

---

### Task 6: `tasker_milestones`

**Files:**
- Create: `plugin/Migrations/CreateTaskerMilestonesTable.php`
- Create: `plugin/Migrations/GrantTaskerMilestonePermissions.php`
- Create: `plugin/Api/MilestonesApiHandler.php`
- Test: `plugin/tests/Api/MilestonesApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/TenantIsolationTest.php`

**Interfaces:**
- Consumes: `tasker_tasks.id` from Task 5.
- Produces: `MilestonesApiHandler::create(int $tenantId, int $taskId, string $body): Response`, `::toggle(int $tenantId, int $milestoneId): Response`, `::listForTask(int $tenantId, int $taskId): Response`, `::update(int $tenantId, int $milestoneId, string $body): Response`, `::delete(int $tenantId, int $milestoneId): Response`. Public shape: `{id, publicId, tenantId, taskId, summary, detail, checked, sortOrder, createdAt}`.

- [ ] **Step 1: Write the failing test**

Create `plugin/tests/Api/MilestonesApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Migrations\CreateTaskerMilestonesTable;

final class MilestonesApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private MilestonesApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id) VALUES (1, 7), (2, 9)');
        (new CreateTaskerMilestonesTable())->up($this->pdo);

        $this->handler = new MilestonesApiHandler($this->pdo);
    }

    public function testCreateDefaultsCheckedToFalse(): void
    {
        $response = $this->handler->create(7, 1, json_encode(['summary' => 'Write tests']));

        self::assertSame(201, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertFalse($payload['data']['checked']);
    }

    public function testCreateRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->create(7, 2, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testToggleFlipsCheckedState(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Toggle me']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $first = json_decode($this->handler->toggle(7, $id)->getBody(), true);
        $second = json_decode($this->handler->toggle(7, $id)->getBody(), true);

        self::assertTrue($first['data']['checked']);
        self::assertFalse($second['data']['checked']);
    }

    public function testListForTaskOrdersBySortOrder(): void
    {
        $this->handler->create(7, 1, json_encode(['summary' => 'Second', 'sort_order' => 2]));
        $this->handler->create(7, 1, json_encode(['summary' => 'First', 'sort_order' => 1]));

        $payload = json_decode($this->handler->listForTask(7, 1)->getBody(), true);

        self::assertSame('First', $payload['data'][0]['summary']);
        self::assertSame('Second', $payload['data'][1]['summary']);
    }

    public function testUpdateChangesSummaryAndDetail(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Original']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Edited', 'detail' => 'more info']));

        self::assertSame(200, $response->getStatusCode());
        $payload = json_decode($response->getBody(), true);
        self::assertSame('Edited', $payload['data']['summary']);
        self::assertSame('more info', $payload['data']['detail']);
    }

    public function testUpdateRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['summary' => 'Other tenant']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->update(7, $id, json_encode(['summary' => 'Should fail']));

        self::assertSame(404, $response->getStatusCode());
    }

    public function testDeleteRemovesTheMilestone(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Doomed']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $id);

        self::assertSame(204, $response->getStatusCode());

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_milestones')->fetchColumn();
        self::assertSame(0, $count);
    }

    public function testDeleteRejects404ForAMilestoneOutsideTheCallersTenant(): void
    {
        $created = json_decode($this->handler->create(9, 2, json_encode(['summary' => 'Other tenant']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $response = $this->handler->delete(7, $id);

        self::assertSame(404, $response->getStatusCode());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerMilestonesTable" not found`.

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerMilestonesTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Retires the original app's task_discussions.steps (jsonb array) +
 * checked_steps (parallel boolean array) + the four row-locking plpgsql
 * functions that existed solely to stop concurrent writers clobbering each
 * other on a read-modify-write cycle. A real table with row-level locking
 * needs none of that. `kind` (question|prerequisite, seed-checklist only) is
 * deliberately excluded — seed territory, deferred to D7 with seeds.
 */
final class CreateTaskerMilestonesTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_milestones (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                task_id BIGINT NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                summary VARCHAR(1000) NOT NULL,
                detail TEXT NULL,
                checked BOOLEAN NOT NULL DEFAULT FALSE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_milestones_public_id_unique UNIQUE (public_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_milestones_tenant_id ON tasker_milestones(tenant_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_milestones_task_id ON tasker_milestones(task_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_milestones CASCADE');
    }
}
```

- [ ] **Step 4: Write the handler**

Create `plugin/Api/MilestonesApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Whity\Sdk\Http\Response;

final class MilestonesApiHandler
{
    private const MAX_SUMMARY_LENGTH = 1000;

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function listForTask(int $tenantId, int $taskId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'SELECT id, public_id, tenant_id, task_id, summary, detail, checked, sort_order, created_at
                 FROM tasker_milestones
                 WHERE tenant_id = :tenant_id AND task_id = :task_id
                 ORDER BY sort_order ASC, id ASC'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':task_id' => $taskId]);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicMilestone'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch milestones', 500);
        }
    }

    public function create(int $tenantId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $summary = is_array($decoded) ? trim((string) ($decoded['summary'] ?? '')) : '';
        if ($summary === '' || mb_strlen($summary) > self::MAX_SUMMARY_LENGTH) {
            return Response::error('summary must be a non-empty string of at most ' . self::MAX_SUMMARY_LENGTH . ' characters', 400);
        }
        $sortOrder = is_array($decoded) && isset($decoded['sort_order']) ? (int) $decoded['sort_order'] : 0;

        $task = $this->db->prepare('SELECT id FROM tasker_tasks WHERE id = :id AND tenant_id = :tenant_id');
        $task->execute([':id' => $taskId, ':tenant_id' => $tenantId]);
        if ($task->fetch() === false) {
            return Response::error('Task not found', 404);
        }

        try {
            $insert = $this->db->prepare(
                'INSERT INTO tasker_milestones (public_id, tenant_id, task_id, summary, sort_order, created_at)
                 VALUES (:public_id, :tenant_id, :task_id, :summary, :sort_order, CURRENT_TIMESTAMP)'
            );
            $insert->execute([
                ':public_id' => self::generateUuidV4(),
                ':tenant_id' => $tenantId,
                ':task_id' => $taskId,
                ':summary' => $summary,
                ':sort_order' => $sortOrder,
            ]);

            $id = (int) $this->db->lastInsertId();
            $row = $this->findScoped($id, $tenantId);
            if ($row === null) {
                return Response::error('Failed to create milestone', 500);
            }

            return Response::json(['data' => $this->toPublicMilestone($row)], 201);
        } catch (\Throwable) {
            return Response::error('Failed to create milestone', 500);
        }
    }

    public function update(int $tenantId, int $milestoneId, string $body): Response
    {
        $row = $this->findScoped($milestoneId, $tenantId);
        if ($row === null) {
            return Response::error('Milestone not found', 404);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        $fields = [];
        $params = [':id' => $milestoneId, ':tenant_id' => $tenantId];

        if (array_key_exists('summary', $decoded)) {
            $summary = trim((string) $decoded['summary']);
            if ($summary === '' || mb_strlen($summary) > self::MAX_SUMMARY_LENGTH) {
                return Response::error('summary must be a non-empty string of at most ' . self::MAX_SUMMARY_LENGTH . ' characters', 400);
            }
            $fields[] = 'summary = :summary';
            $params[':summary'] = $summary;
        }
        if (array_key_exists('detail', $decoded)) {
            $fields[] = 'detail = :detail';
            $params[':detail'] = $decoded['detail'] !== null ? (string) $decoded['detail'] : null;
        }
        if (array_key_exists('sort_order', $decoded)) {
            $fields[] = 'sort_order = :sort_order';
            $params[':sort_order'] = (int) $decoded['sort_order'];
        }

        if ($fields === []) {
            return Response::json(['data' => $this->toPublicMilestone($row)], 200);
        }

        try {
            $sql = 'UPDATE tasker_milestones SET ' . implode(', ', $fields) . ' WHERE id = :id AND tenant_id = :tenant_id';
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);

            $updated = $this->findScoped($milestoneId, $tenantId);
            if ($updated === null) {
                return Response::error('Milestone not found', 404);
            }

            return Response::json(['data' => $this->toPublicMilestone($updated)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update milestone', 500);
        }
    }

    public function delete(int $tenantId, int $milestoneId): Response
    {
        $row = $this->findScoped($milestoneId, $tenantId);
        if ($row === null) {
            return Response::error('Milestone not found', 404);
        }

        try {
            $stmt = $this->db->prepare('DELETE FROM tasker_milestones WHERE id = :id AND tenant_id = :tenant_id');
            $stmt->execute([':id' => $milestoneId, ':tenant_id' => $tenantId]);

            return Response::json(null, 204);
        } catch (\Throwable) {
            return Response::error('Failed to delete milestone', 500);
        }
    }

    /**
     * POST /api/tasker/milestones/{id}/toggle — flips checked, does not set it
     * to a caller-supplied value, matching the original app's own toggle
     * semantics (complete_milestone / uncomplete_milestone were always a pair
     * of opposite actions, never an arbitrary set).
     */
    public function toggle(int $tenantId, int $milestoneId): Response
    {
        try {
            $stmt = $this->db->prepare(
                'UPDATE tasker_milestones SET checked = NOT checked
                 WHERE id = :id AND tenant_id = :tenant_id'
            );
            $stmt->execute([':id' => $milestoneId, ':tenant_id' => $tenantId]);

            if ($stmt->rowCount() === 0) {
                return Response::error('Milestone not found', 404);
            }

            $row = $this->findScoped($milestoneId, $tenantId);
            if ($row === null) {
                return Response::error('Milestone not found', 404);
            }

            return Response::json(['data' => $this->toPublicMilestone($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to toggle milestone', 500);
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
     * @return array<string, mixed>|null
     */
    private function findScoped(int $id, int $tenantId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT id, public_id, tenant_id, task_id, summary, detail, checked, sort_order, created_at
             FROM tasker_milestones WHERE id = :id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':id' => $id, ':tenant_id' => $tenantId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function toPublicMilestone(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'tenantId' => (int) $row['tenant_id'],
            'taskId' => (int) $row['task_id'],
            'summary' => (string) $row['summary'],
            'detail' => $row['detail'],
            'checked' => (bool) $row['checked'],
            'sortOrder' => (int) $row['sort_order'],
            'createdAt' => (string) $row['created_at'],
        ];
    }
}
```

Note `UPDATE tasker_milestones SET checked = NOT checked` — this is valid, identical syntax on both SQLite and PostgreSQL, and avoids the read-then-write race the original app's row-locking functions existed to prevent, since it is a single atomic statement.

- [ ] **Step 5: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS.

- [ ] **Step 6: Write the permission-grant migration**

Create `plugin/Migrations/GrantTaskerMilestonePermissions.php`, identical shape to the earlier grant migrations, granting `tasker_milestone:edit`.

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

final class GrantTaskerMilestonePermissions implements MigrationInterface
{
    /**
     * @var list<string>
     */
    private const PERMISSIONS = ['tasker_milestone:edit'];

    private const DESCRIPTION_PREFIX = 'Tasker plugin permission';

    public function up(\PDO $pdo): void
    {
        $insertPermission = $pdo->prepare(
            'INSERT INTO permissions (name, description, created_at)
             VALUES (:name, :description, CURRENT_TIMESTAMP)
             ON CONFLICT (name) DO NOTHING'
        );

        foreach (self::PERMISSIONS as $permission) {
            $insertPermission->execute([
                ':name' => $permission,
                ':description' => self::DESCRIPTION_PREFIX . ' (' . $permission . ')',
            ]);
        }

        $grant = $pdo->prepare(
            "INSERT INTO role_permissions (role_id, permission_id, created_at)
             SELECT r.id, p.id, CURRENT_TIMESTAMP
             FROM roles r, permissions p
             WHERE r.name = 'admin' AND p.name = :permission
             ON CONFLICT (role_id, permission_id) DO NOTHING"
        );

        foreach (self::PERMISSIONS as $permission) {
            $grant->execute([':permission' => $permission]);
        }
    }

    public function down(\PDO $pdo): void
    {
        $dropGrants = $pdo->prepare(
            "DELETE FROM role_permissions
             WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
               AND permission_id IN (SELECT id FROM permissions WHERE name = :permission)"
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropGrants->execute([':permission' => $permission]);
        }

        $dropCatalogue = $pdo->prepare(
            'DELETE FROM permissions
             WHERE name = :permission
               AND description LIKE :marker
               AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_id = permissions.id)'
        );

        foreach (self::PERMISSIONS as $permission) {
            $dropCatalogue->execute([':permission' => $permission, ':marker' => self::DESCRIPTION_PREFIX . '%']);
        }
    }
}
```

- [ ] **Step 7: Wire routes into `TaskerPlugin.php`**

Add imports:

```php
use Tasker\Api\MilestonesApiHandler;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\GrantTaskerMilestonePermissions;
```

Add to `getMigrations()`:

```php
            CreateTaskerMilestonesTable::class,
            GrantTaskerMilestonePermissions::class,
```

Add to `getPermissions()`:

```php
            'tasker_milestone:edit',
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks/{taskId:\d+}/milestones',
                'handler' => [$this, 'listMilestones'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'list_milestones',
                    'summary' => 'List a task\'s milestones',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The milestone list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{taskId:\d+}/milestones',
                'handler' => [$this, 'addMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'add_milestone',
                    'summary' => 'Add a milestone to a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created milestone'],
                        400 => ['description' => 'summary missing, empty, or too long'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/milestones/{id:\d+}/toggle',
                'handler' => [$this, 'toggleMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'complete_milestone',
                    'summary' => 'Toggle a milestone\'s checked state',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated milestone'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/milestones/{id:\d+}',
                'handler' => [$this, 'updateMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'update_milestone',
                    'summary' => 'Update a milestone\'s summary, detail, or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated milestone'],
                        400 => ['description' => 'summary empty or too long'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/milestones/{id:\d+}',
                'handler' => [$this, 'deleteMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'delete_milestone',
                    'summary' => 'Delete a milestone',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
```

Note the `operationId` for the toggle route is `complete_milestone` — preserving the agent-facing name from the original app even though this new implementation always *toggles* rather than offering separate complete/uncomplete actions. This is a deliberate simplification; if a later plan finds agents need an explicit `uncomplete_milestone` semantic distinct from toggle, that is new scope for that plan, not a gap in this one.

Add the route methods:

```php
    /**
     * @param array<string, string> $params
     */
    public function listMilestones(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->listForTask($tenantId, (int) ($params['taskId'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function addMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['taskId'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function toggleMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->toggle($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function updateMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * @param array<string, string> $params
     */
    public function deleteMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }
```

- [ ] **Step 8: Extend the conformance registry**

Add `tasker_milestones` to `tenantTableRegistry()` and `CreateTaskerMilestonesTable` to `schemaMigrations()`.

- [ ] **Step 9: Run full suite and PHPStan; commit**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

```bash
git add plugin/Migrations plugin/Api/MilestonesApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: tasker_milestones, full CRUD, retiring the jsonb steps/checked_steps pattern"
```

---

### Task 7: `tasker_task_discussions`

**Files:**
- Create: `plugin/Migrations/CreateTaskerTaskDiscussionsTable.php`
- Create: `plugin/Api/TaskDiscussionsApiHandler.php`
- Test: `plugin/tests/Api/TaskDiscussionsApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`
- Modify: `plugin/tests/TenantIsolationTest.php`

**Interfaces:**
- Consumes: `tasker_tasks.id` from Task 5.
- Produces: `TaskDiscussionsApiHandler::get(int $tenantId, int $taskId): Response`, `::put(int $tenantId, int $taskId, string $body): Response`. Public shape: `{taskId, messages, reason, updatedAt}`. This task lays down the data model only — nothing populates it until D2 wires the AI chat UI to it, per the design spec.

- [ ] **Step 1: Write the failing test**

Create `plugin/tests/Api/TaskDiscussionsApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;

final class TaskDiscussionsApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private TaskDiscussionsApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_tasks (id, tenant_id) VALUES (1, 7), (2, 9)');
        (new CreateTaskerTaskDiscussionsTable())->up($this->pdo);

        $this->handler = new TaskDiscussionsApiHandler($this->pdo);
    }

    public function testGetOnATaskWithNoDiscussionYetReturnsAnEmptyShape(): void
    {
        $payload = json_decode($this->handler->get(7, 1)->getBody(), true);

        self::assertSame([], $payload['data']['messages']);
        self::assertNull($payload['data']['reason']);
    }

    public function testGetRejectsATaskOutsideTheCallersTenant(): void
    {
        $response = $this->handler->get(7, 2);

        self::assertSame(404, $response->getStatusCode());
    }

    public function testPutCreatesTheDiscussionRowOnFirstWrite(): void
    {
        $body = json_encode(['messages' => [['role' => 'user', 'content' => 'hi']], 'reason' => 'testing']);

        $response = $this->handler->put(7, 1, $body);

        self::assertSame(200, $response->getStatusCode());

        $row = $this->pdo->query('SELECT task_id, messages, reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame(1, (int) $row['task_id']);
        self::assertSame('testing', $row['reason']);
    }

    public function testPutUpdatesAnExistingDiscussionRowRatherThanDuplicating(): void
    {
        $this->handler->put(7, 1, json_encode(['messages' => [], 'reason' => 'first']));
        $this->handler->put(7, 1, json_encode(['messages' => [], 'reason' => 'second']));

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_task_discussions')->fetchColumn();
        self::assertSame(1, $count);

        $row = $this->pdo->query('SELECT reason FROM tasker_task_discussions')->fetch(PDO::FETCH_ASSOC);
        self::assertSame('second', $row['reason']);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerTaskDiscussionsTable" not found`.

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerTaskDiscussionsTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * AI chat and focus reason only — milestones are extracted into their own
 * table (see CreateTaskerMilestonesTable). D1 lays down this data model
 * without populating it; the AI calling logic that writes here is D2's job.
 */
final class CreateTaskerTaskDiscussionsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_task_discussions (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                task_id BIGINT NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
                messages JSONB NOT NULL DEFAULT \'[]\'::jsonb,
                reason TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_task_discussions_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_task_discussions_task_id_unique UNIQUE (task_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_task_discussions_tenant_id ON tasker_task_discussions(tenant_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_task_discussions CASCADE');
    }
}
```

- [ ] **Step 4: Write the handler**

Create `plugin/Api/TaskDiscussionsApiHandler.php`:

```php
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
     */
    public function put(int $tenantId, int $taskId, string $body): Response
    {
        $decoded = json_decode($body, true);
        $messages = is_array($decoded) && isset($decoded['messages']) && is_array($decoded['messages'])
            ? $decoded['messages']
            : [];
        $reason = is_array($decoded) && isset($decoded['reason']) ? (string) $decoded['reason'] : null;

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
```

Note: SQLite's `INSERT ... ON CONFLICT (column) DO UPDATE SET ...` requires the `column` to have a `UNIQUE` constraint for the conflict target to resolve — `tasker_task_discussions_task_id_unique` in the migration provides exactly this, and the same syntax is valid PostgreSQL. If a PHPUnit run shows a "no unique or exclusion constraint matching the ON CONFLICT specification" error under either engine, the migration's `UNIQUE (task_id)` constraint did not apply as expected — verify it landed by inspecting the table's actual constraints before assuming the handler's SQL is wrong.

- [ ] **Step 5: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS.

- [ ] **Step 6: Wire routes into `TaskerPlugin.php`**

No new permission is needed — reuse `tasker_task:view` for the GET and `tasker_task:edit` for the PUT, since a task's discussion is part of the task itself. Add the import:

```php
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
```

Add to `getMigrations()`:

```php
            CreateTaskerTaskDiscussionsTable::class,
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks/{id:\d+}/discussion',
                'handler' => [$this, 'getDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_task_discussion',
                    'summary' => 'Read a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The discussion (empty shape if none yet)'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PUT',
                'path' => '/api/tasker/tasks/{id:\d+}/discussion',
                'handler' => [$this, 'putDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'set_task_discussion',
                    'summary' => 'Save a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The saved discussion'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
```

Add the route methods:

```php
    /**
     * @param array<string, string> $params
     */
    public function getDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TaskDiscussionsApiHandler($this->resolvePdo()))->get($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * @param array<string, string> $params
     */
    public function putDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TaskDiscussionsApiHandler($this->resolvePdo()))
            ->put($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }
```

- [ ] **Step 7: Extend the conformance registry**

Add `tasker_task_discussions` to `tenantTableRegistry()` and `CreateTaskerTaskDiscussionsTable` to `schemaMigrations()`.

- [ ] **Step 8: Run full suite and PHPStan; commit**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

```bash
git add plugin/Migrations plugin/Api/TaskDiscussionsApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: tasker_task_discussions data model (AI chat + focus reason)"
```

---

### Task 8: The board endpoint

**Files:**
- Create: `plugin/Api/BoardApiHandler.php`
- Test: `plugin/tests/Api/BoardApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`

**Interfaces:**
- Consumes: `ProjectsApiHandler`'s scoped `findScoped()` pattern, `tasker_sections`/`tasker_groups`/`tasker_tasks`/`tasker_milestones` from Tasks 3–6.
- Produces: `BoardApiHandler::get(int $tenantId, ?int $callerOuId, int $projectId): Response` — one response composing the whole board.

- [ ] **Step 1: Write the failing test**

Create `plugin/tests/Api/BoardApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\BoardApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;

final class BoardApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private BoardApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('
            CREATE TABLE organizational_units (
                id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, parent_id INTEGER NULL
            )
        ');
        (new CreateTaskerProjectsTable())->up($this->pdo);
        (new CreateTaskerSectionsTable())->up($this->pdo);
        (new CreateTaskerGroupsTable())->up($this->pdo);
        (new CreateTaskerTasksTable())->up($this->pdo);
        (new CreateTaskerMilestonesTable())->up($this->pdo);

        $this->pdo->exec("INSERT INTO tasker_projects (id, public_id, tenant_id, ou_id, name, slug, created_by) VALUES (1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 7, NULL, 'Board Project', 'board-project', 1)");
        $this->pdo->exec("INSERT INTO tasker_projects (id, public_id, tenant_id, ou_id, name, slug, created_by) VALUES (2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 9, NULL, 'Other Tenant', 'other-tenant', 1)");
        $this->pdo->exec("INSERT INTO tasker_sections (id, public_id, tenant_id, project_id, name, slug) VALUES (1, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 7, 1, 'Backlog', 'backlog')");
        $this->pdo->exec("INSERT INTO tasker_groups (id, public_id, tenant_id, section_id, name, slug) VALUES (1, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 7, 1, 'Frontend', 'frontend')");
        $this->pdo->exec("INSERT INTO tasker_tasks (id, public_id, tenant_id, project_id, section_id, group_id, text, status, created_by) VALUES (1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 7, 1, 1, 1, 'Ship it', 'pending', 1)");
        $this->pdo->exec("INSERT INTO tasker_milestones (id, public_id, tenant_id, task_id, summary, checked) VALUES (1, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 7, 1, 'Write code', 0)");

        $this->handler = new BoardApiHandler($this->pdo);
    }

    public function testGetComposesSectionsGroupsTasksAndMilestones(): void
    {
        $payload = json_decode($this->handler->get(7, null, 1)->getBody(), true);

        self::assertSame(1, $payload['data']['project']['id']);
        self::assertCount(1, $payload['data']['sections']);
        self::assertSame('Backlog', $payload['data']['sections'][0]['name']);
        self::assertCount(1, $payload['data']['sections'][0]['groups']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks']);
        self::assertSame('Ship it', $payload['data']['sections'][0]['groups'][0]['tasks'][0]['text']);
        self::assertCount(1, $payload['data']['sections'][0]['groups'][0]['tasks'][0]['milestones']);
    }

    public function testGet404sForAProjectOutsideTheCallersTenant(): void
    {
        $response = $this->handler->get(7, null, 2);

        self::assertSame(404, $response->getStatusCode());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Api\BoardApiHandler" not found`.

- [ ] **Step 3: Implement**

Create `plugin/Api/BoardApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Access\OuScopeResolver;
use Whity\Sdk\Http\Response;

/**
 * GET /api/tasker/projects/{id}/board — sections, groups, tasks and
 * milestone progress in one response, replacing the four-to-five separate
 * round trips the original Supabase app made per board load.
 */
final class BoardApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function get(int $tenantId, ?int $callerOuId, int $projectId): Response
    {
        $project = $this->findProject($tenantId, $callerOuId, $projectId);
        if ($project === null) {
            return Response::error('Project not found', 404);
        }

        $sections = $this->fetchAll(
            'SELECT id, public_id, tenant_id, project_id, name, slug, description, sort_order, view_prefs
             FROM tasker_sections WHERE tenant_id = :tenant_id AND project_id = :project_id ORDER BY sort_order ASC, id ASC',
            [':tenant_id' => $tenantId, ':project_id' => $projectId]
        );

        $groups = $this->fetchAll(
            'SELECT g.id, g.public_id, g.tenant_id, g.section_id, g.name, g.slug, g.sort_order
             FROM tasker_groups g
             JOIN tasker_sections s ON s.id = g.section_id
             WHERE g.tenant_id = :tenant_id AND s.project_id = :project_id
             ORDER BY g.sort_order ASC, g.id ASC',
            [':tenant_id' => $tenantId, ':project_id' => $projectId]
        );

        $tasks = $this->fetchAll(
            'SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                    due_date, pinned, sort_order, completed_at, short_id
             FROM tasker_tasks WHERE tenant_id = :tenant_id AND project_id = :project_id
             ORDER BY sort_order ASC, id ASC',
            [':tenant_id' => $tenantId, ':project_id' => $projectId]
        );

        $taskIds = array_map(static fn (array $t): int => (int) $t['id'], $tasks);
        $milestonesByTask = $this->fetchMilestonesGroupedByTask($tenantId, $taskIds);

        $tasksBySection = [];
        $tasksByGroup = [];
        foreach ($tasks as $task) {
            $task['milestones'] = $milestonesByTask[(int) $task['id']] ?? [];
            $sectionId = (int) $task['section_id'];
            $groupId = $task['group_id'] !== null ? (int) $task['group_id'] : null;

            if ($groupId !== null) {
                $tasksByGroup[$groupId][] = $task;
            } else {
                $tasksBySection[$sectionId][] = $task;
            }
        }

        $groupsBySection = [];
        foreach ($groups as $group) {
            $groupId = (int) $group['id'];
            $group['tasks'] = array_map([$this, 'toPublicTask'], $tasksByGroup[$groupId] ?? []);
            $groupsBySection[(int) $group['section_id']][] = $group;
        }

        $publicSections = [];
        foreach ($sections as $section) {
            $sectionId = (int) $section['id'];
            $publicSections[] = [
                'id' => $sectionId,
                'publicId' => (string) $section['public_id'],
                'name' => (string) $section['name'],
                'slug' => (string) $section['slug'],
                'description' => $section['description'],
                'sortOrder' => (int) $section['sort_order'],
                'ungroupedTasks' => array_map([$this, 'toPublicTask'], $tasksBySection[$sectionId] ?? []),
                'groups' => array_map(fn (array $g) => $this->toPublicGroup($g), $groupsBySection[$sectionId] ?? []),
            ];
        }

        return Response::json([
            'data' => [
                'project' => $project,
                'sections' => $publicSections,
            ],
        ], 200);
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findProject(int $tenantId, ?int $callerOuId, int $projectId): ?array
    {
        $scope = OuScopeResolver::scopeParams($this->db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $this->db->prepare(
            "SELECT id, public_id, tenant_id, ou_id, name, slug FROM tasker_projects
             WHERE id = :id AND tenant_id = :tenant_id AND {$ouClause}"
        );
        $stmt->bindValue(':id', $projectId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'publicId' => (string) $row['public_id'],
            'name' => (string) $row['name'],
            'slug' => (string) $row['slug'],
        ];
    }

    /**
     * @param array<string, mixed> $params
     * @return array<int, array<string, mixed>>
     */
    private function fetchAll(string $sql, array $params): array
    {
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        /** @var array<int, array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return $rows;
    }

    /**
     * @param list<int> $taskIds
     * @return array<int, array<int, array<string, mixed>>>
     */
    private function fetchMilestonesGroupedByTask(int $tenantId, array $taskIds): array
    {
        if ($taskIds === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($taskIds), '?'));
        $stmt = $this->db->prepare(
            "SELECT id, task_id, summary, detail, checked, sort_order
             FROM tasker_milestones
             WHERE tenant_id = ? AND task_id IN ({$placeholders})
             ORDER BY sort_order ASC, id ASC"
        );
        $stmt->execute(array_merge([$tenantId], $taskIds));

        $grouped = [];
        /** @var array<string, mixed> $row */
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $grouped[(int) $row['task_id']][] = [
                'id' => (int) $row['id'],
                'summary' => (string) $row['summary'],
                'detail' => $row['detail'],
                'checked' => (bool) $row['checked'],
                'sortOrder' => (int) $row['sort_order'],
            ];
        }

        return $grouped;
    }

    /**
     * @param array<string, mixed> $task
     * @return array<string, mixed>
     */
    private function toPublicTask(array $task): array
    {
        return [
            'id' => (int) $task['id'],
            'publicId' => (string) $task['public_id'],
            'text' => (string) $task['text'],
            'detail' => $task['detail'],
            'status' => (string) $task['status'],
            'priority' => $task['priority'],
            'dueDate' => $task['due_date'],
            'pinned' => (bool) $task['pinned'],
            'sortOrder' => (int) $task['sort_order'],
            'completedAt' => $task['completed_at'],
            'shortId' => $task['short_id'] !== null ? (int) $task['short_id'] : null,
            'milestones' => $task['milestones'] ?? [],
        ];
    }

    /**
     * @param array<string, mixed> $group
     * @return array<string, mixed>
     */
    private function toPublicGroup(array $group): array
    {
        return [
            'id' => (int) $group['id'],
            'publicId' => (string) $group['public_id'],
            'name' => (string) $group['name'],
            'slug' => (string) $group['slug'],
            'sortOrder' => (int) $group['sort_order'],
            'tasks' => $group['tasks'] ?? [],
        ];
    }
}
```

Note: this handler introduces `ungroupedTasks` on each section, for tasks whose `group_id` is null — the design spec did not explicitly name this field, since a task without a group is a real, valid state (groups are optional subdivisions per Task 4). Confirm this reads sensibly against the test's fixture data (the one seeded task has `group_id = 1`, so `ungroupedTasks` should be empty for it) and note in your report if a differently-shaped composition would serve better — this is the one place in this task with room for a judgment call, since the spec did not pin the exact response envelope shape this precisely.

- [ ] **Step 4: Run to verify pass**

Run:

```powershell
npm run plugin:test
```

Expected: PASS.

- [ ] **Step 5: Wire the route into `TaskerPlugin.php`**

Add the import:

```php
use Tasker\Api\BoardApiHandler;
```

Add to `getRoutes()`:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects/{id:\d+}/board',
                'handler' => [$this, 'getBoard'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => 'get_board',
                    'summary' => 'Get a project\'s full board: sections, groups, tasks, milestones',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The composed board'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
```

Add the route method:

```php
    /**
     * @param array<string, string> $params
     */
    public function getBoard(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new BoardApiHandler($this->resolvePdo()))->get($tenantId, $this->callerOuId(), (int) ($params['id'] ?? 0));
    }
```

- [ ] **Step 6: Run full suite and PHPStan**

Run:

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PASS / clean.

- [ ] **Step 7: Verify against the running host**

```powershell
npm run plugin:install
```

```powershell
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"email":"admin@example.com","password":"admin123"}' -WebSession $s | Out-Null

$project = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/projects -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"Board endpoint test"}' -WebSession $s
Invoke-RestMethod -Uri "http://localhost:8010/api/v1/tasker/projects/$($project.data.id)/board" -WebSession $s | ConvertTo-Json -Depth 10
```

Expected: a single response showing the project, one `Backlog` section, empty groups and tasks.

- [ ] **Step 8: Commit**

```bash
git add plugin/Api/BoardApiHandler.php plugin/tests plugin/TaskerPlugin.php
git commit -m "feat: board endpoint composing sections, groups, tasks, milestones"
```

---

### Task 9: MCP tool-surface snapshot, full acceptance pass

**Files:**
- Modify: `docs/mcp-tool-surface.json`
- Modify: `host/scripts/mcp-tools.ps1` (only if its filter needs widening — see Step 1)
- Modify: `README.md`

**Interfaces:**
- Consumes: every route declared across Tasks 1–8.
- Produces: an updated committed snapshot covering D1's full tool surface, and a final, documented acceptance run.

- [ ] **Step 1: Check the snapshot script's filter**

`host/scripts/mcp-tools.ps1` (from Plan A) filters the live tool list with `Where-Object { $_.name -like '*ping*' }`. D1 adds far more tools than contain `ping`. Widen the filter to capture the whole plugin's surface rather than one substring:

Find the line in `host/scripts/mcp-tools.ps1`:

```powershell
$tools = $response.result.tools |
    Where-Object { $_.name -like '*ping*' } |
```

Replace with a filter matching every D1 + Plan A tool name explicitly, since "every tool this plugin derives" is more precise and more future-proof than a substring guess:

```powershell
$taskerToolNames = @(
    'list_pings', 'create_ping', 'tag_ping',
    'list_projects', 'create_project', 'update_project', 'delete_project',
    'list_sections', 'create_section', 'update_section', 'delete_section',
    'list_groups', 'create_group', 'update_group', 'delete_group',
    'list_tasks', 'create_task', 'update_task', 'move_task', 'delete_task',
    'complete_task', 'uncomplete_task', 'pin_task', 'unpin_task', 'tag_task', 'get_ready_work',
    'list_milestones', 'add_milestone', 'complete_milestone', 'update_milestone', 'delete_milestone',
    'get_board',
    'get_task_discussion', 'set_task_discussion'
)
$tools = $response.result.tools |
    Where-Object { $taskerToolNames -contains $_.name } |
```

- [ ] **Step 2: Regenerate the OpenAPI spec and the snapshot**

```powershell
npm run plugin:install
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:tools
```

Expected output: exactly the 34 tool names listed in Step 1's `$taskerToolNames` array (assuming Plan A's `list_pings`/`create_ping`/`tag_ping` are still present — confirm; if Plan A's ping tools were ever removed by an intervening plan, adjust the expected count accordingly and note it).

- [ ] **Step 3: Write the snapshot**

```powershell
npm run mcp:tools -- -Write
```

If the script does not accept a `-Write` passthrough via `npm run` (check `package.json`'s `mcp:tools` script definition — it may need `--` before script-specific flags, or the flag name may differ from Plan A's original design), invoke the underlying PowerShell script directly instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1 -Write
```

- [ ] **Step 4: Prove the drift check still catches a real rename**

Temporarily rename one D1 operationId — e.g. change `'operationId' => 'complete_task'` to `'operationId' => 'finish_task'` in `TaskerPlugin.php` — then:

```powershell
npm run plugin:install
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:check
```

Expected: FAIL, naming the drift. Revert the rename, reinstall, regenerate, and confirm `npm run mcp:check` passes again before committing. This is the same discipline Plan A's own drift-check task established — never skip proving the guard actually bites.

- [ ] **Step 5: Full acceptance run**

Run every check this plan and its predecessors depend on, in order, and capture real output for each:

```powershell
npm run plugin:test
npm run plugin:stan
npm run mcp:check
```

Then, against the live host, walk the complete board path end to end as a human would: log in, create a project (confirm the Backlog section exists), add a second section and rename it, create a section-scoped task, tag it, edit it, move it, pin it, complete and uncomplete it, check `ready-work` reflects it, add and toggle a milestone, fetch the board endpoint and confirm it shows everything composed correctly, fetch/save the task's discussion, and finally delete the task, the extra section, and the project itself.

- [ ] **Step 6: Update `README.md`**

Add a line to the foundation-checks list:

```markdown
- `npm run mcp:check` — now covers D1's full board tool surface (34 tools), not just Plan A's ping proof
```

- [ ] **Step 7: Commit**

```bash
git add docs/mcp-tool-surface.json host/scripts/mcp-tools.ps1 README.md
git commit -m "test: extend the MCP tool-surface snapshot to D1's full board surface"
```

---

## Plan acceptance

D1 is complete when:

1. All nine tasks' tests pass, including the four OU-visibility cases and the depth-bound cycle test from Task 2's `OuScopeResolverTest`, the create/update/delete and `readyWork` cases added to Task 3/5's `TenantIsolationOuTest`, and every handler's own tenant-scoped CRUD suite.
2. `entity_tags` and `audit_log` are genuinely exercised by real task/ping mutations (Tasks 1 and 5), not merely present in the schema.
3. The board endpoint (Task 8) composes sections, groups, tasks, and milestones correctly for a visible project and 404s for one outside scope.
4. `get_ready_work` (Task 5) correctly excludes done tasks, ranks pinned/priority/due_date, and 404s for a project outside the caller's OU scope.
5. Every table with full CRUD (projects, sections, groups, tasks, milestones) supports create/read/update/delete end to end, proven by test, not just create/read.
6. The MCP tool-surface snapshot (Task 9) covers the full 34-tool D1 surface and has been proven to catch a real rename.
7. `npm run plugin:stan` is clean across every new file.
8. Every standing Plan A / P1 invariant still holds: tenant isolation, `host/.core/` untouched, permission slugs single-colon, CSRF/versioned-route conventions unchanged.
9. No handler relies on a PostgreSQL-only function (`NOW()`, `gen_random_uuid()`) inside a code path exercised by the SQLite-backed unit tests — every timestamp is `CURRENT_TIMESTAMP`, every `public_id` is generated in PHP.

**Not delivered by this plan:** a working SPA (D2 rewires the frontend to these endpoints), data migration from the live Supabase app (D3), local mode, flows, custom statuses, review gates, or any agent-workflow field — all explicitly deferred per the design spec.
