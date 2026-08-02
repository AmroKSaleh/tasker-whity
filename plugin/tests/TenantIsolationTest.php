<?php

declare(strict_types=1);

namespace Tasker\Tests;

use Tasker\Migrations\CreateTaskerPingTable;
use Whity\Sdk\Tenant\TenantTableRegistry;
use Whity\Sdk\Testing\TenantIsolationConformanceTestCase;

/**
 * Proves Tasker's tenant isolation with the SDK conformance kit: every table
 * the plugin creates declares tenant_id, every query against a tenant-owned
 * table binds a tenant_id predicate, and the columns physically exist after
 * the migrations run on a real engine.
 */
final class TenantIsolationTest extends TenantIsolationConformanceTestCase
{
    protected function tenantTableRegistry(): TenantTableRegistry
    {
        return TenantTableRegistry::for([
            'tasker_pings' => 'Connectivity probe rows are per-tenant.',
        ]);
    }

    protected function migrationsDirectory(): string
    {
        return dirname(__DIR__) . '/Migrations';
    }

    /**
     * @return list<string>
     */
    protected function handlerSourceDirectories(): array
    {
        return [dirname(__DIR__) . '/Api'];
    }

    /**
     * @return list<\Whity\Sdk\MigrationInterface>
     */
    protected function schemaMigrations(): array
    {
        return [new CreateTaskerPingTable()];
    }
}
