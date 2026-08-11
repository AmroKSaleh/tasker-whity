<?php

declare(strict_types=1);

namespace Tasker\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Tasker\TaskerPlugin;
use Whity\Sdk\Http\Request;
use Whity\Sdk\PluginInterface;
use Whity\Sdk\PluginRequirementsInterface;

final class TaskerPluginTest extends TestCase
{
    public function testImplementsTheSdkContracts(): void
    {
        $plugin = new TaskerPlugin();

        self::assertInstanceOf(PluginInterface::class, $plugin);
        self::assertInstanceOf(PluginRequirementsInterface::class, $plugin);
    }

    public function testIdentifiesItselfAsTasker(): void
    {
        self::assertSame('Tasker', (new TaskerPlugin())->getName());
    }

    public function testRequiresSdkNineOrLater(): void
    {
        self::assertSame('^1.9', (new TaskerPlugin())->getSdkConstraint());
    }

    public function testDeclaresNoPluginDependencies(): void
    {
        self::assertSame([], (new TaskerPlugin())->getPluginDependencies());
    }

    /**
     * Regression tests for whole-branch review finding I4: TaskerPlugin's
     * private resolveCallerOu() must distinguish "resolved, unrestricted"
     * from "resolved, restricted to X" from "could not resolve the actor at
     * all" — the previous callerOuId(): ?int collapsed the first and third
     * cases into the same (unrestricted) result, which is a fail-OPEN bug: an
     * unidentifiable actor would silently be treated as tenant-root.
     *
     * Exercised via Reflection, since resolveCallerOu() is a private
     * route-dispatch helper with no other seam to invoke it through. The
     * real `Whity\Core\Identity\MembershipRepository` it delegates to runs an
     * ordinary `SELECT * FROM memberships WHERE ...` with no Postgres-only
     * syntax, so a minimal SQLite `memberships` table fixture exercises the
     * genuine repository class, not a test double.
     */
    private function invokeResolveCallerOu(PDO $pdo, Request $request, int $tenantId): array
    {
        $plugin = new TaskerPlugin();
        $method = new \ReflectionMethod(TaskerPlugin::class, 'resolveCallerOu');
        $method->setAccessible(true);

        /** @var array{resolved: bool, ouId: ?int} $result */
        $result = $method->invoke($plugin, $pdo, $request, $tenantId);

        return $result;
    }

    private function makeMembershipsPdo(): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('
            CREATE TABLE memberships (
                id INTEGER PRIMARY KEY,
                profile_id INTEGER NOT NULL,
                tenant_id INTEGER NOT NULL,
                role_id INTEGER NOT NULL,
                ou_id INTEGER NULL,
                status VARCHAR(32) NOT NULL DEFAULT \'active\',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ');

        return $pdo;
    }

    private function requestForProfile(?int $profileId): Request
    {
        $request = new Request('GET', '/api/tasker/projects');
        if ($profileId !== null) {
            $request->user = (object) ['profile_id' => $profileId];
        }

        return $request;
    }

    public function testResolveCallerOuFailsClosedWhenTheRequestHasNoUser(): void
    {
        $pdo = $this->makeMembershipsPdo();

        $result = $this->invokeResolveCallerOu($pdo, $this->requestForProfile(null), 7);

        self::assertFalse($result['resolved'], 'an unidentifiable actor must fail closed, never proceed as tenant-root');
        self::assertNull($result['ouId']);
    }

    public function testResolveCallerOuFailsClosedWhenNoMembershipRowExistsForTheTenant(): void
    {
        $pdo = $this->makeMembershipsPdo();
        // Profile 5 has a membership, but for a DIFFERENT tenant (9), not the
        // tenant (7) this request is scoped to.
        $pdo->exec('INSERT INTO memberships (id, profile_id, tenant_id, role_id, ou_id) VALUES (1, 5, 9, 1, NULL)');

        $result = $this->invokeResolveCallerOu($pdo, $this->requestForProfile(5), 7);

        self::assertFalse(
            $result['resolved'],
            'no membership row for THIS tenant must fail closed, not be treated the same as a genuine tenant-root membership'
        );
        self::assertNull($result['ouId']);
    }

    public function testResolveCallerOuIsUnrestrictedOnlyForAGenuineNullOuMembership(): void
    {
        $pdo = $this->makeMembershipsPdo();
        $pdo->exec('INSERT INTO memberships (id, profile_id, tenant_id, role_id, ou_id) VALUES (1, 5, 7, 1, NULL)');

        $result = $this->invokeResolveCallerOu($pdo, $this->requestForProfile(5), 7);

        self::assertTrue($result['resolved']);
        self::assertNull($result['ouId'], 'a real membership row with ou_id IS NULL is genuine tenant-root');
    }

    public function testResolveCallerOuReturnsTheMembershipsConcreteOuId(): void
    {
        $pdo = $this->makeMembershipsPdo();
        $pdo->exec('INSERT INTO memberships (id, profile_id, tenant_id, role_id, ou_id) VALUES (1, 5, 7, 1, 3)');

        $result = $this->invokeResolveCallerOu($pdo, $this->requestForProfile(5), 7);

        self::assertTrue($result['resolved']);
        self::assertSame(3, $result['ouId']);
    }

    /**
     * Regression tests for a bug found via a LIVE tools/call smoke test
     * during Task 4, not by any PHPUnit test — TenantIsolationOuTest
     * exercises ProjectsApiHandler directly and never goes through
     * TaskerPlugin::deleteProject()/updateProject() at all.
     *
     * Tasker's MCP transport (Whity\Mcp\Tools\ToolsCallHandler::buildRequest(),
     * in the gitignored, pinned-ref host/.core checkout — out of this
     * plugin's reach entirely) sends EVERY argument to a DELETE tool call as
     * a query-string parameter appended to the synthesized request's path,
     * and leaves the body empty — unlike POST/PATCH, whose body arguments
     * really do arrive JSON-encoded. A deleteProject() that only read the
     * JSON body (this method's first implementation, and the brief's own
     * sketch) 400s on EVERY SINGLE MCP delete_project call with "Request
     * body must be a JSON object", defeating the entire point of this
     * flattening slice: an agent could never actually delete a project
     * through the tool surface this task built. Confirmed fixed against a
     * real running instance (docker exec tasker_frankenphp, tools/call
     * delete_project) before these were written; these pin the fix at the
     * unit level via Reflection, the same seam resolveCallerOu() above uses.
     *
     * SECOND ROUND (whole-branch review): the first version of the fix read
     * the query ONLY off `$request->getPath()`, which is a no-op for a
     * genuine HTTP request — `Request::fromGlobals()` strips the query
     * string from the path entirely; `$_GET` is the only place it survives
     * at runtime. That failure mode is silent and worse than the original
     * bug: `IdentifierResolver::classify(null)` returns 'empty', not
     * 'malformed', so `resolveProject()` falls through to the caller's
     * DEFAULT project — a 204 against the WRONG project, not a 404. The
     * tests below exercise `$_GET` directly (saving/restoring the
     * superglobal around each assertion) alongside the path-embedded form,
     * which must keep working since that is the shape both this plugin's
     * own hand-built test Requests and the MCP transport actually use.
     */
    private function invokeIdentifierFromRequest(Request $request, string $key): string|int|null
    {
        $plugin = new TaskerPlugin();
        $method = new \ReflectionMethod(TaskerPlugin::class, 'identifierFromRequest');
        $method->setAccessible(true);

        /** @var string|int|null $result */
        $result = $method->invoke($plugin, $request, $key);

        return $result;
    }

    protected function tearDown(): void
    {
        // Defense-in-depth alongside each test's own try/finally below: a
        // test that failed an assertion mid-block (unlikely here, since none
        // of these assert anything but the final value, but cheap insurance
        // against ever leaking $_GET into an unrelated later test).
        $_GET = [];
    }

    public function testIdentifierFromRequestReadsFromTheJsonBodyWhenPresent(): void
    {
        $request = new Request(
            'PATCH',
            '/api/tasker/projects',
            ['content-type' => 'application/json'],
            (string) json_encode(['project_id' => 'TDE'])
        );

        self::assertSame('TDE', $this->invokeIdentifierFromRequest($request, 'project_id'));
    }

    /**
     * Mirrors exactly what ToolsCallHandler::buildRequest() sends for a
     * DELETE tool call, AND how this test suite's other hand-built Requests
     * work: the argument travels in the path's query string, the body is
     * the empty string, and $_GET is untouched (empty).
     */
    public function testIdentifierFromRequestFallsBackToThePathEmbeddedQueryWhenTheBodyIsEmpty(): void
    {
        $previousGet = $_GET;
        $_GET = [];
        try {
            $request = new Request('DELETE', '/api/v1/tasker/projects?project_id=TDE', [], '');

            self::assertSame('TDE', $this->invokeIdentifierFromRequest($request, 'project_id'));
        } finally {
            $_GET = $previousGet;
        }
    }

    /**
     * The runtime case: `Request::fromGlobals()` builds the path via
     * `parse_url($requestUri, PHP_URL_PATH)`, which strips the query
     * entirely, so a genuine `DELETE /api/tasker/projects?project_id=TDE`
     * arrives here with a bare path and NOTHING in it but $_GET carrying
     * the value. Without the $_GET fallback this returns null, which is
     * exactly the silent-wrong-project failure mode the whole-branch review
     * caught.
     */
    public function testIdentifierFromRequestFallsBackToDollarGetWhenThePathHasNoQuery(): void
    {
        $previousGet = $_GET;
        $_GET = ['project_id' => 'TDE'];
        try {
            $request = new Request('DELETE', '/api/tasker/projects', [], '');

            self::assertSame('TDE', $this->invokeIdentifierFromRequest($request, 'project_id'));
        } finally {
            $_GET = $previousGet;
        }
    }

    public function testIdentifierFromRequestPrefersTheBodyOverEitherQuerySourceWhenAllArePresent(): void
    {
        $previousGet = $_GET;
        $_GET = ['project_id' => 'FROM-GET'];
        try {
            $request = new Request(
                'PATCH',
                '/api/tasker/projects?project_id=FROM-PATH',
                [],
                (string) json_encode(['project_id' => 'FROM-BODY'])
            );

            self::assertSame('FROM-BODY', $this->invokeIdentifierFromRequest($request, 'project_id'));
        } finally {
            $_GET = $previousGet;
        }
    }

    /**
     * The path-embedded form wins over $_GET when the body is absent and
     * both query sources disagree — matching
     * {@see \Whity\Api\PersonsApiHandler::queryParam()} /
     * {@see \Whity\Api\DelegationsApiHandler::queryParams()}'s own
     * precedence exactly (WC-167), rather than this plugin inventing a
     * third convention for the same problem.
     */
    public function testIdentifierFromRequestPrefersThePathEmbeddedQueryOverDollarGetWhenBothArePresent(): void
    {
        $previousGet = $_GET;
        $_GET = ['project_id' => 'FROM-GET'];
        try {
            $request = new Request('DELETE', '/api/tasker/projects?project_id=FROM-PATH', [], '');

            self::assertSame('FROM-PATH', $this->invokeIdentifierFromRequest($request, 'project_id'));
        } finally {
            $_GET = $previousGet;
        }
    }

    public function testIdentifierFromRequestReturnsNullWhenNoneOfTheThreeSourcesHaveTheKey(): void
    {
        $previousGet = $_GET;
        $_GET = [];
        try {
            $request = new Request('DELETE', '/api/tasker/projects', [], '');

            self::assertNull($this->invokeIdentifierFromRequest($request, 'project_id'));
        } finally {
            $_GET = $previousGet;
        }
    }

    /**
     * Task 5 review finding: the new updateSection()/deleteSection()/
     * updateGroup()/deleteGroup() branch — classify an optional parent
     * identifier, 400 on malformed, resolve it only when non-empty, pass it
     * as resolveSection()'s/resolveGroup()'s fifth argument — was extracted
     * into resolveOptionalParentId() specifically because it shipped with NO
     * verification at any layer: the existing
     * testResolveSectionBySlugRequiresTheParentAndRefusesAcrossAnOuBoundary
     * calls IdentifierResolver::resolveSection() directly with a
     * hand-supplied parent, never through TaskerPlugin, so it could not catch
     * a dispatch-order bug in the new composition code (a swapped classify
     * call, or the wrong variable passed as the parent). These tests close
     * that gap the same way {@see self::invokeIdentifierFromRequest()} does
     * for identifierFromRequest() — via Reflection, since resolveOptionalParentId()
     * is a private route-dispatch helper with no other seam.
     *
     * The 'empty' and 'malformed_short_id' branches are pure (no database
     * call happens on either path) and are asserted directly. The "supplied"
     * branch is asserted with a SPY resolver rather than a real
     * IdentifierResolver::resolveProject()/resolveSection() call: those need
     * PostgreSQL (OuScopeResolver::whereFragment()'s `= ANY(:scope)` fails at
     * PDO::prepare() under SQLite — see TenantIsolationOuTest's own header),
     * which is exactly why this composition logic had no coverage before
     * this extraction. The spy lets these tests verify the exact
     * (pdo, tenantId, callerOuId, raw) tuple resolveOptionalParentId() hands
     * to the resolver, independent of what IdentifierResolver itself does
     * with it.
     */
    private function invokeResolveOptionalParentId(
        Request $request,
        PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        string $key,
        callable $resolver
    ): array {
        $plugin = new TaskerPlugin();
        $method = new \ReflectionMethod(TaskerPlugin::class, 'resolveOptionalParentId');
        $method->setAccessible(true);

        /** @var array{ok: bool, value: ?int} $result */
        $result = $method->invoke($plugin, $request, $pdo, $tenantId, $callerOuId, $key, $resolver);

        return $result;
    }

    public function testResolveOptionalParentIdReturnsNullWithoutCallingTheResolverWhenAbsent(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $request = new Request('PATCH', '/api/tasker/sections', [], (string) json_encode(['name' => 'x']));

        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 99;
        };

        $result = $this->invokeResolveOptionalParentId($request, $pdo, 7, null, 'project_id', $resolver);

        self::assertTrue($result['ok']);
        self::assertNull($result['value']);
        self::assertFalse($called, 'an absent parent identifier must not trigger a resolver call at all');
    }

    public function testResolveOptionalParentIdRejectsAMalformedShortIdWithoutCallingTheResolver(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $request = new Request('PATCH', '/api/tasker/sections', [], (string) json_encode(['project_id' => 'AB-xyz']));

        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 99;
        };

        $result = $this->invokeResolveOptionalParentId($request, $pdo, 7, null, 'project_id', $resolver);

        self::assertFalse($result['ok']);
        self::assertNull($result['value']);
        self::assertFalse($called, 'a malformed short id must not reach the resolver — the caller 400s on ok:false first');
    }

    public function testResolveOptionalParentIdCallsTheResolverWithTheExactTupleWhenSupplied(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $request = new Request('PATCH', '/api/tasker/sections', [], (string) json_encode(['project_id' => 'TDE']));

        $seen = null;
        $resolver = function (PDO $calledPdo, int $tenantId, ?int $callerOuId, $raw) use (&$seen, $pdo): ?int {
            $seen = [$calledPdo === $pdo, $tenantId, $callerOuId, $raw];

            return 42;
        };

        $result = $this->invokeResolveOptionalParentId($request, $pdo, 7, 3, 'project_id', $resolver);

        self::assertTrue($result['ok']);
        self::assertSame(42, $result['value']);
        self::assertSame(
            [true, 7, 3, 'TDE'],
            $seen,
            'the resolver must receive the SAME pdo, the tenantId, the callerOuId, and the raw (unresolved) '
                . 'identifier untouched — not a swapped argument or an already-resolved value'
        );
    }

    public function testResolveOptionalParentIdPassesThroughANullResolutionWithoutTreatingItAsAnError(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $request = new Request('PATCH', '/api/tasker/sections', [], (string) json_encode(['project_id' => 'ZZZ']));

        $resolver = fn (PDO $pdo, int $tenantId, ?int $callerOuId, $raw): ?int => null;

        $result = $this->invokeResolveOptionalParentId($request, $pdo, 7, null, 'project_id', $resolver);

        self::assertTrue(
            $result['ok'],
            'a resolver returning null (not found, or outside the caller\'s OU scope) is not the same failure '
                . 'mode as a malformed identifier and must not be reported as ok:false'
        );
        self::assertNull($result['value']);
    }

    /**
     * Task review finding #2 (D1b Task 6): moveTask() used to pass
     * section_id/group_id straight through to TasksApiHandler::move(),
     * which only ever does a plain `(int)` cast on whatever it is handed —
     * a UUID or slug destination silently cast to 0 and 422'd. Extracted
     * into resolveMoveDestinationId() so this composition (unreachable from
     * PHPUnit any other way — moveTask() itself calls resolvePdo(), which
     * needs the live host container) gets a Reflection test seam, the same
     * way resolveOptionalParentId() does above. Unlike resolveOptionalParentId(),
     * this one needs to distinguish FIVE outcomes, not three, because
     * group_id's explicit-null-means-un-group semantics (move()'s own
     * docblock) collapse into the same value under a bare classify() call —
     * "absent" and "explicit null" must not be treated the same way.
     */
    private function invokeResolveMoveDestinationId(
        array $decoded,
        string $key,
        PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        callable $resolver
    ): array {
        $plugin = new TaskerPlugin();
        $method = new \ReflectionMethod(TaskerPlugin::class, 'resolveMoveDestinationId');
        $method->setAccessible(true);

        /** @var array{status: string, value: ?int} $result */
        $result = $method->invoke($plugin, $decoded, $key, $pdo, $tenantId, $callerOuId, $resolver);

        return $result;
    }

    public function testResolveMoveDestinationIdReportsAbsentWithoutCallingTheResolverWhenKeyIsMissing(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 99;
        };

        $result = $this->invokeResolveMoveDestinationId(['sort_order' => 5], 'section_id', $pdo, 7, null, $resolver);

        self::assertSame('absent', $result['status']);
        self::assertNull($result['value']);
        self::assertFalse($called, 'a key absent from the body must not trigger a resolver call at all');
    }

    public function testResolveMoveDestinationIdReportsExplicitNullWithoutCallingTheResolver(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 99;
        };

        $result = $this->invokeResolveMoveDestinationId(['group_id' => null], 'group_id', $pdo, 7, null, $resolver);

        self::assertSame('explicit_null', $result['status']);
        self::assertNull($result['value']);
        self::assertFalse($called, 'an explicit null (group_id\'s own "un-group" meaning) must not trigger a resolver call at all');
    }

    public function testResolveMoveDestinationIdRejectsAMalformedShortIdWithoutCallingTheResolver(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 99;
        };

        $result = $this->invokeResolveMoveDestinationId(['section_id' => 'AB-xyz'], 'section_id', $pdo, 7, null, $resolver);

        self::assertSame('malformed', $result['status']);
        self::assertNull($result['value']);
        self::assertFalse($called, 'a malformed short id must not reach the resolver — the caller 400s on this status first');
    }

    public function testResolveMoveDestinationIdRejectsANonScalarValueAsMalformedRatherThanThrowing(): void
    {
        $pdo = new PDO('sqlite::memory:');

        // classify()'s own signature is string|int|null — under this
        // codebase's strict_types, handing it an array would throw a
        // TypeError instead of a clean 400 were this guard not here.
        $result = $this->invokeResolveMoveDestinationId(['group_id' => ['nope']], 'group_id', $pdo, 7, null, fn () => 99);

        self::assertSame('malformed', $result['status']);
        self::assertNull($result['value']);
    }

    public function testResolveMoveDestinationIdCallsTheResolverWithTheExactTupleWhenSupplied(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $seen = null;
        $resolver = function (PDO $calledPdo, int $tenantId, ?int $callerOuId, $raw) use (&$seen, $pdo): ?int {
            $seen = [$calledPdo === $pdo, $tenantId, $callerOuId, $raw];

            return 42;
        };

        $result = $this->invokeResolveMoveDestinationId(
            ['section_id' => '11111111-1111-4111-8111-111111111111'],
            'section_id',
            $pdo,
            7,
            3,
            $resolver
        );

        self::assertSame('resolved', $result['status']);
        self::assertSame(42, $result['value']);
        self::assertSame(
            [true, 7, 3, '11111111-1111-4111-8111-111111111111'],
            $seen,
            'the resolver must receive the SAME pdo, the tenantId, the callerOuId, and the raw identifier untouched'
        );
    }

    public function testResolveMoveDestinationIdReportsUnresolvedWhenTheResolverFindsNothing(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $resolver = fn (PDO $pdo, int $tenantId, ?int $callerOuId, $raw): ?int => null;

        $result = $this->invokeResolveMoveDestinationId(['section_id' => 999], 'section_id', $pdo, 7, null, $resolver);

        self::assertSame(
            'unresolved',
            $result['status'],
            'a supplied identifier that does not resolve is distinct from "absent" — the caller 404s on this, ' .
                'never move()\'s own 422 (which only fires once a resolved id reaches it at all)'
        );
        self::assertNull($result['value']);
    }

    /**
     * Task review finding #4 (D1b Task 6): createTask()'s "section_id
     * omitted -> default to the project's Backlog section" composition,
     * extracted the same way — and for the same reason — Task 5 extracted
     * resolveOptionalParentId(): createTask() itself is unreachable from
     * PHPUnit (resolvePdo() needs the live host container), so this
     * composition had zero coverage before the extraction.
     *
     * Unlike resolveOptionalParentId()'s 'empty' branch (pure, no database
     * call), this one's 'empty' branch DOES hit the database —
     * backlogSectionIdFor() — but that method is plain tenant-scoped SQL
     * with no OU/Postgres-only syntax (see its own docblock), so it runs
     * for real against a bare SQLite fixture rather than needing a spy. Only
     * the "supplied" branch's resolver (IdentifierResolver::resolveSection()
     * in production) needs a spy, for the usual reason: it calls
     * OuScopeResolver::whereFragment() unconditionally, which SQLite's
     * PDO::prepare() rejects outright.
     */
    private function invokeResolveCreateTaskSectionId(
        Request $request,
        PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        int $projectId,
        callable $resolver
    ): array {
        $plugin = new TaskerPlugin();
        $method = new \ReflectionMethod(TaskerPlugin::class, 'resolveCreateTaskSectionId');
        $method->setAccessible(true);

        /** @var array{ok: bool, value: ?int, usedBacklogFallback: bool} $result */
        $result = $method->invoke($plugin, $request, $pdo, $tenantId, $callerOuId, $projectId, $resolver);

        return $result;
    }

    private function makeSectionsPdoWithOneSection(int $projectId, string $slug): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec(
            'CREATE TABLE tasker_sections (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL, slug VARCHAR(255) NOT NULL)'
        );
        $stmt = $pdo->prepare('INSERT INTO tasker_sections (tenant_id, project_id, slug) VALUES (7, :project_id, :slug)');
        $stmt->execute([':project_id' => $projectId, ':slug' => $slug]);

        return $pdo;
    }

    public function testResolveCreateTaskSectionIdDefaultsToBacklogWhenAbsent(): void
    {
        $pdo = $this->makeSectionsPdoWithOneSection(100, 'backlog');
        $request = new Request('POST', '/api/tasker/tasks', [], (string) json_encode(['text' => 'x']));

        $called = false;
        $resolver = function () use (&$called): ?int {
            $called = true;

            return 999;
        };

        $result = $this->invokeResolveCreateTaskSectionId($request, $pdo, 7, null, 100, $resolver);

        self::assertTrue($result['ok']);
        self::assertTrue($result['usedBacklogFallback']);
        self::assertFalse($called, 'an absent section_id must default to Backlog, never call the resolver');

        $backlogId = (int) $pdo->query("SELECT id FROM tasker_sections WHERE project_id = 100 AND slug = 'backlog'")->fetchColumn();
        self::assertSame($backlogId, $result['value']);
    }

    public function testResolveCreateTaskSectionIdReturnsNullWhenTheProjectHasNoBacklogSection(): void
    {
        $pdo = $this->makeSectionsPdoWithOneSection(100, 'in-progress');
        $request = new Request('POST', '/api/tasker/tasks', [], (string) json_encode(['text' => 'x']));

        $result = $this->invokeResolveCreateTaskSectionId($request, $pdo, 7, null, 100, fn () => 999);

        self::assertTrue($result['ok']);
        self::assertTrue($result['usedBacklogFallback']);
        self::assertNull(
            $result['value'],
            'a project with no backlog section must resolve to null, not silently pick some other section'
        );
    }

    public function testResolveCreateTaskSectionIdRejectsAMalformedShortIdWithoutFallingBackToBacklog(): void
    {
        $pdo = $this->makeSectionsPdoWithOneSection(100, 'backlog');
        $request = new Request('POST', '/api/tasker/tasks', [], (string) json_encode(['section_id' => 'AB-xyz', 'text' => 'x']));

        $result = $this->invokeResolveCreateTaskSectionId($request, $pdo, 7, null, 100, fn () => 999);

        self::assertFalse($result['ok']);
        self::assertNull($result['value']);
        self::assertFalse(
            $result['usedBacklogFallback'],
            'a malformed section_id must 400, never silently fall back to Backlog'
        );
    }

    public function testResolveCreateTaskSectionIdCallsTheResolverWithTheExactTupleWhenSupplied(): void
    {
        $pdo = $this->makeSectionsPdoWithOneSection(100, 'backlog');
        $request = new Request('POST', '/api/tasker/tasks', [], (string) json_encode(['section_id' => 'TDE', 'text' => 'x']));

        $seen = null;
        $resolver = function (PDO $calledPdo, int $tenantId, ?int $callerOuId, $raw, ?int $projectId) use (&$seen, $pdo): ?int {
            $seen = [$calledPdo === $pdo, $tenantId, $callerOuId, $raw, $projectId];

            return 55;
        };

        $result = $this->invokeResolveCreateTaskSectionId($request, $pdo, 7, 3, 100, $resolver);

        self::assertTrue($result['ok']);
        self::assertSame(55, $result['value']);
        self::assertFalse($result['usedBacklogFallback']);
        self::assertSame(
            [true, 7, 3, 'TDE', 100],
            $seen,
            'the resolver must receive the SAME pdo, tenantId, callerOuId, raw identifier, and the resolved ' .
                'projectId as its parent — never the backlog fallback'
        );
    }
}
