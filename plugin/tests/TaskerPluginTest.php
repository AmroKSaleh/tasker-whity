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
     * DELETE tool call: the argument travels in the path's query string, and
     * the body is the empty string.
     */
    public function testIdentifierFromRequestFallsBackToTheQueryStringWhenTheBodyIsEmpty(): void
    {
        $request = new Request('DELETE', '/api/v1/tasker/projects?project_id=TDE', [], '');

        self::assertSame('TDE', $this->invokeIdentifierFromRequest($request, 'project_id'));
    }

    public function testIdentifierFromRequestPrefersTheBodyOverTheQueryStringWhenBothArePresent(): void
    {
        $request = new Request(
            'PATCH',
            '/api/tasker/projects?project_id=FROM-QUERY',
            [],
            (string) json_encode(['project_id' => 'FROM-BODY'])
        );

        self::assertSame('FROM-BODY', $this->invokeIdentifierFromRequest($request, 'project_id'));
    }

    public function testIdentifierFromRequestReturnsNullWhenNeitherBodyNorQueryHasTheKey(): void
    {
        $request = new Request('DELETE', '/api/tasker/projects', [], '');

        self::assertNull($this->invokeIdentifierFromRequest($request, 'project_id'));
    }
}
