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
}
