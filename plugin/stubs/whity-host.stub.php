<?php

declare(strict_types=1);

namespace Whity {
    /**
     * Resolve a service from the host container.
     *
     * @param string $id Service id (usually a class-string).
     * @return object The resolved service.
     */
    function app(string $id): object
    {
    }
}

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
