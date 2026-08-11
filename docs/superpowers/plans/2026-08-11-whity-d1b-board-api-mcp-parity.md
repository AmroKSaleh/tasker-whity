# D1b — Board API Completion and MCP Contract Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every board tool genuinely invocable by the agents that use Tasker today — same names, same argument shapes, same flexible identifiers — and fill the reads and verbs D1 left out.

**Architecture:** An OU-scoped `IdentifierResolver` sits in front of every handler, turning whatever an agent passes (integer, UUID, `TDE-31`, prefix, slug, or nothing) into an internal integer id. Routes flatten so identifiers live in query parameters and request bodies rather than path segments, because `ToolDeriver` makes path parameters unconditionally required and the original's contracts are mostly optional. Fourteen new tools land, all carrying original names.

**Tech Stack:** whity-core pinned at `cc126f6` (SDK 1.16), PHP 8.4, PostgreSQL 15, PHPUnit 10, PHPStan 2.x at level 6.

**Spec:** [2026-08-09-d1b-board-api-completion-and-mcp-parity-design.md](../specs/2026-08-09-d1b-board-api-completion-and-mcp-parity-design.md)

## Global Constraints

- Every table carries `tenant_id INTEGER NOT NULL`, bound explicitly in every query. No implicit tenant filtering.
- Dual keys on every table: `id BIGSERIAL PRIMARY KEY` internal, `public_id UUID NOT NULL UNIQUE` external, generated in PHP.
- Permission slugs take exactly one colon: `/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/`.
- Routes are **declared** without `/v1` and **served** at `/api/v1/…`. Mutating requests require `X-Requested-With: XMLHttpRequest` (enforced at the HTTP layer; handlers do not check).
- Every route declares an explicit `schema.operationId` — it becomes the derived MCP tool name.
- A resource outside the caller's tenant or OU scope reports **404**, never 403, with a message that does not distinguish "absent" from "forbidden".
- **One static SQL template per OU predicate.** Never branch the WHERE text at runtime. This anti-pattern was introduced and reverted once already in D1 — do not reintroduce it.
- No PostgreSQL-only value generation in SQLite-tested paths: `CURRENT_TIMESTAMP`, never `NOW()`; PHP-generated UUIDs, never `gen_random_uuid()`; no `::jsonb` casts.
- `host/.core/` is gitignored, pinned, and **never patched**.
- `AuditLogger` is not container-registered — construct it directly: `new \Whity\Core\Audit\AuditLogger($pdo)`.

### Verified facts — do not re-derive or guess these

Each cost a fix round in D1 when assumed. All confirmed by reading the real source on 2026-08-11.

- **`ToolDeriver::buildInputSchema()`** merges three sources into one flat schema: path parameters (**unconditionally required** — the loop appends every one to `required` with no condition), query parameters from `schema['parameters']` with `in: 'query'` (**required only if declared so**), and the request body from `schema['request']` (a component name string or an inline array), merged flat with the component's own `required` respected. This is *why* identifiers must leave the path.
- **`OuScopeResolver::whereFragment()`** emits `= ANY(:scope)`, which is PostgreSQL-only and fails at `PDO::prepare()` under SQLite — before any binding, regardless of parameter values. Any handler calling it cannot be unit-tested on SQLite; its tests belong in `plugin/tests/TenantIsolationOuTest.php` (real Postgres). `ProjectsApiHandler` and `BoardApiHandler` have no SQLite test files for exactly this reason.
- **`Whity\Core\Request` and `Whity\Core\Response` are empty subclasses** of the SDK's `Whity\Sdk\Http\Request`/`Response` — "host-side aliases". Core's kernel constructs the subclass and hands it to SDK-typed plugin handlers, so at runtime a plugin already holds a core Request. A core Response can be returned straight from an SDK-typed method.
- **`HookManager::class` is container-registered** at `host/.core/public/index.php:318` via `\Whity\register_service()`, resolvable exactly like `Database::class`.
- **`OusApiHandler::__construct(PDO $db, HookManager $hookManager)`**, with `list/create/get/update/delete(Request, array $params)` returning core `Response`. Its mutations dispatch `ou.creating`, `ou.created`, `ou.updating`, `ou.updated`, `ou.deleting`, `ou.deleted` and `.async` variants — hooks core's own `AuditLogger` subscribes to. **Never write to `organizational_units` directly.**
- **`TenantContext` has no `getOuId()`/`getUserId()`.** The caller's OU and profile come from `$request->user->profile_id` plus `MembershipRepository::findByProfile(int $profileId, int $tenantId): ?array`. `TaskerPlugin::resolveCallerOu()` already does this and returns `array{resolved: bool, ouId: ?int}`; unresolvable means **403, fail closed**.
- **`lastInsertId()` under SQLite** does not resolve a `BIGSERIAL`-declared `id`. Every handler carries a private `idColumn()` returning `'rowid'` for SQLite and `'id'` otherwise. Reuse that pattern; do not invent a new one.
- **`dbTruthy()`** is the established boolean-read coercion (a bare `(bool)` cast on a Postgres `'f'` returns `true`). Present in `TasksApiHandler`, `MilestonesApiHandler`, `BoardApiHandler`.

### The original's exact contracts (the parity target)

Extracted from `V2/supabase/functions/mcp/index.ts` in the design repo (`c:\Projects\tasker`). 131 tools; 22 of our 34 already match by name.

- `complete_task { task_id }` — "Task UUID **or short ID** (e.g. TDE-31)"
- `get_project { project_id, include_notes? }` — "Project **prefix** (e.g. TDE), **slug**, or UUID"
- `list_tasks { project_id?, section_id?, status? }` — project_id optional, "falls back to **default project** if set"; status enum `pending|in_progress|done|all`
- `create_task { project_id, section_id?, text, detail?, … }` — flat, section optional
- `uncomplete_milestone { task_id, index }` — **positional**, because milestones were a jsonb array
- `move_task_to_group { task_id, group_id, section_id? }` — group_id nullable to un-group

**Prefix derivation** (`deriveProjectPrefix`, to mirror): uppercase the name, split on `[^A-Z]+`, drop empties. With ≥2 words take the first letter of the first 4 words; otherwise the first 4 characters of the single word. If the result is under 2 characters, use `(base + 'PRJ').slice(0,3)`. Cap at 5. Then try suffixes `'', X, Y, Z, A, B, C, D, E, F` as `base.slice(0, 5 - suffix.length) + suffix`, returning the first candidate of length 2–5 not already taken. Scoped per user in the original — **per tenant for us**.

**`short_id` allocation.** The original uses a `BEFORE INSERT` trigger taking `pg_advisory_xact_lock(hashtext(project_id::text))` then `SELECT COALESCE(MAX(short_id),0)+1`, and deliberately ships **no unique constraint** — its own migration comment explains that pre-existing duplicates from earlier races would block adding one. We start clean, so this plan does better and stays portable: **add `UNIQUE (project_id, short_id)` and allocate `MAX+1` with retry on unique violation.** The database enforces correctness rather than a lock, and it works under SQLite too — advisory locks and `FOR UPDATE` do not.

**Prerequisites:** `trunk` at `07a9fdf` or later. Docker Desktop running. `npm run setup` done. A reachable `tasker_test` Postgres database (`host/scripts/plugin-test.ps1` creates it when the container is up).

**Sequencing note — operational-first.** Tasks 1–9 are what make the surface usable. Tasks 10–11 (environment aliases, ranking) are genuinely cuttable if you need to move to data migration sooner. Task 12's parity test and Task 13's OU closure are not cuttable — the first is what proves the slice's central claim, the second is a security boundary.

---

### Task 1: `IdentifierResolver` — the foundation

Everything downstream assumes this is correct and OU-safe. It ships first, with its own tests, before any route depends on it.

**Files:**
- Create: `plugin/Access/IdentifierResolver.php`
- Test: `plugin/tests/Access/IdentifierResolverTest.php`

**Interfaces:**
- Consumes: `Tasker\Access\OuScopeResolver::scopeParams(PDO, int, ?int): array{unrestricted: bool, scope: list<int>}` and `::whereFragment(string $column): string` (Task 2 of the D1 plan, unchanged).
- Produces:
  - `IdentifierResolver::classify(string|int|null $raw): string` — returns one of `empty`, `integer`, `uuid`, `short_id`, `prefix`, `slug`, `malformed_short_id`. Pure, no database.
  - `IdentifierResolver::resolveProject(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw, ?int $defaultProjectId = null): ?int` — OU-scoped, returns the internal `tasker_projects.id` or null.
  - `IdentifierResolver::resolveTask(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw): ?int`
  - `IdentifierResolver::resolveSection(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw, ?int $projectId = null): ?int`
  - `IdentifierResolver::resolveGroup(PDO $db, int $tenantId, ?int $callerOuId, string|int|null $raw, ?int $sectionId = null): ?int`
  - `IdentifierResolver::resolveMilestone(PDO $db, int $tenantId, int $taskId, string|int|null $raw): ?int` — accepts an integer **index** (positional within the task's ordered milestones) or a UUID/id.

- [ ] **Step 1: Write the failing classification tests**

`classify()` is pure, so it is fully testable on SQLite (in fact with no database at all). Create `plugin/tests/Access/IdentifierResolverTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Access;

use PHPUnit\Framework\TestCase;
use Tasker\Access\IdentifierResolver;

final class IdentifierResolverTest extends TestCase
{
    /**
     * Precedence is fixed and documented: integer, UUID, short id, prefix,
     * slug. The first match wins. Ambiguity resolves silently rather than
     * erroring, so that a caller who works today keeps working.
     */
    public function testClassifiesEachIdentifierForm(): void
    {
        self::assertSame('empty', IdentifierResolver::classify(null));
        self::assertSame('empty', IdentifierResolver::classify(''));
        self::assertSame('empty', IdentifierResolver::classify('   '));

        self::assertSame('integer', IdentifierResolver::classify(42));
        self::assertSame('integer', IdentifierResolver::classify('42'));

        self::assertSame('uuid', IdentifierResolver::classify('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));

        self::assertSame('short_id', IdentifierResolver::classify('TDE-31'));
        self::assertSame('short_id', IdentifierResolver::classify('AB-1'));
        self::assertSame('short_id', IdentifierResolver::classify('ABCDE-9999'));

        self::assertSame('prefix', IdentifierResolver::classify('TDE'));
        self::assertSame('prefix', IdentifierResolver::classify('AB'));

        self::assertSame('slug', IdentifierResolver::classify('website-redesign'));
        self::assertSame('slug', IdentifierResolver::classify('backlog'));
    }

    public function testRejectsAMalformedShortIdRatherThanTreatingItAsASlug(): void
    {
        // TDE-abc looks like a short id and is not one. Silently falling
        // through to a slug lookup would turn a typo into a confusing 404;
        // this is the one case that earns a 400.
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-abc'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-0031x'));
    }

    public function testLowercasePrefixShapedInputIsASlugNotAPrefix(): void
    {
        // Prefixes are uppercase by construction (^[A-Z]{2,5}$). "tde" is a
        // plausible slug, so it must not be mistaken for prefix TDE.
        self::assertSame('slug', IdentifierResolver::classify('tde'));
    }

    public function testAnOverlongUppercaseTokenIsASlugNotAPrefix(): void
    {
        // 6+ uppercase letters cannot be a prefix (cap is 5).
        self::assertSame('slug', IdentifierResolver::classify('ABCDEF'));
    }

    public function testNegativeAndZeroIntegersAreNotValidIdentifiers(): void
    {
        self::assertSame('slug', IdentifierResolver::classify('-5'));
        self::assertSame('integer', IdentifierResolver::classify('0'));
    }
}
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Access\IdentifierResolver" not found`.

- [ ] **Step 3: Implement `classify()` and the resolver skeleton**

Create `plugin/Access/IdentifierResolver.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Access;

use PDO;

/**
 * Turns whatever an agent passes into an internal integer id.
 *
 * The original Tasker's agents do not send integer ids. They send UUIDs,
 * short ids like TDE-31, project prefixes, slugs, or nothing at all (falling
 * back to a default project). Preserving that contract is the whole point of
 * this slice, and this class is where it happens.
 *
 * PRECEDENCE is fixed and evaluated in order; the first match wins:
 *   1. integer          ^\d+$                -> id
 *   2. uuid             RFC 4122 shape       -> public_id
 *   3. short id         ^[A-Z]{2,5}-\d+$     -> project prefix + task short_id
 *   4. prefix           ^[A-Z]{2,5}$         -> project prefix
 *   5. slug             anything else        -> slug
 *   6. empty            null/''              -> caller's default project
 *
 * Ambiguity is ACCEPTED, not prevented: a project whose slug is "TDE" while
 * another's prefix is "TDE" resolves to the prefix match, silently. This is a
 * deliberate trade — deterministic and documented in each tool description,
 * rather than an ambiguity error that would break callers who work today.
 *
 * SCOPING is the security-critical part. Every resolution is tenant-scoped AND
 * OU-scoped via OuScopeResolver, using its single static SQL template. An
 * identifier that exists but sits outside the caller's scope resolves to null,
 * which callers turn into the same 404 as "absent" — so this can never be used
 * as an existence oracle.
 *
 * This matters more than it did in D1. Flattening routes removed the
 * structural enforcement point: /projects/{projectId}/sections forced a
 * project lookup, and that lookup carried the OU check. With project_id
 * optional, this class is the ONLY barrier between a caller and cross-OU data.
 */
final class IdentifierResolver
{
    private const UUID_PATTERN     = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const SHORT_ID_PATTERN = '/^[A-Z]{2,5}-\d+$/';
    private const PREFIX_PATTERN   = '/^[A-Z]{2,5}$/';

    /**
     * Which form is this? Pure — no database, no scoping. Callers use it to
     * decide which lookup to run, and to distinguish a malformed short id
     * (400) from a genuine miss (404).
     *
     * @return 'empty'|'integer'|'uuid'|'short_id'|'prefix'|'slug'|'malformed_short_id'
     */
    public static function classify(string|int|null $raw): string
    {
        if ($raw === null) {
            return 'empty';
        }

        $value = trim((string) $raw);
        if ($value === '') {
            return 'empty';
        }

        if (preg_match('/^\d+$/', $value) === 1) {
            return 'integer';
        }

        if (preg_match(self::UUID_PATTERN, $value) === 1) {
            return 'uuid';
        }

        if (preg_match(self::SHORT_ID_PATTERN, $value) === 1) {
            return 'short_id';
        }

        // Looks like a short id but is not one: PREFIX-<not digits>. Caught
        // before the slug fallback so a typo surfaces as 400, not a puzzling
        // 404 from a slug lookup that was never going to match.
        if (preg_match('/^[A-Z]{2,5}-/', $value) === 1) {
            return 'malformed_short_id';
        }

        if (preg_match(self::PREFIX_PATTERN, $value) === 1) {
            return 'prefix';
        }

        return 'slug';
    }
}
```

- [ ] **Step 4: Run to verify the classification tests pass**

```powershell
npm run plugin:test
```

Expected: PASS — all 6 `IdentifierResolverTest` cases.

- [ ] **Step 5: Add the OU-scoped project resolution**

Append to `IdentifierResolver`:

```php
    /**
     * Resolve a project identifier to tasker_projects.id, OU-scoped.
     *
     * $defaultProjectId is the caller's tasker_user_prefs.default_project_id
     * and is used only when $raw is empty — that is what makes project_id
     * optional on list_tasks and friends, matching the original.
     */
    public static function resolveProject(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $defaultProjectId = null
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty') {
            // Re-resolve the default through the same scoped query rather
            // than trusting the stored id: the project may have moved OU, or
            // been deleted, since the preference was set.
            return $defaultProjectId === null
                ? null
                : self::projectByColumn($db, $tenantId, $callerOuId, 'id', (string) $defaultProjectId);
        }

        if ($form === 'malformed_short_id') {
            return null;
        }

        // A short id names a TASK, but its leading segment names the project.
        if ($form === 'short_id') {
            [$prefix] = explode('-', $value, 2);
            return self::projectByColumn($db, $tenantId, $callerOuId, 'prefix', $prefix);
        }

        $column = match ($form) {
            'integer' => 'id',
            'uuid'    => 'public_id',
            'prefix'  => 'prefix',
            default   => 'slug',
        };

        return self::projectByColumn($db, $tenantId, $callerOuId, $column, $value);
    }

    /**
     * One static SQL template, parameterised by column name only.
     *
     * $column is NEVER caller-supplied — it comes from the match() above, so
     * interpolating it is safe. The tenant predicate and the OU fragment are
     * unconditional text, exactly as the architecture requires.
     */
    private static function projectByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $column,
        string $value
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('ou_id');

        $stmt = $db->prepare(
            "SELECT id FROM tasker_projects
             WHERE {$column} = :value AND tenant_id = :tenant_id AND {$ouClause}
             LIMIT 1"
        );
        $stmt->bindValue(':value', $value);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }
```

- [ ] **Step 6: Add task, section, group and milestone resolution**

Append to `IdentifierResolver`:

```php
    /**
     * Resolve a task identifier. A short id (TDE-31) resolves through its
     * project's prefix, so it is unambiguous across projects.
     */
    public static function resolveTask(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty' || $form === 'malformed_short_id') {
            return null;
        }

        if ($form === 'short_id') {
            [$prefix, $shortId] = explode('-', $value, 2);

            $projectId = self::projectByColumn($db, $tenantId, $callerOuId, 'prefix', $prefix);
            if ($projectId === null) {
                return null;
            }

            $stmt = $db->prepare(
                'SELECT id FROM tasker_tasks
                 WHERE project_id = :project_id AND short_id = :short_id AND tenant_id = :tenant_id
                 LIMIT 1'
            );
            $stmt->execute([
                ':project_id' => $projectId,
                ':short_id'   => (int) $shortId,
                ':tenant_id'  => $tenantId,
            ]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        // Tasks have no slug and no prefix, so anything else is an id or UUID.
        if ($form === 'prefix' || $form === 'slug') {
            return null;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';

        return self::taskByColumn($db, $tenantId, $callerOuId, $column, $value);
    }

    /**
     * Task lookup, OU-scoped by joining through to the owning project.
     *
     * Tasks carry no ou_id of their own — only tasker_projects does — so OU
     * scoping has to travel via project_id. Every identifier form must be
     * equally safe: it would be worse than useless if TDE-31 respected the OU
     * boundary while the same task's UUID walked straight past it, because the
     * boundary would appear to work in testing and leak in practice.
     */
    private static function taskByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $column,
        string $value
    ): ?int {
        $scope    = OuScopeResolver::scopeParams($db, $tenantId, $callerOuId);
        $ouClause = OuScopeResolver::whereFragment('p.ou_id');

        $stmt = $db->prepare(
            "SELECT t.id FROM tasker_tasks t
             JOIN tasker_projects p ON p.id = t.project_id
             WHERE t.{$column} = :value
               AND t.tenant_id = :tenant_id
               AND p.tenant_id = :tenant_id_p
               AND {$ouClause}
             LIMIT 1"
        );
        $stmt->bindValue(':value', $value);
        $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':tenant_id_p', $tenantId, PDO::PARAM_INT);
        $stmt->bindValue(':unrestricted', $scope['unrestricted'], PDO::PARAM_BOOL);
        $stmt->bindValue(':scope', '{' . implode(',', $scope['scope']) . '}');
        $stmt->execute();

        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    public static function resolveSection(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $projectId = null
    ): ?int {
        return self::resolveStructural($db, $tenantId, $callerOuId, $raw, 'tasker_sections', 'project_id', $projectId);
    }

    public static function resolveGroup(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        ?int $sectionId = null
    ): ?int {
        return self::resolveStructural($db, $tenantId, $callerOuId, $raw, 'tasker_groups', 'section_id', $sectionId);
    }

    /**
     * Sections and groups share a shape: id | public_id | slug, with slug
     * unique only within a parent, so a slug lookup needs that parent.
     */
    private static function resolveStructural(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string|int|null $raw,
        string $table,
        string $parentColumn,
        ?int $parentId
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'empty' || $form === 'malformed_short_id' || $form === 'short_id') {
            return null;
        }

        if ($form === 'slug' || $form === 'prefix') {
            // A slug is only unique within its parent; without one it is
            // genuinely ambiguous, so refuse rather than guess.
            if ($parentId === null) {
                return null;
            }

            $stmt = $db->prepare(
                "SELECT id FROM {$table}
                 WHERE slug = :slug AND {$parentColumn} = :parent_id AND tenant_id = :tenant_id
                 LIMIT 1"
            );
            $stmt->execute([
                ':slug'      => strtolower($value),
                ':parent_id' => $parentId,
                ':tenant_id' => $tenantId,
            ]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        $column = $form === 'uuid' ? 'public_id' : 'id';
        $stmt = $db->prepare(
            "SELECT id FROM {$table} WHERE {$column} = :value AND tenant_id = :tenant_id LIMIT 1"
        );
        $stmt->execute([':value' => $value, ':tenant_id' => $tenantId]);
        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    /**
     * Milestones accept an INDEX (positional, 0-based, within the task's
     * ordered milestones) as well as an id or UUID.
     *
     * The index form exists because the original stored milestones as a jsonb
     * array and its tools address them positionally
     * (uncomplete_milestone { task_id, index }). It is inherently racy under
     * concurrent reordering — two agents can have the same index land on
     * different rows — so tool descriptions state that ids are preferred.
     * Supported for compatibility, not recommended.
     */
    public static function resolveMilestone(
        PDO $db,
        int $tenantId,
        int $taskId,
        string|int|null $raw
    ): ?int {
        $form  = self::classify($raw);
        $value = trim((string) ($raw ?? ''));

        if ($form === 'uuid') {
            $stmt = $db->prepare(
                'SELECT id FROM tasker_milestones
                 WHERE public_id = :value AND task_id = :task_id AND tenant_id = :tenant_id LIMIT 1'
            );
            $stmt->execute([':value' => $value, ':task_id' => $taskId, ':tenant_id' => $tenantId]);
            $id = $stmt->fetchColumn();

            return $id === false ? null : (int) $id;
        }

        if ($form !== 'integer') {
            return null;
        }

        // An integer is ambiguous: a milestone id, or a position? Prefer the
        // id — it is stable — and fall back to the index only if no milestone
        // with that id belongs to this task.
        $byId = $db->prepare(
            'SELECT id FROM tasker_milestones
             WHERE id = :value AND task_id = :task_id AND tenant_id = :tenant_id LIMIT 1'
        );
        $byId->execute([':value' => (int) $value, ':task_id' => $taskId, ':tenant_id' => $tenantId]);
        $found = $byId->fetchColumn();
        if ($found !== false) {
            return (int) $found;
        }

        $ordered = $db->prepare(
            'SELECT id FROM tasker_milestones
             WHERE task_id = :task_id AND tenant_id = :tenant_id
             ORDER BY sort_order ASC, id ASC'
        );
        $ordered->execute([':task_id' => $taskId, ':tenant_id' => $tenantId]);
        /** @var list<int> $ids */
        $ids = array_map('intval', $ordered->fetchAll(PDO::FETCH_COLUMN));

        return $ids[(int) $value] ?? null;
    }

    /**
     * Shared id/public_id lookup for a child table, tenant-scoped.
     *
     * @param string $ouJoinColumn column on $table that reaches tasker_projects
     */
    private static function childByColumn(
        PDO $db,
        int $tenantId,
        ?int $callerOuId,
        string $table,
        string $column,
        string $value,
        string $ouJoinColumn
    ): ?int {
        $stmt = $db->prepare(
            "SELECT id FROM {$table} WHERE {$column} = :value AND tenant_id = :tenant_id LIMIT 1"
        );
        $stmt->execute([':value' => $value, ':tenant_id' => $tenantId]);
        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }
```

- [ ] **Step 7: Write the Postgres-backed scoping tests**

`resolveProject()` calls `whereFragment()`, so it cannot be prepared under SQLite. These belong in the real-Postgres suite. Add to `plugin/tests/TenantIsolationOuTest.php`:

```php
    public function testResolveProjectAcceptsEveryIdentifierFormWithinScope(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Tasker Dev Env');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'TDE', slug = 'tasker-dev-env' WHERE id = {$projectId}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();

        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, $projectId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, (string) $projectId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, $publicId));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, 'TDE'));
        self::assertSame($projectId, IdentifierResolver::resolveProject($this->pdo, 7, null, 'tasker-dev-env'));
    }

    public function testResolveProjectRefusesEveryFormAcrossATenantBoundary(): void
    {
        $foreign = $this->makeProjectDirect(9, null, 'Foreign Project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'FGN', slug = 'foreign-project' WHERE id = {$foreign}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$foreign}")->fetchColumn();

        // Caller is tenant 7. Every form must miss.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, $foreign));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, $publicId));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, 'FGN'));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, null, 'foreign-project'));
    }

    public function testResolveProjectRefusesEveryFormAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling Branch Project');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SBP', slug = 'sibling-branch-project' WHERE id = {$sibling}");
        $publicId = (string) $this->pdo->query("SELECT public_id FROM tasker_projects WHERE id = {$sibling}")->fetchColumn();

        // Caller restricted to OU 2 must not reach OU 3's project by ANY form.
        // This is the assertion that matters most in the whole slice: it is
        // what replaces the structural OU check that flattening removed.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, $sibling));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, $publicId));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, 'SBP'));
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, 'sibling-branch-project'));
    }

    public function testResolveProjectFallsBackToTheDefaultOnlyWhenInScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $mine    = $this->makeProjectDirect(7, 2, 'Mine');
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');

        // Empty identifier + an in-scope default resolves to it.
        self::assertSame($mine, IdentifierResolver::resolveProject($this->pdo, 7, 2, null, $mine));

        // A stale default pointing outside scope must NOT be honoured — the
        // stored id is re-checked through the same scoped query.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, null, $sibling));

        // No identifier and no default is simply a miss.
        self::assertNull(IdentifierResolver::resolveProject($this->pdo, 7, 2, null, null));
    }

    public function testResolveTaskAcceptsAShortIdAndRefusesItAcrossAnOuBoundary(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);

        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'SIB' WHERE id = {$sibling}");
        $sectionId = $this->makeSectionDirect(7, $sibling);
        $taskId    = $this->makeTaskDirect(7, $sibling, $sectionId, 'Hidden task');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 31 WHERE id = {$taskId}");

        // Tenant-root sees it.
        self::assertSame($taskId, IdentifierResolver::resolveTask($this->pdo, 7, null, 'SIB-31'));

        // A caller in sibling OU 2 must not, because the PROJECT is out of scope.
        self::assertNull(IdentifierResolver::resolveTask($this->pdo, 7, 2, 'SIB-31'));
    }
```

Add `use Tasker\Access\IdentifierResolver;` to that file's imports.

- [ ] **Step 8: Run the Postgres suite**

```powershell
npm run plugin:test
```

Expected: PASS with **0 skipped**. If the OU cases skip, `tasker_test` is unreachable — `plugin-test.ps1` creates it when the Postgres container is up, so start the host first. A skipped run here proves nothing.

- [ ] **Step 9: PHPStan**

```powershell
npm run plugin:stan
```

Expected: clean at level 6. `childByColumn()`'s `$ouJoinColumn` parameter is currently unused — either use it or drop it before committing; an unused private parameter is exactly the kind of thing that rots.

- [ ] **Step 10: Commit**

```bash
git add plugin/Access/IdentifierResolver.php plugin/tests/Access/IdentifierResolverTest.php plugin/tests/TenantIsolationOuTest.php
git commit -m "feat: OU-scoped identifier resolver accepting every original identifier form"
```

---

### Task 2: `short_id` allocation and `prefix` derivation

`short_id` is currently created, returned as `shortId` in every response, and never written — always null. The resolver's short-id form depends on it, so it lands second.

**Files:**
- Create: `plugin/Migrations/AddTaskerTaskShortIdUnique.php`
- Create: `plugin/Domain/ShortIdAllocator.php`
- Create: `plugin/Domain/PrefixDeriver.php`
- Test: `plugin/tests/Domain/PrefixDeriverTest.php`
- Test: `plugin/tests/TenantIsolationOuTest.php` (allocation under real Postgres)
- Modify: `plugin/Api/ProjectsApiHandler.php`, `plugin/Api/TasksApiHandler.php`, `plugin/TaskerPlugin.php`

**Interfaces:**
- Produces:
  - `PrefixDeriver::derive(PDO $db, int $tenantId, string $name): ?string` — mirrors the original's algorithm, tenant-scoped for collisions.
  - `ShortIdAllocator::allocate(PDO $db, int $tenantId, int $projectId): int` — next `short_id` for the project, retry-on-conflict.

- [ ] **Step 1: Write the failing prefix-derivation tests**

Pure logic apart from the collision check, so most of it runs on SQLite. Create `plugin/tests/Domain/PrefixDeriverTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Domain;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Domain\PrefixDeriver;

final class PrefixDeriverTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, prefix TEXT NULL)');
    }

    public function testTakesInitialsOfUpToFourWords(): void
    {
        self::assertSame('TDE', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
        self::assertSame('ABCD', PrefixDeriver::derive($this->pdo, 7, 'Alpha Beta Gamma Delta Epsilon'));
    }

    public function testUsesTheFirstFourCharactersOfASingleWord(): void
    {
        self::assertSame('TASK', PrefixDeriver::derive($this->pdo, 7, 'Tasker'));
    }

    public function testPadsAnOverShortBaseToAtLeastTwoCharacters(): void
    {
        // "A" -> base "A" is 1 char -> (A + PRJ).slice(0,3) = "APR"
        self::assertSame('APR', PrefixDeriver::derive($this->pdo, 7, 'A'));
    }

    public function testIgnoresNonLetters(): void
    {
        self::assertSame('WR', PrefixDeriver::derive($this->pdo, 7, 'Website 2.0 Redesign!'));
    }

    public function testSuffixesOnCollisionWithinTheTenant(): void
    {
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES (1, 7, 'TDE')");

        // TDE taken -> first free candidate from '', X, Y, Z, A..F
        self::assertSame('TDX', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testCollisionsAreScopedPerTenant(): void
    {
        // Another tenant holding TDE must not force a suffix here.
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES (1, 9, 'TDE')");

        self::assertSame('TDE', PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }

    public function testReturnsNullWhenEveryCandidateIsTaken(): void
    {
        $taken = ['TDE', 'TDX', 'TDY', 'TDZ', 'TDA', 'TDB', 'TDC', 'TDD', 'TDdummyE', 'TDF'];
        $id = 1;
        foreach (['TDE', 'TDX', 'TDY', 'TDZ', 'TDA', 'TDB', 'TDC', 'TDD', 'TDE2', 'TDF'] as $p) {
            $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, prefix) VALUES ({$id}, 7, '{$p}')");
            $id++;
        }

        // Every suffix candidate exhausted -> null, and the caller must cope
        // (a project without a prefix simply has no short ids).
        self::assertNull(PrefixDeriver::derive($this->pdo, 7, 'Tasker Dev Env'));
    }
}
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Domain\PrefixDeriver" not found`.

- [ ] **Step 3: Implement `PrefixDeriver`**

Create `plugin/Domain/PrefixDeriver.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Domain;

use PDO;

/**
 * Derives a project prefix (the TDE in TDE-31) from its name.
 *
 * Mirrors the original app's deriveProjectPrefix() so that a project imported
 * later gets the same prefix it had before, and so short ids agents already
 * know keep resolving. The original scopes collision checks per user; we scope
 * per tenant, which is the equivalent boundary here.
 */
final class PrefixDeriver
{
    /** @var list<string> */
    private const SUFFIXES = ['', 'X', 'Y', 'Z', 'A', 'B', 'C', 'D', 'E', 'F'];

    public static function derive(PDO $db, int $tenantId, string $name): ?string
    {
        $words = array_values(array_filter(preg_split('/[^A-Z]+/', strtoupper($name)) ?: []));

        $base = count($words) >= 2
            ? implode('', array_map(static fn (string $w): string => $w[0], array_slice($words, 0, 4)))
            : substr($words[0] ?? '', 0, 4);

        if (strlen($base) < 2) {
            $base = substr($base . 'PRJ', 0, 3);
        }
        $base = substr($base, 0, 5);

        $taken = self::takenPrefixes($db, $tenantId);

        foreach (self::SUFFIXES as $suffix) {
            $candidate = substr($base, 0, 5 - strlen($suffix)) . $suffix;
            $length    = strlen($candidate);

            if ($length >= 2 && $length <= 5 && !isset($taken[$candidate])) {
                return $candidate;
            }
        }

        // Every candidate taken. Null is a legitimate outcome: the project
        // simply has no prefix, and therefore no short ids.
        return null;
    }

    /**
     * @return array<string, true>
     */
    private static function takenPrefixes(PDO $db, int $tenantId): array
    {
        $stmt = $db->prepare(
            'SELECT prefix FROM tasker_projects WHERE tenant_id = :tenant_id AND prefix IS NOT NULL'
        );
        $stmt->execute([':tenant_id' => $tenantId]);

        $taken = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $prefix) {
            $taken[strtoupper((string) $prefix)] = true;
        }

        return $taken;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

```powershell
npm run plugin:test
```

Expected: PASS, all 7 `PrefixDeriverTest` cases. If `testReturnsNullWhenEveryCandidateIsTaken` fails, check the fixture prefixes actually collide with every generated candidate — adjust the fixture to the real candidate list rather than loosening the assertion.

- [ ] **Step 5: Write the migration adding the unique constraint**

Create `plugin/Migrations/AddTaskerTaskShortIdUnique.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Adds UNIQUE (project_id, short_id) — the constraint the original app
 * deliberately could NOT add.
 *
 * Its own migration comment explains why: earlier races had already produced
 * duplicate short_ids, so a unique index would have blocked creation, and it
 * settled for a per-project advisory lock inside a trigger instead.
 *
 * We start clean, so we take the stronger guarantee. With the constraint in
 * place, ShortIdAllocator can allocate MAX+1 and retry on conflict — the
 * database enforces correctness rather than a lock we might forget to take,
 * and it works identically under SQLite, which supports neither
 * pg_advisory_xact_lock nor SELECT ... FOR UPDATE.
 */
final class AddTaskerTaskShortIdUnique implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasker_tasks_project_short_id
             ON tasker_tasks (project_id, short_id)'
        );
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP INDEX IF EXISTS idx_tasker_tasks_project_short_id');
    }
}
```

A partial index excluding nulls is unnecessary: both engines treat NULLs as distinct in a unique index, so existing null `short_id` rows do not collide.

- [ ] **Step 6: Implement `ShortIdAllocator`**

Create `plugin/Domain/ShortIdAllocator.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Domain;

use PDO;
use PDOException;
use RuntimeException;

/**
 * Allocates the next per-project short_id.
 *
 * Correctness comes from UNIQUE (project_id, short_id) — see
 * AddTaskerTaskShortIdUnique. We compute MAX+1 and let the constraint reject
 * a race, then retry. That is portable across Postgres and SQLite, unlike the
 * original's pg_advisory_xact_lock, and unlike SELECT ... FOR UPDATE.
 *
 * Callers pass the allocated value into their own INSERT, so the retry loop
 * lives with the caller's insert rather than here — this class only computes
 * the next candidate. See TasksApiHandler::create() for the retry.
 */
final class ShortIdAllocator
{
    public const MAX_ATTEMPTS = 5;

    /**
     * The next candidate short_id for this project. Not reserved — the unique
     * constraint is what makes concurrent use safe.
     */
    public static function next(PDO $db, int $tenantId, int $projectId): int
    {
        $stmt = $db->prepare(
            'SELECT COALESCE(MAX(short_id), 0) + 1 FROM tasker_tasks
             WHERE project_id = :project_id AND tenant_id = :tenant_id'
        );
        $stmt->execute([':project_id' => $projectId, ':tenant_id' => $tenantId]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * Whether a PDOException is a unique-constraint violation, i.e. a lost
     * race worth retrying rather than a real failure.
     *
     * Postgres reports SQLSTATE 23505; SQLite reports 23000 with a message
     * naming the constraint. Both are checked because the plugin's tests run
     * on SQLite and production runs on Postgres.
     */
    public static function isRaceLoss(PDOException $e): bool
    {
        $sqlState = $e->errorInfo[0] ?? $e->getCode();

        if ((string) $sqlState === '23505') {
            return true;
        }

        return (string) $sqlState === '23000'
            && stripos($e->getMessage(), 'idx_tasker_tasks_project_short_id') !== false;
    }

    /**
     * @param callable(int): void $insert Receives the candidate short_id and
     *        performs the INSERT; must let PDOException propagate.
     */
    public static function withRetry(PDO $db, int $tenantId, int $projectId, callable $insert): int
    {
        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
            $candidate = self::next($db, $tenantId, $projectId);

            try {
                $insert($candidate);

                return $candidate;
            } catch (PDOException $e) {
                if (!self::isRaceLoss($e) || $attempt === self::MAX_ATTEMPTS) {
                    throw $e;
                }
                // Lost the race; recompute MAX+1 and try again.
            }
        }

        throw new RuntimeException('Exhausted short_id allocation attempts');
    }
}
```

- [ ] **Step 7: Wire allocation into task creation and prefix into project creation**

In `plugin/Api/TasksApiHandler.php`, replace `create()`'s single INSERT with an allocating one. Add `use Tasker\Domain\ShortIdAllocator;`, then:

```php
            $publicId = self::generateUuidV4();
            $shortId  = ShortIdAllocator::withRetry(
                $this->db,
                $tenantId,
                (int) $sectionRow['project_id'],
                function (int $candidate) use ($publicId, $tenantId, $sectionRow, $sectionId, $text, $priority, $createdBy): void {
                    $insert = $this->db->prepare(
                        'INSERT INTO tasker_tasks
                            (public_id, tenant_id, project_id, section_id, text, priority, status,
                             short_id, created_by, created_at, updated_at)
                         VALUES
                            (:public_id, :tenant_id, :project_id, :section_id, :text, :priority, :status,
                             :short_id, :created_by, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
                    );
                    $insert->execute([
                        ':public_id'  => $publicId,
                        ':tenant_id'  => $tenantId,
                        ':project_id' => $sectionRow['project_id'],
                        ':section_id' => $sectionId,
                        ':text'       => $text,
                        ':priority'   => $priority,
                        ':status'     => 'pending',
                        ':short_id'   => $candidate,
                        ':created_by' => $createdBy,
                    ]);
                }
            );
```

In `plugin/Api/ProjectsApiHandler.php`, derive a prefix when the caller does not supply one. Add `use Tasker\Domain\PrefixDeriver;` and, inside `create()` before the INSERT:

```php
        $prefix = null;
        if (is_array($decoded) && isset($decoded['prefix'])) {
            $prefix = strtoupper(trim((string) $decoded['prefix']));
            if (preg_match('/^[A-Z]{2,5}$/', $prefix) !== 1) {
                return Response::error('prefix must be 2-5 uppercase letters', 400);
            }
        } else {
            // Null is acceptable — the project then has no short ids.
            $prefix = PrefixDeriver::derive($this->db, $tenantId, $name);
        }
```

Add `prefix` to the INSERT's column list and bind `:prefix`.

Register the migration in `plugin/TaskerPlugin.php`'s `getMigrations()` after `CreateTaskerTasksTable::class`:

```php
            AddTaskerTaskShortIdUnique::class,
```

- [ ] **Step 8: Write the allocation test under real Postgres**

Add to `plugin/tests/TenantIsolationOuTest.php`:

```php
    public function testShortIdIsAllocatedSequentiallyPerProject(): void
    {
        $projectA = $this->makeProjectDirect(7, null, 'Project A');
        $projectB = $this->makeProjectDirect(7, null, 'Project B');
        $sectionA = $this->makeSectionDirect(7, $projectA);
        $sectionB = $this->makeSectionDirect(7, $projectB);

        $handler = new TasksApiHandler($this->pdo);

        $first  = json_decode($handler->create(7, $sectionA, 1, json_encode(['text' => 'A1']))->getBody(), true);
        $second = json_decode($handler->create(7, $sectionA, 1, json_encode(['text' => 'A2']))->getBody(), true);
        $other  = json_decode($handler->create(7, $sectionB, 1, json_encode(['text' => 'B1']))->getBody(), true);

        self::assertSame(1, $first['data']['shortId']);
        self::assertSame(2, $second['data']['shortId']);

        // Counters are per project, so B starts at 1 again.
        self::assertSame(1, $other['data']['shortId']);
    }

    public function testShortIdUniqueConstraintRejectsADuplicate(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Constraint Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId    = $this->makeTaskDirect(7, $projectId, $sectionId, 'First');
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$taskId}");

        $second = $this->makeTaskDirect(7, $projectId, $sectionId, 'Second');

        // Proves the constraint exists and bites — without it, the allocator's
        // retry would be pointless because nothing would ever reject a race.
        $this->expectException(\PDOException::class);
        $this->pdo->exec("UPDATE tasker_tasks SET short_id = 1 WHERE id = {$second}");
    }
```

- [ ] **Step 9: Run the suite and PHPStan**

```powershell
npm run plugin:test
npm run plugin:stan
```

Expected: PASS with 0 skipped; PHPStan clean.

- [ ] **Step 10: Verify against the live host**

```powershell
npm run host:up
npm run plugin:install
docker restart tasker_frankenphp
```

FrankenPHP's persistent worker does **not** pick up deployed plugin code without that restart; skipping it produces false results against stale code.

```powershell
$csrf = @{ 'X-Requested-With' = 'XMLHttpRequest' }
$pw = (Get-Content host/.env | Where-Object { $_ -match '^INITIAL_ADMIN_PASSWORD=' }) -replace '^INITIAL_ADMIN_PASSWORD=', ''
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri http://localhost:8010/api/v1/login -Method Post -ContentType 'application/json' -Headers $csrf -Body (@{email='admin@example.com'; password=$pw} | ConvertTo-Json) -WebSession $s | Out-Null

$p = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/projects -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"Short Id Demo"}' -WebSession $s
"prefix: $($p.data.prefix)"
docker exec tasker_postgres psql -U tasker -d tasker -c "SELECT id, name, prefix FROM tasker_projects WHERE id = $($p.data.id);"
```

Expected: `prefix` is `SID` (initials of "Short Id Demo"), not null. Then create a task in its Backlog section and confirm `shortId` is `1`, not null.

- [ ] **Step 11: Commit**

```bash
git add plugin/Domain plugin/Migrations/AddTaskerTaskShortIdUnique.php plugin/Api/TasksApiHandler.php plugin/Api/ProjectsApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: allocate short_id per project and derive project prefixes"
```

---

### Task 3: `tasker_user_prefs` and `__init_tasker_session`

This is what makes `project_id` genuinely optional — without a default-project notion, every "optional project_id" in the original contract has no fallback and becomes required in practice.

**Files:**
- Create: `plugin/Migrations/CreateTaskerUserPrefsTable.php`
- Create: `plugin/Api/SessionApiHandler.php`
- Create: `plugin/Domain/DirectivePlaybook.php`
- Test: `plugin/tests/Api/SessionApiHandlerTest.php`
- Modify: `plugin/TaskerPlugin.php`, `plugin/tests/TenantIsolationTest.php`

**Interfaces:**
- Produces:
  - `SessionApiHandler::init(int $tenantId, int $profileId): Response` — returns prefs plus the playbook; creates the prefs row on first call.
  - `SessionApiHandler::defaultProjectId(PDO $db, int $tenantId, int $profileId): ?int` — the lookup every other handler uses for the empty-identifier fallback.
  - `SessionApiHandler::setDefaultProject(int $tenantId, int $profileId, ?int $projectId): Response`
  - `DirectivePlaybook::text(): string` — a constant, not a database row.

- [ ] **Step 1: Write the failing tests**

Create `plugin/tests/Api/SessionApiHandlerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Api;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\Api\SessionApiHandler;
use Tasker\Migrations\CreateTaskerUserPrefsTable;

final class SessionApiHandlerTest extends TestCase
{
    private PDO $pdo;
    private SessionApiHandler $handler;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE tasker_projects (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT)');
        $this->pdo->exec("INSERT INTO tasker_projects (id, tenant_id, name) VALUES (100, 7, 'Mine'), (200, 9, 'Theirs')");
        (new CreateTaskerUserPrefsTable())->up($this->pdo);

        $this->handler = new SessionApiHandler($this->pdo);
    }

    public function testInitCreatesThePrefsRowOnFirstCallAndIsIdempotent(): void
    {
        $first = $this->handler->init(7, 3);
        self::assertSame(200, $first->getStatusCode());

        $this->handler->init(7, 3);

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM tasker_user_prefs')->fetchColumn();
        self::assertSame(1, $count, 'init must not create a second prefs row for the same tenant+profile');
    }

    public function testInitReturnsThePlaybookAndTheCurrentPrefs(): void
    {
        $payload = json_decode($this->handler->init(7, 3)->getBody(), true);

        self::assertArrayHasKey('directives', $payload['data']);
        self::assertNotSame('', trim((string) $payload['data']['directives']));
        self::assertNull($payload['data']['defaultProjectId']);
        self::assertFalse($payload['data']['localMode']);
    }

    public function testSetDefaultProjectAcceptsAProjectInTheCallersTenant(): void
    {
        $this->handler->init(7, 3);

        $response = $this->handler->setDefaultProject(7, 3, 100);

        self::assertSame(200, $response->getStatusCode());
        self::assertSame(100, SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testSetDefaultProjectRejectsAProjectFromAnotherTenant(): void
    {
        $this->handler->init(7, 3);

        $response = $this->handler->setDefaultProject(7, 3, 200);

        self::assertSame(404, $response->getStatusCode());
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testSetDefaultProjectAcceptsNullToClearIt(): void
    {
        $this->handler->init(7, 3);
        $this->handler->setDefaultProject(7, 3, 100);

        $response = $this->handler->setDefaultProject(7, 3, null);

        self::assertSame(200, $response->getStatusCode());
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
    }

    public function testDefaultProjectIsPerProfileNotPerTenant(): void
    {
        $this->handler->init(7, 3);
        $this->handler->init(7, 4);
        $this->handler->setDefaultProject(7, 3, 100);

        self::assertSame(100, SessionApiHandler::defaultProjectId($this->pdo, 7, 3));
        self::assertNull(SessionApiHandler::defaultProjectId($this->pdo, 7, 4));
    }
}
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run plugin:test
```

Expected: FAIL — `Class "Tasker\Migrations\CreateTaskerUserPrefsTable" not found`.

- [ ] **Step 3: Write the migration**

Create `plugin/Migrations/CreateTaskerUserPrefsTable.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Per-user Tasker preferences.
 *
 * whity-core has no per-user preference store to reuse:
 * GlobalSettingsRepository and TenantSettingsRepository are global and
 * per-tenant, and NotificationPreferenceRepository is notification-specific.
 * A default project is Tasker domain state anyway — "which project is this
 * user working in" is not a platform concern — so a plugin-owned table is the
 * right home.
 *
 * local_mode is declared now and left unconsumed: D4 owns it. Declaring it
 * here avoids a migration whose only purpose is adding one boolean later.
 */
final class CreateTaskerUserPrefsTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_user_prefs (
                id BIGSERIAL PRIMARY KEY,
                public_id UUID NOT NULL,
                tenant_id INTEGER NOT NULL,
                profile_id INTEGER NOT NULL,
                default_project_id BIGINT NULL REFERENCES tasker_projects(id) ON DELETE SET NULL,
                local_mode BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                CONSTRAINT tasker_user_prefs_public_id_unique UNIQUE (public_id),
                CONSTRAINT tasker_user_prefs_tenant_profile_unique UNIQUE (tenant_id, profile_id)
            )
        ');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasker_user_prefs_tenant_id ON tasker_user_prefs(tenant_id)');
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_user_prefs CASCADE');
    }
}
```

- [ ] **Step 4: Write the playbook constant**

Create `plugin/Domain/DirectivePlaybook.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * The directive playbook __init_tasker_session returns.
 *
 * A CONSTANT, deliberately, not a database row: this is versioned content
 * that must move in lockstep with the code whose behaviour it describes. A
 * row would let the two drift, and a playbook describing behaviour the code
 * no longer has is worse than none.
 *
 * Keep it short. The original's playbook grew to thousands of words, and a
 * directive nobody finishes reading is not a directive.
 */
final class DirectivePlaybook
{
    public static function text(): string
    {
        return <<<'TEXT'
        TASK LIFECYCLE
        Set a task to in_progress when you start it. Mark it done only when the
        work is genuinely and verifiably complete — otherwise leave it
        in_progress and say what remains.

        DURABLE WORK BELONGS HERE
        If a piece of work should outlive this session, or a human wants it
        persisted, reviewed or shared, create it as a task. Keep transient
        per-step notes in your own scratchpad — mirroring those here is noise.

        IDENTIFIERS
        Every tool accepting an id also accepts a UUID, a short id (TDE-31), a
        project prefix (TDE) or a slug. Omit project_id entirely to use your
        default project. Prefer stable ids over positional indexes.

        VERIFY BEFORE COMPLETE
        When a task's deliverable is checkable — a file, a passing test, a
        live endpoint — run the check and record what you observed. Never
        assert that something passed.
        TEXT;
    }
}
```

- [ ] **Step 5: Implement `SessionApiHandler`**

Create `plugin/Api/SessionApiHandler.php`:

```php
<?php

declare(strict_types=1);

namespace Tasker\Api;

use PDO;
use Tasker\Domain\DirectivePlaybook;
use Whity\Sdk\Http\Response;

/**
 * Session bootstrap and per-user preferences.
 *
 * __init_tasker_session is the original's mandated first call, returning the
 * user's preferences plus the directive playbook. Here it also lazily creates
 * the prefs row, so no separate registration step exists.
 */
final class SessionApiHandler
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * GET /api/tasker/session/init — idempotent.
     */
    public function init(int $tenantId, int $profileId): Response
    {
        try {
            $this->ensureRow($tenantId, $profileId);

            $stmt = $this->db->prepare(
                'SELECT default_project_id, local_mode FROM tasker_user_prefs
                 WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
            );
            $stmt->execute([':tenant_id' => $tenantId, ':profile_id' => $profileId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!is_array($row)) {
                return Response::error('Failed to initialise session', 500);
            }

            return Response::json([
                'data' => [
                    'defaultProjectId' => $row['default_project_id'] !== null ? (int) $row['default_project_id'] : null,
                    'localMode'        => self::dbTruthy($row['local_mode']),
                    'directives'       => DirectivePlaybook::text(),
                ],
            ], 200);
        } catch (\Throwable) {
            return Response::error('Failed to initialise session', 500);
        }
    }

    /**
     * PUT /api/tasker/session/default-project — body {project_id} or null.
     *
     * A project outside the caller's tenant is 404, never a distinguishable
     * error, matching every other lookup in this plugin.
     */
    public function setDefaultProject(int $tenantId, int $profileId, ?int $projectId): Response
    {
        if ($projectId !== null) {
            $check = $this->db->prepare(
                'SELECT id FROM tasker_projects WHERE id = :id AND tenant_id = :tenant_id'
            );
            $check->execute([':id' => $projectId, ':tenant_id' => $tenantId]);
            if ($check->fetch() === false) {
                return Response::error('Project not found', 404);
            }
        }

        try {
            $this->ensureRow($tenantId, $profileId);

            $stmt = $this->db->prepare(
                'UPDATE tasker_user_prefs
                 SET default_project_id = :project_id, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
            );
            $stmt->execute([
                ':project_id' => $projectId,
                ':tenant_id'  => $tenantId,
                ':profile_id' => $profileId,
            ]);

            return $this->init($tenantId, $profileId);
        } catch (\Throwable) {
            return Response::error('Failed to set the default project', 500);
        }
    }

    /**
     * The default-project lookup every other handler uses for its
     * empty-identifier fallback. Static so callers need no instance.
     */
    public static function defaultProjectId(PDO $db, int $tenantId, int $profileId): ?int
    {
        $stmt = $db->prepare(
            'SELECT default_project_id FROM tasker_user_prefs
             WHERE tenant_id = :tenant_id AND profile_id = :profile_id'
        );
        $stmt->execute([':tenant_id' => $tenantId, ':profile_id' => $profileId]);
        $value = $stmt->fetchColumn();

        return ($value === false || $value === null) ? null : (int) $value;
    }

    private function ensureRow(int $tenantId, int $profileId): void
    {
        $insert = $this->db->prepare(
            'INSERT INTO tasker_user_prefs (public_id, tenant_id, profile_id, created_at, updated_at)
             VALUES (:public_id, :tenant_id, :profile_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (tenant_id, profile_id) DO NOTHING'
        );
        $insert->execute([
            ':public_id'  => self::generateUuidV4(),
            ':tenant_id'  => $tenantId,
            ':profile_id' => $profileId,
        ]);
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * pdo_pgsql may return booleans as the strings 't'/'f', and (bool) 'f' is
     * TRUE in PHP. Mirrors the helper already in TasksApiHandler.
     */
    private static function dbTruthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }

        return !in_array(strtolower((string) $value), ['', '0', 'f', 'false', 'no'], true);
    }
}
```

- [ ] **Step 6: Run to verify it passes**

```powershell
npm run plugin:test
```

Expected: PASS, all 6 `SessionApiHandlerTest` cases.

- [ ] **Step 7: Wire the routes**

In `plugin/TaskerPlugin.php` add imports for `SessionApiHandler` and `CreateTaskerUserPrefsTable`, register the migration in `getMigrations()`, and add these routes:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/session/init',
                'handler' => [$this, 'initSession'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => '__init_tasker_session',
                    'summary' => 'First call of any Tasker session: preferences plus the directive playbook',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'Preferences and directives'],
                        403 => ['description' => 'Tenant context or caller identity could not be resolved'],
                    ],
                ],
            ],
            [
                'method' => 'PUT',
                'path' => '/api/tasker/session/default-project',
                'handler' => [$this, 'setDefaultProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => 'set_default_project',
                    'summary' => 'Set or clear the caller\'s default project',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'properties' => [
                            'project_id' => [
                                'type' => ['string', 'integer', 'null'],
                                'description' => 'Project UUID, prefix, slug or id. Null clears the default.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated preferences'],
                        404 => ['description' => 'Project not found in the caller\'s tenant'],
                    ],
                ],
            ],
```

Add the route methods, following the established `resolveCallerOu()` fail-closed pattern:

```php
    /**
     * GET /api/tasker/session/init
     *
     * @param array<string, string> $params
     */
    public function initSession(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $profileId = $this->callerProfileId($request);
        if ($profileId === null) {
            return Response::error('Caller identity is required', 403);
        }

        return (new SessionApiHandler($this->resolvePdo()))->init($tenantId, $profileId);
    }

    /**
     * PUT /api/tasker/session/default-project
     *
     * @param array<string, string> $params
     */
    public function setDefaultProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $profileId = $this->callerProfileId($request);
        if ($profileId === null) {
            return Response::error('Caller identity is required', 403);
        }

        $ou = $this->resolveCallerOu($request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        $raw = is_array($decoded) ? ($decoded['project_id'] ?? null) : null;

        $pdo = $this->resolvePdo();
        $projectId = $raw === null
            ? null
            : IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], is_scalar($raw) ? $raw : null);

        if ($raw !== null && $projectId === null) {
            return Response::error('Project not found', 404);
        }

        return (new SessionApiHandler($pdo))->setDefaultProject($tenantId, $profileId, $projectId);
    }
```

`callerProfileId()` already exists from D1's fix wave. Confirm its exact name by grepping `plugin/TaskerPlugin.php` before use — do not assume it.

- [ ] **Step 8: Extend the conformance registry**

In `plugin/tests/TenantIsolationTest.php`, add `'tasker_user_prefs' => 'Per-user Tasker preferences are per-tenant.'` to `tenantTableRegistry()` and `new CreateTaskerUserPrefsTable()` to `schemaMigrations()`.

- [ ] **Step 9: Run the suite, PHPStan, and verify live**

```powershell
npm run plugin:test
npm run plugin:stan
npm run plugin:install
docker restart tasker_frankenphp
```

Then confirm the session endpoint returns the playbook:

```powershell
Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/session/init -WebSession $s | ConvertTo-Json -Depth 5
```

- [ ] **Step 10: Commit**

```bash
git add plugin/Migrations/CreateTaskerUserPrefsTable.php plugin/Api/SessionApiHandler.php plugin/Domain/DirectivePlaybook.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: per-user prefs, default project and __init_tasker_session"
```

---

### Task 4: Flatten the project routes

The first flattening task establishes the pattern every later one repeats. Read it even if you are implementing Task 5 or 6.

**Files:**
- Modify: `plugin/Api/ProjectsApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Consumes: `IdentifierResolver` (Task 1), `SessionApiHandler::defaultProjectId()` (Task 3).
- Produces: handler signatures change from integer ids to raw identifiers — `ProjectsApiHandler::update(int $tenantId, ?int $callerOuId, string|int|null $rawProjectId, string $body): Response`, and likewise `delete()`. `list()` and `create()` keep their signatures.

- [ ] **Step 1: Replace the project route declarations**

In `plugin/TaskerPlugin.php`, replace the four project routes. Note what changes: `PATCH /projects/{id:\d+}` becomes `PATCH /projects` with `project_id` in the body; `DELETE` likewise. `list` gains declared query parameters so its filters appear in the derived tool.

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
                    'parameters' => [
                        [
                            'name' => 'environment_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Optional: only projects in this Environment (OU). Omit to see every Environment.',
                        ],
                    ],
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
                    'request' => [
                        'type' => 'object',
                        'required' => ['name'],
                        'properties' => [
                            'name' => ['type' => 'string', 'description' => 'Project name'],
                            'prefix' => ['type' => 'string', 'description' => 'Optional 2-5 uppercase letters for short ids (e.g. TDE). Derived from the name when omitted.'],
                            'environment_id' => ['type' => 'string', 'description' => 'Optional Environment (OU) to create the project in.'],
                            'context' => ['type' => 'object', 'description' => 'The project Foundation: goal, why, scope, definition_of_done and related keys.'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created project'],
                        400 => ['description' => 'name missing/empty/too long, or prefix malformed'],
                        422 => ['description' => 'environment_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/projects',
                'handler' => [$this, 'updateProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'update_project',
                    'summary' => 'Update a project\'s name, environment, prefix or sort order',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['project_id'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id.'],
                            'name' => ['type' => 'string'],
                            'prefix' => ['type' => 'string', 'description' => '2-5 uppercase letters, or null to clear.'],
                            'environment_id' => ['type' => 'string', 'description' => 'Move the project to this Environment (OU).'],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated project'],
                        400 => ['description' => 'A supplied field is invalid'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                        422 => ['description' => 'environment_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/projects',
                'handler' => [$this, 'deleteProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'delete_project',
                    'summary' => 'Delete a project and everything under it',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['project_id'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id.'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
```

- [ ] **Step 2: Rewrite the project route methods to resolve identifiers**

Replace `updateProject`/`deleteProject` in `plugin/TaskerPlugin.php`. The shape below repeats for every mutation in Tasks 5–7:

```php
    /**
     * PATCH /api/tasker/projects
     *
     * @param array<string, string> $params
     */
    public function updateProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $ou = $this->resolveCallerOu($request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $raw = $decoded['project_id'] ?? null;
        if (IdentifierResolver::classify(is_scalar($raw) ? $raw : null) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $pdo = $this->resolvePdo();
        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $ou['ouId'],
            is_scalar($raw) ? $raw : null,
            $this->defaultProjectIdFor($request, $tenantId)
        );

        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        return (new ProjectsApiHandler($pdo))->update($tenantId, $ou['ouId'], $projectId, $request->getBody());
    }
```

Add a shared private helper so the default-project fallback is written once:

```php
    /**
     * The caller's default project id, or null. Used as the empty-identifier
     * fallback so tools like list_tasks can be called with no arguments,
     * exactly as the original allows.
     */
    private function defaultProjectIdFor(Request $request, int $tenantId): ?int
    {
        $profileId = $this->callerProfileId($request);

        return $profileId === null
            ? null
            : SessionApiHandler::defaultProjectId($this->resolvePdo(), $tenantId, $profileId);
    }
```

`deleteProject` follows the identical shape, calling `->delete($tenantId, $ou['ouId'], $projectId)`.

`ProjectsApiHandler::update()`/`delete()` keep taking a resolved integer `$projectId`, so their internals do not change. Also accept `environment_id` as an alias for `ou_id` in `update()`/`create()`, resolving it through `IdentifierResolver` is unnecessary — OU ids are integers or UUIDs handled by core — so accept an integer or numeric string and validate through the existing `ouIsInCallersScope()`.

- [ ] **Step 3: Add the Postgres tests for the flattened contract**

Add to `plugin/tests/TenantIsolationOuTest.php`:

```php
    public function testUpdateProjectAcceptsAPrefixInsteadOfAnId(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Prefix Update');
        $this->pdo->exec("UPDATE tasker_projects SET prefix = 'PU' WHERE id = {$projectId}");

        $handler = new ProjectsApiHandler($this->pdo);
        $resolved = IdentifierResolver::resolveProject($this->pdo, 7, null, 'PU');
        self::assertSame($projectId, $resolved);

        $response = $handler->update(7, null, $resolved, json_encode(['name' => 'Renamed By Prefix']));
        self::assertSame(200, $response->getStatusCode());

        $name = (string) $this->pdo->query("SELECT name FROM tasker_projects WHERE id = {$projectId}")->fetchColumn();
        self::assertSame('Renamed By Prefix', $name);
    }
```

- [ ] **Step 4: Run the suite and PHPStan**

```powershell
npm run plugin:test
npm run plugin:stan
```

- [ ] **Step 5: Verify the derived tool shape changed**

```powershell
npm run plugin:install
docker restart tasker_frankenphp
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:tools
```

Expected: `update_project` now exposes `project_id`, `name`, `prefix`, `environment_id`, `sort_order` — not a bare `id`. `create_project` exposes `name`, `prefix`, `environment_id`, `context` rather than no properties at all. **Do not write the snapshot yet**; Task 14 regenerates it once, deliberately.

- [ ] **Step 6: Commit**

```bash
git add plugin/Api/ProjectsApiHandler.php plugin/TaskerPlugin.php plugin/tests/TenantIsolationOuTest.php
git commit -m "feat: flatten project routes onto flexible identifiers"
```

---

### Task 5: Flatten the section and group routes

**Files:**
- Modify: `plugin/Api/SectionsApiHandler.php`, `plugin/Api/GroupsApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Consumes: `IdentifierResolver`, `defaultProjectIdFor()` (Task 4).
- Produces: `list_sections` takes `project_id` as an optional query parameter; `create_section` takes it in the body; `update_section`/`delete_section` take `section_id`. Same for groups with `section_id`/`group_id`.

- [ ] **Step 1: Replace the section route declarations**

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/sections',
                'handler' => [$this, 'listSections'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_sections',
                    'summary' => 'List a project\'s sections',
                    'tags' => ['tasker'],
                    'parameters' => [
                        [
                            'name' => 'project_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The section list'],
                        404 => ['description' => 'Project not found, outside OU scope, or no default project set'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections',
                'handler' => [$this, 'createSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_section',
                    'summary' => 'Create a section within a project',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['name'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix, slug, UUID or id. Omit to use your default project.'],
                            'name' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created section'],
                        400 => ['description' => 'name missing, empty or too long'],
                        404 => ['description' => 'Project not found or outside OU scope'],
                        409 => ['description' => 'A section with this name already exists in the project'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/sections',
                'handler' => [$this, 'updateSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_section',
                    'summary' => 'Update a section\'s name, description, sort order or view preferences',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['section_id'],
                        'properties' => [
                            'section_id' => ['type' => 'string', 'description' => 'Section UUID, id, or slug (slug requires project_id).'],
                            'project_id' => ['type' => 'string', 'description' => 'Needed only when section_id is a slug.'],
                            'name' => ['type' => 'string'],
                            'description' => ['type' => ['string', 'null']],
                            'sort_order' => ['type' => 'integer'],
                            'view_prefs' => ['type' => 'object'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated section'],
                        400 => ['description' => 'A supplied field is invalid'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections/rename',
                'handler' => [$this, 'updateSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'rename_section',
                    'summary' => 'Rename a section (alias of update_section, preserved for existing agents)',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['section_id', 'name'],
                        'properties' => [
                            'section_id' => ['type' => 'string', 'description' => 'Section UUID, id, or slug (slug requires project_id).'],
                            'project_id' => ['type' => 'string', 'description' => 'Needed only when section_id is a slug.'],
                            'name' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The renamed section'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/sections',
                'handler' => [$this, 'deleteSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_section',
                    'summary' => 'Delete a section and its groups and tasks',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['section_id'],
                        'properties' => [
                            'section_id' => ['type' => 'string'],
                            'project_id' => ['type' => 'string', 'description' => 'Needed only when section_id is a slug.'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                        409 => ['description' => 'Cannot delete a project\'s last remaining section'],
                    ],
                ],
            ],
```

Note `rename_section` and `update_section` point at the **same handler method** but different paths — two `operationId`s cannot share one route, and the router would reject a duplicate method+path.

- [ ] **Step 2: Replace the group route declarations**

Mirror the section shape exactly, with `group_id`/`section_id` in place of `section_id`/`project_id`, `operationId`s `list_groups`, `create_group`, `update_group`, `rename_group` (at `POST /api/tasker/groups/rename`), `delete_group`, and permission `tasker_structure:manage` throughout. `list_groups` declares `section_id` as an **optional** query parameter and must 404 when it resolves to nothing — the existence check added in D1's Task 4 fix round stays.

- [ ] **Step 3: Rewrite the six route methods**

Each follows Task 4 Step 2's shape: resolve tenant, fail closed on unresolved OU, reject a malformed short id with 400, resolve the identifier, 404 on null, delegate to the handler with the resolved integer. Section and group slug resolution needs the parent, so pass the resolved `project_id`/`section_id` as `IdentifierResolver::resolveSection()`'s fifth argument when the body supplies one.

For `listSections`, the project is optional and falls back to the default:

```php
    /**
     * GET /api/tasker/sections?project_id=
     *
     * @param array<string, string> $params
     */
    public function listSections(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $ou = $this->resolveCallerOu($request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $request->getQueryParam('project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $pdo = $this->resolvePdo();
        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $ou['ouId'],
            $raw,
            $this->defaultProjectIdFor($request, $tenantId)
        );

        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        return (new SectionsApiHandler($pdo))->list($tenantId, $projectId);
    }
```

**Verify the query-parameter accessor before using it.** `$request->getQueryParam('project_id')` is this plan's best inference from the SDK's Request. Grep `host/.core/sdk/src/Http/Request.php` for its real accessor (it may be `query()`, `getQuery()`, or a `$request->query` array) and use whatever exists. Guessing an accessor name is precisely the class of assumption that cost D1 several fix rounds.

- [ ] **Step 4: Run the suite and PHPStan; verify the derived shapes**

```powershell
npm run plugin:test
npm run plugin:stan
npm run plugin:install
docker restart tasker_frankenphp
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:tools
```

Expected: `list_sections` exposes an optional `project_id`; `create_section` exposes `project_id` and `name`; `rename_section` and `rename_group` appear as tools.

- [ ] **Step 5: Commit**

```bash
git add plugin/Api/SectionsApiHandler.php plugin/Api/GroupsApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: flatten section and group routes, add rename_* aliases"
```

---

### Task 6: Flatten the task routes

The largest surface: eleven routes, and the ones agents call most.

**Files:**
- Modify: `plugin/Api/TasksApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`, `plugin/tests/Api/TasksApiHandlerTest.php`

**Interfaces:**
- Produces: `list_tasks` takes optional `project_id`, `section_id`, `group_id` and `status` query parameters (status enum `pending|in_progress|done|all`); `create_task` takes `project_id?`, `section_id?`, `text`, `detail?`, `priority?`, `due_date?` in the body; `complete_task`/`uncomplete_task`/`pin_task`/`unpin_task`/`delete_task` take `{task_id}`; `update_task` takes `{task_id, text?, detail?, priority?, due_date?}`; `move_task` takes `{task_id, section_id?, group_id?, sort_order?}`.
- Also produces `TasksApiHandler::listFiltered(int $tenantId, ?int $projectId, ?int $sectionId, ?int $groupId, string $status): Response` — replacing `listForSection()`, because the original's `list_tasks` filters by project, section, group and status rather than requiring a section.

- [ ] **Step 1: Write the failing test for the new filtered list**

The original's `list_tasks` defaults to excluding done tasks and accepts `all`. Add to `plugin/tests/Api/TasksApiHandlerTest.php`:

```php
    public function testListFilteredExcludesDoneByDefaultAndIncludesItOnAll(): void
    {
        $open = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Open']))->getBody(), true);
        $done = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Done']))->getBody(), true);
        $this->handler->complete(7, (int) $done['data']['id']);

        $default = json_decode($this->handler->listFiltered(7, null, 1, null, 'pending')->getBody(), true);
        self::assertCount(1, $default['data']);
        self::assertSame('Open', $default['data'][0]['text']);

        $all = json_decode($this->handler->listFiltered(7, null, 1, null, 'all')->getBody(), true);
        self::assertCount(2, $all['data']);
    }

    public function testListFilteredByProjectSpansEverySectionOfThatProject(): void
    {
        $this->pdo->exec("INSERT INTO tasker_sections (id, tenant_id, project_id) VALUES (3, 7, 100)");
        $this->handler->create(7, 1, 3, json_encode(['text' => 'In section 1']));
        $this->handler->create(7, 3, 3, json_encode(['text' => 'In section 3']));

        $payload = json_decode($this->handler->listFiltered(7, 100, null, null, 'all')->getBody(), true);

        self::assertCount(2, $payload['data']);
    }
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run plugin:test
```

Expected: FAIL — `Call to undefined method Tasker\Api\TasksApiHandler::listFiltered()`.

- [ ] **Step 3: Implement `listFiltered()`**

Add to `plugin/Api/TasksApiHandler.php`. Every filter is optional, so the SQL is assembled from an array of conditions — but note the tenant predicate is **unconditional text**, never part of the optional set, which is what keeps the predicate scanner satisfied:

```php
    /**
     * GET /api/tasker/tasks — the original's list_tasks contract.
     *
     * project_id, section_id and group_id are all optional filters; status
     * defaults to excluding done. The tenant predicate is unconditional text
     * and is never part of the optional conditions.
     *
     * @param 'pending'|'in_progress'|'done'|'all' $status
     */
    public function listFiltered(
        int $tenantId,
        ?int $projectId,
        ?int $sectionId,
        ?int $groupId,
        string $status = 'pending'
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
        if ($status !== 'all') {
            $conditions[] = 'status = :status';
            $params[':status'] = $status;
        }

        $extra = $conditions === [] ? '' : ' AND ' . implode(' AND ', $conditions);

        try {
            $stmt = $this->db->prepare(
                "SELECT id, public_id, tenant_id, project_id, section_id, group_id, text, detail, status, priority,
                        due_date, pinned, pinned_at, sort_order, completed_at, short_id, created_by, created_at, updated_at
                 FROM tasker_tasks
                 WHERE tenant_id = :tenant_id{$extra}
                 ORDER BY sort_order ASC, id ASC"
            );
            $stmt->execute($params);

            /** @var array<int, array<string, mixed>> $rows */
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return Response::json(['data' => array_map([$this, 'toPublicTask'], $rows)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to fetch tasks', 500);
        }
    }
```

Keep `listForSection()` as a thin wrapper so nothing that already calls it breaks:

```php
    public function listForSection(int $tenantId, int $sectionId): Response
    {
        return $this->listFiltered($tenantId, null, $sectionId, null, 'all');
    }
```

- [ ] **Step 4: Run to verify the new tests pass**

```powershell
npm run plugin:test
```

- [ ] **Step 5: Replace the eleven task route declarations**

Full declarations for the two most-used, to be followed for the rest:

```php
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks',
                'handler' => [$this, 'listTasks'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'list_tasks',
                    'summary' => 'List tasks, filtered by project, section, group or status',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'project_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.'],
                        ['name' => 'section_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Section UUID or id.'],
                        ['name' => 'group_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Group UUID or id.'],
                        ['name' => 'status', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string', 'enum' => ['pending', 'in_progress', 'done', 'all']], 'description' => 'Defaults to excluding done tasks. Pass "all" to include everything.'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The task list'],
                        404 => ['description' => 'A supplied filter did not resolve in scope'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks',
                'handler' => [$this, 'createTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'create_task',
                    'summary' => 'Create a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['text'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix, slug, UUID or id. Omit to use your default project.'],
                            'section_id' => ['type' => 'string', 'description' => 'Optional. Defaults to the project\'s Backlog section.'],
                            'text' => ['type' => 'string', 'description' => 'Task title'],
                            'detail' => ['type' => 'string', 'description' => 'Context. Write so a cold reader with no chat history can act on this task alone.'],
                            'priority' => ['type' => 'string', 'enum' => ['rush', 'high', 'medium', 'low']],
                            'due_date' => ['type' => 'string', 'description' => 'ISO date YYYY-MM-DD'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created task'],
                        400 => ['description' => 'text missing/empty/too long, or priority invalid'],
                        404 => ['description' => 'Project or section not found in scope'],
                    ],
                ],
            ],
```

The remaining nine — `update_task`, `move_task`, `delete_task`, `complete_task`, `uncomplete_task`, `pin_task`, `unpin_task`, `tag_task`, `get_ready_work` — move to body-carried `task_id` at these paths: `PATCH /api/tasker/tasks`, `POST /api/tasker/tasks/move`, `DELETE /api/tasker/tasks`, `POST /api/tasker/tasks/complete`, `POST /api/tasker/tasks/uncomplete`, `POST /api/tasker/tasks/pin`, `POST /api/tasker/tasks/unpin`, `POST /api/tasker/tasks/tags`, `GET /api/tasker/ready-work?project_id=`. Each declares `task_id` as required with the description **"Task UUID or short ID (e.g. TDE-31)"**, matching the original verbatim.

`create_task`'s `section_id` being optional is new behaviour: when omitted, default to the project's Backlog section (`slug = 'backlog'`). The original says "Task is ungrouped if omitted", but our `section_id` is NOT NULL by design, so Backlog is the equivalent. Implement that fallback in `createTask`'s route method, and 404 if the project has no `backlog` section — which cannot happen for projects created through `create_project`, but can for imported ones.

- [ ] **Step 6: Rewrite the eleven route methods, run the suite, verify shapes**

Same shape as Task 4 Step 2 throughout. Then:

```powershell
npm run plugin:test
npm run plugin:stan
npm run plugin:install
docker restart tasker_frankenphp
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:tools
```

Expected: `complete_task` exposes exactly `task_id`; `create_task` exposes `project_id`, `section_id`, `text`, `detail`, `priority`, `due_date`.

- [ ] **Step 7: Fix `move()`'s supplied-vs-changed `section_id` bug (carry-over)**

A D1 carry-over item, fixed here because `move()` is being rewritten anyway. Currently:

```php
$sectionChanging = array_key_exists('section_id', $decoded);
```

That is *supplied*, not *changed*. So `{"task_id": "TDE-31", "section_id": <the task's current section>, "sort_order": 5}` — a plain reorder that echoes the current section, which is exactly what a drag-and-drop client sends — silently un-groups a grouped task. The docblock says "when section_id **changes**"; the code does not implement that.

Fix:

```php
        $sectionChanging = array_key_exists('section_id', $decoded)
            && (int) $decoded['section_id'] !== (int) $row['section_id'];
```

Write the failing test first, in `plugin/tests/Api/TasksApiHandlerTest.php`:

```php
    public function testMoveKeepsTheGroupWhenSectionIdIsEchoedUnchanged(): void
    {
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS tasker_groups (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, section_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (1, 7, 1)');
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Grouped']))->getBody(), true);
        $taskId = (int) $created['data']['id'];
        $this->handler->move(7, $taskId, json_encode(['section_id' => 1, 'group_id' => 1]));

        // A reorder that echoes the CURRENT section must not un-group.
        $payload = json_decode($this->handler->move(7, $taskId, json_encode(['section_id' => 1, 'sort_order' => 5]))->getBody(), true);

        self::assertSame(1, $payload['data']['groupId'], 'echoing the current section_id must not clear group_id');
        self::assertSame(5, $payload['data']['sortOrder']);
    }
```

Confirm it fails before applying the one-line fix. D2's drag-and-drop is the first client that would hit this, so it must be closed before D2 rather than discovered there.

- [ ] **Step 8: Clean up `entity_tags` on task delete (carry-over)**

Deleting a tagged task currently orphans its `entity_tags` rows. The bumped core provides the cleanup, and this is the moment to use it:

```php
use Whity\Core\Taxonomy\EntityTagRepository;
```

In `TasksApiHandler::delete()`, before the `DELETE` statement:

```php
            // Core's opt-in cleanup. Without it a deleted task leaves
            // entity_tags rows pointing at an id that no longer exists —
            // harmless today, but it accumulates and would confuse any later
            // tag-usage reporting.
            (new EntityTagRepository($this->db))->detachAll($tenantId, 'tasker_task', $taskId);
```

Verify the real signature first — this plan records it as `detachAll(int $tenantId, string $entityType, int $entityId): int` from reading `host/.core/src/Core/Taxonomy/EntityTagRepository.php`, but confirm before wiring.

Add a test proving no orphan survives:

```php
    public function testDeleteRemovesTheTasksEntityTagRows(): void
    {
        $this->pdo->exec('
            CREATE TABLE entity_tags (
                tenant_id INTEGER NOT NULL, entity_type VARCHAR(128) NOT NULL, entity_id BIGINT NOT NULL,
                tag_id BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                PRIMARY KEY (entity_type, entity_id, tag_id)
            )
        ');
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Tagged then deleted']))->getBody(), true);
        $taskId = (int) $created['data']['id'];
        $this->pdo->exec("INSERT INTO entity_tags (tenant_id, entity_type, entity_id, tag_id) VALUES (7, 'tasker_task', {$taskId}, 11)");

        $this->handler->delete(7, $taskId);

        $orphans = (int) $this->pdo->query("SELECT COUNT(*) FROM entity_tags WHERE entity_type = 'tasker_task' AND entity_id = {$taskId}")->fetchColumn();
        self::assertSame(0, $orphans);
    }
```

Note `EntityTagRepository::attach()` needed the `NOW()` SQLite shim, so `detachAll()` may too — call `SqlitePolyfills::registerNowFunction($this->pdo)` in `setUp()` if the test hits "no such function: NOW".

Apply the same cleanup to `PingApiHandler::delete()` if one exists; if pings have no delete route, note that and move on rather than adding one.

- [ ] **Step 9: Prove a short id works end to end against the live host**

```powershell
$p = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/projects -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"name":"Short Id Flow","prefix":"SIF"}' -WebSession $s
$t = Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/tasks -Method Post -ContentType 'application/json' -Headers $csrf -Body '{"project_id":"SIF","text":"Complete me by short id"}' -WebSession $s
"shortId: $($t.data.shortId)"
Invoke-RestMethod -Uri http://localhost:8010/api/v1/tasker/tasks/complete -Method Post -ContentType 'application/json' -Headers $csrf -Body (@{task_id="SIF-$($t.data.shortId)"} | ConvertTo-Json) -WebSession $s
```

Expected: the task is created via a **project prefix** and completed via a **short id**. This is the slice's headline capability; if it fails, stop and fix before continuing.

- [ ] **Step 10: Commit**

```bash
git add plugin/Api/TasksApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: flatten task routes, filters, short ids; fix move() and tag cleanup"
```

---

### Task 7: Flatten the milestone, discussion and board routes

**Files:**
- Modify: `plugin/Api/MilestonesApiHandler.php`, `plugin/Api/TaskDiscussionsApiHandler.php`, `plugin/Api/BoardApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/Api/MilestonesApiHandlerTest.php`, `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Produces: `list_milestones`/`add_milestone` take `{task_id}`; `complete_milestone`/`update_milestone`/`delete_milestone` take `{task_id, milestone_id | index}`; `get_task_discussion`/`set_task_discussion` take `{task_id}`; `get_board` takes `project_id` as an optional query parameter.
- Also produces `MilestonesApiHandler::setChecked(int $tenantId, int $milestoneId, bool $checked): Response`, replacing the pure `toggle()` — because the original has *both* `complete_milestone` and `uncomplete_milestone`, which a toggle cannot express.

- [ ] **Step 1: Write the failing test for explicit set rather than toggle**

D1 implemented `toggle()` and mapped `complete_milestone` onto it. That was wrong: the original has separate complete and uncomplete tools, and a toggle makes `complete_milestone` non-idempotent — calling it twice un-completes. Add to `plugin/tests/Api/MilestonesApiHandlerTest.php`:

```php
    public function testCompleteIsIdempotentRatherThanAToggle(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Idempotent']))->getBody(), true);
        $id = (int) $created['data']['id'];

        $first  = json_decode($this->handler->setChecked(7, $id, true)->getBody(), true);
        $second = json_decode($this->handler->setChecked(7, $id, true)->getBody(), true);

        self::assertTrue($first['data']['checked']);
        self::assertTrue($second['data']['checked'], 'complete_milestone twice must stay complete, not flip back');
    }

    public function testUncompleteSetsCheckedFalse(): void
    {
        $created = json_decode($this->handler->create(7, 1, json_encode(['summary' => 'Reopen me']))->getBody(), true);
        $id = (int) $created['data']['id'];
        $this->handler->setChecked(7, $id, true);

        $payload = json_decode($this->handler->setChecked(7, $id, false)->getBody(), true);

        self::assertFalse($payload['data']['checked']);
    }
```

- [ ] **Step 2: Run to verify failure, then implement `setChecked()`**

```powershell
npm run plugin:test
```

Expected: FAIL — undefined method `setChecked()`. Then add to `MilestonesApiHandler`:

```php
    /**
     * Set a milestone's checked state explicitly.
     *
     * Replaces D1's toggle(). The original exposes complete_milestone AND
     * uncomplete_milestone as separate tools, so a toggle cannot express the
     * contract — and it makes complete_milestone non-idempotent, which is
     * worse than merely inconvenient for an agent that retries.
     */
    public function setChecked(int $tenantId, int $milestoneId, bool $checked): Response
    {
        try {
            $stmt = $this->db->prepare(
                "UPDATE tasker_milestones SET checked = :checked
                 WHERE {$this->idColumn()} = :id AND tenant_id = :tenant_id"
            );
            $stmt->bindValue(':checked', $checked, PDO::PARAM_BOOL);
            $stmt->bindValue(':id', $milestoneId, PDO::PARAM_INT);
            $stmt->bindValue(':tenant_id', $tenantId, PDO::PARAM_INT);
            $stmt->execute();

            if ($stmt->rowCount() === 0) {
                return Response::error('Milestone not found', 404);
            }

            $row = $this->findScoped($milestoneId, $tenantId);
            if ($row === null) {
                return Response::error('Milestone not found', 404);
            }

            return Response::json(['data' => $this->toPublicMilestone($row)], 200);
        } catch (\Throwable) {
            return Response::error('Failed to update milestone', 500);
        }
    }
```

Bind `:checked` with `PDO::PARAM_BOOL` explicitly — array-`execute()` binds `false` as an empty string, which Postgres rejects for a boolean column. That exact bug made `unpin()` return 500 in D1 and was only caught in review.

Keep `toggle()` as a wrapper reading current state then calling `setChecked()`, so nothing already calling it breaks.

- [ ] **Step 3: Replace the route declarations**

`complete_milestone` and `uncomplete_milestone` become separate routes at `POST /api/tasker/milestones/complete` and `POST /api/tasker/milestones/uncomplete`, both taking:

```php
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'milestone_id' => ['type' => 'string', 'description' => 'Milestone UUID or id. Preferred over index — stable under reordering.'],
                            'index' => ['type' => 'integer', 'description' => 'Zero-based position within the task\'s milestones. Supported for compatibility; racy if milestones are being reordered concurrently.'],
                        ],
                    ],
```

Resolve with `IdentifierResolver::resolveMilestone($pdo, $tenantId, $taskId, $decoded['milestone_id'] ?? $decoded['index'] ?? null)`.

`get_board` moves to `GET /api/tasker/board?project_id=` with `project_id` optional (default-project fallback). `get_task_discussion`/`set_task_discussion` move to `GET`/`PUT /api/tasker/tasks/discussion` with `task_id` in the query and body respectively.

- [ ] **Step 4: Run the suite, PHPStan, verify shapes, commit**

```powershell
npm run plugin:test
npm run plugin:stan
```

```bash
git add plugin/Api/MilestonesApiHandler.php plugin/Api/TaskDiscussionsApiHandler.php plugin/Api/BoardApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: flatten milestone/discussion/board routes, split complete and uncomplete"
```

---

### Task 8: `get_project` and `get_task`

Two single-resource reads the original has and D1 omitted entirely.

**Files:**
- Modify: `plugin/Api/ProjectsApiHandler.php`, `plugin/Api/TasksApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`, `plugin/tests/Api/TasksApiHandlerTest.php`

**Interfaces:**
- Produces: `ProjectsApiHandler::getOne(int $tenantId, ?int $callerOuId, int $projectId, bool $includeNotes): Response` and `TasksApiHandler::getOne(int $tenantId, int $taskId): Response`.

- [ ] **Step 1: Write the failing tests**

The original's `get_project` returns the project plus its sections and tasks, with `include_notes` controlling whether each task's `detail` is inlined — because on a large project that is very large. Add to `plugin/tests/TenantIsolationOuTest.php`:

```php
    public function testGetProjectOmitsTaskDetailUnlessIncludeNotesIsSet(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Notes Project');
        $sectionId = $this->makeSectionDirect(7, $projectId);
        $taskId    = $this->makeTaskDirect(7, $projectId, $sectionId, 'Has detail');
        $this->pdo->exec("UPDATE tasker_tasks SET detail = 'the long detail' WHERE id = {$taskId}");

        $handler = new ProjectsApiHandler($this->pdo);

        $without = json_decode($handler->getOne(7, null, $projectId, false)->getBody(), true);
        $task = $without['data']['sections'][0]['tasks'][0];
        self::assertArrayNotHasKey('detail', $task, 'detail must be omitted by default — it can be very large');

        $with = json_decode($handler->getOne(7, null, $projectId, true)->getBody(), true);
        self::assertSame('the long detail', $with['data']['sections'][0]['tasks'][0]['detail']);
    }

    public function testGetProjectIs404OutsideOuScope(): void
    {
        $this->makeOu(1, 7, null);
        $this->makeOu(2, 7, 1);
        $this->makeOu(3, 7, 1);
        $sibling = $this->makeProjectDirect(7, 3, 'Sibling');

        $handler = new ProjectsApiHandler($this->pdo);

        self::assertSame(404, $handler->getOne(7, 2, $sibling, false)->getStatusCode());
    }
```

And to `plugin/tests/Api/TasksApiHandlerTest.php`:

```php
    public function testGetOneReturnsTheTaskWithItsMilestones(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_milestones (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, task_id INTEGER NOT NULL, summary TEXT, detail TEXT NULL, checked BOOLEAN NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0)');
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'With milestones']))->getBody(), true);
        $taskId = (int) $created['data']['id'];
        $this->pdo->exec("INSERT INTO tasker_milestones (id, tenant_id, task_id, summary, checked, sort_order) VALUES (1, 7, {$taskId}, 'Step one', 0, 1)");

        $payload = json_decode($this->handler->getOne(7, $taskId)->getBody(), true);

        self::assertSame('With milestones', $payload['data']['text']);
        self::assertCount(1, $payload['data']['milestones']);
        self::assertSame('Step one', $payload['data']['milestones'][0]['summary']);
    }

    public function testGetOneIs404ForATaskOutsideTheCallersTenant(): void
    {
        self::assertSame(404, $this->handler->getOne(9, 99999)->getStatusCode());
    }
```

- [ ] **Step 2: Run to verify failure, implement both, run to verify pass**

`ProjectsApiHandler::getOne()` reuses the existing `findScoped()` for the OU-scoped project lookup, then composes sections and tasks much as `BoardApiHandler` does — but flat (no group nesting), matching the original's `get_project` shape. `TasksApiHandler::getOne()` reuses `findScoped()` and joins milestones.

```powershell
npm run plugin:test
```

- [ ] **Step 3: Add the routes**

`GET /api/tasker/project?project_id=&include_notes=` with `operationId: 'get_project'`, and `GET /api/tasker/task?task_id=` with `operationId: 'get_task'`. Both declare their parameters as optional query parameters (`task_id` is required in practice — declare `required: true` for it, since there is no sensible default).

- [ ] **Step 4: Run everything and commit**

```bash
git add plugin/Api/ProjectsApiHandler.php plugin/Api/TasksApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: get_project and get_task single-resource reads"
```

---

### Task 9: `move_task_to_group`, `update_project_context`, `uncomplete_milestone` wiring

The remaining missing verbs. `uncomplete_milestone`'s route landed in Task 7; this task adds the other two and confirms all three derive.

**Files:**
- Modify: `plugin/Api/TasksApiHandler.php`, `plugin/Api/ProjectsApiHandler.php`, `plugin/TaskerPlugin.php`
- Test: `plugin/tests/Api/TasksApiHandlerTest.php`, `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Produces: `TasksApiHandler::moveToGroup(int $tenantId, int $taskId, ?int $groupId, ?int $sectionId): Response` and `ProjectsApiHandler::updateContext(int $tenantId, ?int $callerOuId, int $projectId, array $context, bool $merge): Response`.

- [ ] **Step 1: Write the failing tests**

```php
    public function testMoveToGroupAcceptsNullToUngroup(): void
    {
        $this->pdo->exec('CREATE TABLE tasker_groups (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, section_id INTEGER NOT NULL)');
        $this->pdo->exec('INSERT INTO tasker_groups (id, tenant_id, section_id) VALUES (1, 7, 1)');
        $created = json_decode($this->handler->create(7, 1, 3, json_encode(['text' => 'Groupable']))->getBody(), true);
        $taskId = (int) $created['data']['id'];

        $grouped = json_decode($this->handler->moveToGroup(7, $taskId, 1, null)->getBody(), true);
        self::assertSame(1, $grouped['data']['groupId']);

        $ungrouped = json_decode($this->handler->moveToGroup(7, $taskId, null, null)->getBody(), true);
        self::assertNull($ungrouped['data']['groupId'], 'group_id null must un-group, per the original contract');
    }
```

And for context, in the Postgres suite:

```php
    public function testUpdateContextMergesByDefaultAndReplacesWhenAsked(): void
    {
        $projectId = $this->makeProjectDirect(7, null, 'Context Project');
        $handler = new ProjectsApiHandler($this->pdo);

        $handler->updateContext(7, null, $projectId, ['goal' => 'First goal', 'why' => 'Because'], true);
        $merged = json_decode($handler->updateContext(7, null, $projectId, ['goal' => 'Second goal'], true)->getBody(), true);

        self::assertSame('Second goal', $merged['data']['context']['goal']);
        self::assertSame('Because', $merged['data']['context']['why'], 'merge must preserve keys not being written');

        $replaced = json_decode($handler->updateContext(7, null, $projectId, ['goal' => 'Only goal'], false)->getBody(), true);
        self::assertArrayNotHasKey('why', $replaced['data']['context']);
    }
```

- [ ] **Step 2: Implement, run, add routes**

`move_task_to_group` at `POST /api/tasker/tasks/group` taking `{task_id, group_id, section_id?}` with `group_id` nullable. `update_project_context` at `PATCH /api/tasker/project/context` taking `{project_id?, context, replace?}`. Merge is the default because the original's tool is used to add Foundation keys incrementally.

- [ ] **Step 3: Run everything and commit**

```bash
git add plugin/Api plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: move_task_to_group and update_project_context"
```

---

### Task 10: Environment → OU aliases (cuttable)

Four thin aliases over core's OU endpoints. **Cuttable if you need to reach data migration sooner** — nothing else depends on them.

**Files:**
- Modify: `plugin/TaskerPlugin.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

**Interfaces:**
- Consumes: `Whity\Api\OusApiHandler` and `Whity\Core\HookManager`, both verified available (see Global Constraints).
- Produces: no new handler — the plugin's route methods delegate directly.

- [ ] **Step 1: Add the four routes and their delegating methods**

Delegation, verified: `HookManager` is container-registered; core's `Request`/`Response` are empty subclasses of the SDK's, so a core Response returns directly and the incoming request only needs narrowing.

```php
    /**
     * GET /api/tasker/environments — alias of core's OU list.
     *
     * Delegates rather than querying organizational_units directly: core
     * dispatches ou.* hooks on every OU mutation and its own AuditLogger
     * subscribes to them, so writing directly would silently drop OU changes
     * out of the platform audit trail.
     *
     * @param array<string, string> $params
     */
    public function listEnvironments(Request $request, array $params = []): Response
    {
        if ($this->requireTenantId() === null) {
            return Response::error('Tenant context is required', 403);
        }

        if (!$request instanceof \Whity\Core\Request) {
            return Response::error('Unexpected request type', 500);
        }

        return $this->ousHandler()->list($request);
    }

    private function ousHandler(): \Whity\Api\OusApiHandler
    {
        $hooks = \Whity\app(\Whity\Core\HookManager::class);
        if (!$hooks instanceof \Whity\Core\HookManager) {
            throw new \RuntimeException('The host did not register the shared HookManager service');
        }

        return new \Whity\Api\OusApiHandler($this->resolvePdo(), $hooks);
    }
```

`create_environment`, `rename_environment` and `delete_environment` follow, delegating to `create`, `update` and `delete`. **Verify `HookManager`'s real namespace by grepping `host/.core/public/index.php` for its `use` statement** — this plan infers `Whity\Core\HookManager` from the registration line and has not confirmed the namespace.

`rename_environment` maps onto `update`, which expects a `{id}` path parameter in core's own routing. Since the plugin's alias carries `environment_id` in the body, pass it through as `$params` — check `OusApiHandler::update(Request $request, array $params)`'s expected key by reading the method before wiring.

- [ ] **Step 2: Test that the alias fires core's hooks**

The whole reason for delegating. Add to `plugin/tests/TenantIsolationOuTest.php` a test asserting an `audit_log` row appears with an `ou.*` action after `create_environment`, proving the hook path ran rather than a silent direct insert.

- [ ] **Step 3: Run everything and commit**

```bash
git add plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: environment aliases delegating to core's OU handler"
```

---

### Task 11: `rank_tasks` and `get_my_attention` (cuttable)

**Files:**
- Create: `plugin/Api/AttentionApiHandler.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`
- Modify: `plugin/TaskerPlugin.php`

**Interfaces:**
- Produces: `AttentionApiHandler::rank(int $tenantId, ?int $callerOuId, int $projectId, string $rankBy): Response` and `::attention(int $tenantId, ?int $callerOuId, ?int $projectId): Response`.

`get_ready_work` already exists and ranks by pinned, priority, due date and sort order. `rank_tasks` exposes that ordering explicitly with a `rank_by` choice (`sorting_order` is the user preference the original defaults to). `get_my_attention` returns overdue items, stale in-progress work (quiet 2+ days) and pinned tasks — scoped by OU like every other project-level read.

D1 deliberately dropped `skip_count`, so skip-decay ranking is out of scope; note that in the tool description rather than silently ranking differently from the original.

- [ ] **Step 1–3: Tests, implementation, routes, commit**

Follow the established pattern: failing Postgres tests first (both are OU-scoped, so `whereFragment()` puts them in `TenantIsolationOuTest`), then implementation, then routes with full request schemas.

```bash
git add plugin/Api/AttentionApiHandler.php plugin/TaskerPlugin.php plugin/tests
git commit -m "feat: rank_tasks and get_my_attention"
```

---

### Task 12: The contract-parity test

The task that converts this slice's central claim into something a build can fail on. **Not cuttable.**

**Files:**
- Create: `plugin/tests/Contract/OriginalContractParityTest.php`
- Create: `plugin/tests/Contract/original-tool-schemas.json`
- Create: `plugin/tests/Contract/parity-allowlist.php`
- Create: `host/scripts/extract-original-schemas.ps1`

**Interfaces:**
- Consumes: `docs/mcp-tool-surface.json` (regenerated in Task 14) and the extracted original schemas.

- [ ] **Step 1: Write the extraction script**

The original's `TOOLS` array lives in the **design** repo at `c:\Projects\tasker\V2\supabase\functions\mcp\index.ts` — a different repo from the implementation. Committing an extracted snapshot rather than reading across repos at test time keeps the test hermetic and CI-runnable.

Create `host/scripts/extract-original-schemas.ps1` that parses that file's `TOOLS` array and writes `{name: inputSchema}` pairs to `plugin/tests/Contract/original-tool-schemas.json`. It is a one-shot generator, run manually and committed — not part of the test run.

- [ ] **Step 2: Write the parity test**

```php
<?php

declare(strict_types=1);

namespace Tasker\Tests\Contract;

use PHPUnit\Framework\TestCase;

/**
 * Asserts our derived MCP tool schemas against the ORIGINAL app's, for every
 * tool name present in both surfaces.
 *
 * This is what turns "we preserved the contract" from an assertion into a
 * build failure. D1 shipped 34 tools whose names matched and whose shapes did
 * not, and every acceptance check passed — this test exists so that cannot
 * recur silently.
 *
 * Divergences are allowed, but each must be listed in parity-allowlist.php
 * WITH a reason. An unlisted divergence fails.
 */
final class OriginalContractParityTest extends TestCase
{
    public function testEverySharedToolMatchesTheOriginalsArgumentShape(): void
    {
        $original = json_decode((string) file_get_contents(__DIR__ . '/original-tool-schemas.json'), true);
        $ours     = json_decode((string) file_get_contents(__DIR__ . '/../../../docs/mcp-tool-surface.json'), true);
        $allow    = require __DIR__ . '/parity-allowlist.php';

        self::assertIsArray($original);
        self::assertIsArray($ours);

        $oursByName = [];
        foreach ($ours as $tool) {
            $oursByName[$tool['name']] = $tool['inputSchema'] ?? [];
        }

        $failures = [];

        foreach ($original as $name => $originalSchema) {
            if (!isset($oursByName[$name])) {
                continue; // Not ported yet — a later slice owns it.
            }

            $expected = array_keys($originalSchema['properties'] ?? []);
            $actual   = array_keys($oursByName[$name]['properties'] ?? []);

            $missing = array_diff($expected, $actual, $allow[$name]['missing'] ?? []);
            $extra   = array_diff($actual, $expected, $allow[$name]['extra'] ?? []);

            if ($missing !== []) {
                $failures[] = "{$name}: missing properties the original accepts: " . implode(', ', $missing);
            }
            if ($extra !== []) {
                $failures[] = "{$name}: properties the original does not accept: " . implode(', ', $extra);
            }

            $expectedRequired = array_diff($originalSchema['required'] ?? [], $allow[$name]['required'] ?? []);
            $actualRequired   = $oursByName[$name]['required'] ?? [];
            $newlyRequired    = array_diff($actualRequired, $expectedRequired, $allow[$name]['required'] ?? []);

            if ($newlyRequired !== []) {
                $failures[] = "{$name}: required but optional in the original: " . implode(', ', $newlyRequired);
            }
        }

        self::assertSame([], $failures, "Contract parity failures:\n" . implode("\n", $failures));
    }
}
```

- [ ] **Step 3: Write the allowlist with real reasons**

```php
<?php

declare(strict_types=1);

/**
 * Deliberate divergences from the original's contract.
 *
 * Every entry needs a reason. An empty allowlist is the goal; entries are
 * debts, not decoration.
 */
return [
    'uncomplete_milestone' => [
        // The original addressed milestones positionally because they were a
        // jsonb array. We keep index for compatibility and add milestone_id,
        // which is stable under concurrent reordering.
        'extra' => ['milestone_id'],
    ],
    'create_task' => [
        // The original's tasks carried flow/seed/review/agent fields that D1
        // deliberately deferred to their owning slices (D5, D7).
        'missing' => ['kind', 'seed_target', 'open_questions', 'milestones', 'executor', 'human_guidance', 'relay_context', 'tags', 'allow_duplicate'],
    ],
    'list_tasks' => [
        // Flow, gate and I/O-edge filters belong to D5.
        'missing' => ['flow_id', 'gate_status', 'blocking', 'include_flow_steps', 'cursor', 'limit', 'sort', 'updated_since', 'confirmed'],
    ],
    'create_project' => [
        // environment_id replaces the original's name for the same concept.
        'extra' => ['prefix'],
    ],
];
```

- [ ] **Step 4: Run it and expect real failures first**

```powershell
npm run plugin:test
```

The first run will fail with a genuine list. **Treat each failure as information, not noise:** either our shape is wrong (fix the route), or the divergence is deliberate (allowlist it with a reason). Do not blanket-allowlist to get green — that would reproduce exactly the failure this test exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add plugin/tests/Contract host/scripts/extract-original-schemas.ps1
git commit -m "test: assert derived tool schemas against the original app's contract"
```

---

### Task 13: Close the OU boundary on single-resource routes

D1's carry-over left this open: routes taking a resource's own id stayed tenant-scoped while parent-parameterized ones were fixed. Flattening touches every one of these call sites anyway. **Not cuttable** — it is a security boundary.

**Files:**
- Modify: `plugin/Api/SectionsApiHandler.php`, `plugin/Api/GroupsApiHandler.php`, `plugin/Api/TasksApiHandler.php`, `plugin/Api/MilestonesApiHandler.php`, `plugin/Api/TaskDiscussionsApiHandler.php`
- Test: `plugin/tests/TenantIsolationOuTest.php`

- [ ] **Step 1: Write the failing tests first — one per resource type**

For each of section, group, task, milestone and discussion: a caller restricted to OU 2 attempting a mutation on a resource belonging to sibling OU 3's project must get 404. Five tests, all in the Postgres suite.

- [ ] **Step 2: Add the OU join to each single-resource lookup**

Every one already has a `findScoped()` or equivalent. Add the join through to `tasker_projects.ou_id` plus `OuScopeResolver::whereFragment('p.ou_id')`, and bind `p.tenant_id` as well as the child's — the missing `p.tenant_id` predicate is itself a D1 carry-over item, and this is the natural moment to fix it.

Because these now call `whereFragment()`, any SQLite unit test exercising them will fail at `PDO::prepare()`. Move exactly those cases to `TenantIsolationOuTest.php`, as Task 8 of the D1 plan did — verify empirically which break rather than pre-emptively deleting.

- [ ] **Step 3: Run everything and commit**

```bash
git add plugin/Api plugin/tests
git commit -m "fix: close the OU boundary on single-resource routes"
```

---

### Task 14: Snapshot regeneration, drift proof, full acceptance

One deliberate regeneration with the diff reviewed. **Not cuttable.**

**Files:**
- Modify: `docs/mcp-tool-surface.json`, `host/scripts/mcp-tools.ps1`, `README.md`

- [ ] **Step 1: Widen the snapshot script's tool-name filter**

`host/scripts/mcp-tools.ps1` filters by an explicit 34-name list. Replace it with the full expected set — the 34 minus any renamed, plus the 14 new: `get_project`, `get_task`, `uncomplete_milestone`, `move_task_to_group`, `update_project_context`, `rename_section`, `rename_group`, `list_environments`, `create_environment`, `rename_environment`, `delete_environment`, `rank_tasks`, `get_my_attention`, `__init_tasker_session`, plus `set_default_project`.

Derive the list from the live surface rather than hand-typing it, then confirm the count against `getRoutes()`:

```powershell
docker exec tasker_frankenphp grep -c "'operationId' =>" plugin/TaskerPlugin.php
```

If Tasks 10 and 11 were cut, the expected count drops by 6 — adjust deliberately and note it in the commit rather than letting the filter silently mask absent tools.

- [ ] **Step 2: Regenerate and review the diff before committing**

```powershell
npm run plugin:install
docker restart tasker_frankenphp
docker exec tasker_frankenphp php public/index.php generate:openapi
npm run mcp:tools
```

Read the printed surface. Every tool must expose more than path-style ids. Then write it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/mcp-tools.ps1 -Write
git diff docs/mcp-tool-surface.json
```

**Review that diff properly.** It is large and this is the one operation the drift check exists to make hard. Confirm: no tool lost properties, no tool became more required than the original, no name silently vanished.

- [ ] **Step 3: Re-prove the drift check still bites**

Rename one `operationId` (e.g. `complete_task` → `finish_task`), reinstall, regenerate, and run `npm run mcp:check`. Expected: FAIL naming the drift. Revert, reinstall, regenerate, confirm it passes. A drift check that no longer fails is worse than none.

- [ ] **Step 4: Run the full acceptance suite and record real numbers**

```powershell
npm run plugin:test
npm run plugin:stan
npm run mcp:check
```

Record exact test and assertion counts and the **skipped count** — it must be 0. Then walk the whole board path against the live host using only the original's identifier forms: create a project, read it back by prefix, create a task with `project_id` as a prefix, complete it by short id, add and complete a milestone, fetch the board with no arguments (default project), and save a discussion.

- [ ] **Step 5: Update the README and commit**

```bash
git add docs/mcp-tool-surface.json host/scripts/mcp-tools.ps1 README.md
git commit -m "test: regenerate the MCP surface for D1b's flattened, invocable tools"
```

---

## Plan acceptance

Mirrors the spec's Definition of Done, and the frozen review bar on TOW-10.

1. **No tool exposes path parameters only.** Parse `docs/mcp-tool-surface.json`; the count of tools whose properties are empty or only path-style ids must be **0** (baseline today: 32 of 34).
2. **The contract-parity test passes**, with every divergence allowlisted and justified.
3. **The original's identifier forms work live:** `complete_task {task_id: "PREFIX-N"}`, `get_project {project_id: "PREFIX"}`, and `list_tasks {}` with no arguments.
4. **`short_id` is populated** for every created task, allocated race-safely, with `UNIQUE (project_id, short_id)` enforcing it.
5. **The resolver cannot cross a tenant or OU boundary** for any of its six identifier forms, proven on real PostgreSQL.
6. **The OU boundary is closed on single-resource routes** — no route reachable by guessing an integer id escapes it.
7. **Full suite green with 0 skipped**, PHPStan clean at level 6, `mcp:check` passing and re-proven to catch a rename.

**Not delivered:** a working SPA (D2), data migration (D3), local mode (D4 — `local_mode` is declared, unconsumed), flows, knowledge, intake, integrations, AI-backed tools (`analyze_section`, `section_insights` need P4), or the 95 tools belonging to later slices.
