<?php

declare(strict_types=1);

// \Whity\app()/\Whity\register_service() are NO LONGER stubbed here (D1b
// Task 10): plugin/composer.json's autoload-dev now has a `files` entry for
// the REAL host/.core/src/helpers.php (needed so the Environment-alias
// integration tests in plugin/tests/TenantIsolationOuTest.php can actually
// call them), and composer's `files` autoload type is EAGER — always
// `require`d the moment vendor/autoload.php loads, unlike classmap/psr-4
// entries, which are lazy. PHPStan also loads vendor/autoload.php before
// running this file as a bootstrapFile, so a stub `function app()` here
// would collide with the real one already declared by that point ("Cannot
// redeclare function Whity\app()", confirmed empirically). The classes below
// stay stubbed: those come from LAZY classmap entries, which never trigger
// at all once the class already exists (whichever definition, real or stub,
// runs first wins with no conflict) — the exact reason
// Whity\Core\Identity\MembershipRepository could already be both stubbed
// here AND real-classmapped in composer.json before this task touched
// either file.

namespace Whity\Database {
    class Database
    {
        public function getPdo(): \PDO
        {
        }
    }
}

namespace Whity\Core\Tenant {
    class TenantContext
    {
        public static function getTenantId(): ?int
        {
        }
    }
}

namespace Whity\Core\Identity {
    class MembershipRepository
    {
        public function __construct(\PDO $db)
        {
        }

        /**
         * @return array<string, mixed>|null
         */
        public function findByProfile(int $profileId, int $tenantId): ?array
        {
        }
    }
}

namespace Whity\Core {
    /**
     * Host-side alias of the SDK request shape (D1b Task 10). Stubbed here the
     * same way \Whity\Database\Database/TenantContext/MembershipRepository
     * already are above: this plugin depends only on whity/plugin-sdk, so the
     * REAL host/.core/src/Core/Request.php (an empty
     * `class Request extends \Whity\Sdk\Http\Request {}`, verified by reading
     * it directly) is never on this plugin's own autoload path — only PHPStan
     * needs a declaration to resolve TaskerPlugin::ousHandler()'s
     * `$request instanceof \Whity\Core\Request` narrowing.
     */
    class Request extends \Whity\Sdk\Http\Request
    {
    }

    /**
     * Host-side alias of the SDK response shape (D1b Task 10) — the Response
     * counterpart to the Request stub above, matching the real
     * host/.core/src/Core/Response.php exactly (an empty
     * `class Response extends \Whity\Sdk\Http\Response {}`).
     */
    class Response extends \Whity\Sdk\Http\Response
    {
    }
}

namespace Whity\Core\Hooks {
    /**
     * Stub of core's real HookManager (host/.core/src/Core/Hooks/HookManager.php,
     * confirmed via host/.core/public/index.php's own
     * `use Whity\Core\Hooks\HookManager;` — see task-10-report.md). Only the
     * shape TaskerPlugin::ousHandler() touches (its existence as a type for
     * the instanceof narrowing) is needed here; PHPStan never executes this
     * body.
     */
    class HookManager
    {
    }
}

namespace Whity\Api {
    /**
     * Stub of core's real OusApiHandler (host/.core/src/Api/OusApiHandler.php).
     * Signatures mirror the real class exactly for the four methods
     * TaskerPlugin's Environment aliases (D1b Task 10) delegate to —
     * verified directly against that file, including that update()/delete()
     * take the target OU id as `$params['id']`, not `environment_id`.
     */
    class OusApiHandler
    {
        public function __construct(\PDO $db, \Whity\Core\Hooks\HookManager $hookManager)
        {
        }

        public function list(\Whity\Core\Request $request): \Whity\Core\Response
        {
        }

        public function create(\Whity\Core\Request $request): \Whity\Core\Response
        {
        }

        /**
         * @param array<string, mixed> $params
         */
        public function update(\Whity\Core\Request $request, array $params): \Whity\Core\Response
        {
        }

        /**
         * @param array<string, mixed> $params
         */
        public function delete(\Whity\Core\Request $request, array $params): \Whity\Core\Response
        {
        }
    }
}
