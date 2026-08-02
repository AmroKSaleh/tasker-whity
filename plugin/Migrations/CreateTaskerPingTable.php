<?php

declare(strict_types=1);

namespace Tasker\Migrations;

use Whity\Sdk\MigrationInterface;

/**
 * Creates the connectivity-probe table used to prove the plugin's data path
 * end to end. Replaced by the real board tables in Plan B.
 *
 * DEFAULT (NOW()) is parenthesised so the same DDL runs on PostgreSQL and on
 * the in-memory SQLite the conformance kit applies it against.
 */
final class CreateTaskerPingTable implements MigrationInterface
{
    public function up(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS tasker_pings (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                label VARCHAR(255) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT (NOW())
            )
        ');

        $pdo->exec(
            'CREATE INDEX IF NOT EXISTS idx_tasker_pings_tenant_id ON tasker_pings(tenant_id)'
        );
    }

    public function down(\PDO $pdo): void
    {
        $pdo->exec('DROP TABLE IF EXISTS tasker_pings');
    }
}
