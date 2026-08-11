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
}
