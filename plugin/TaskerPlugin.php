<?php

declare(strict_types=1);

namespace Tasker;

use Tasker\Api\PingApiHandler;
use Tasker\Migrations\CreateTaskerPingTable;
use Tasker\Migrations\GrantTaskerPingPermissions;
use Whity\Sdk\Http\Request;
use Whity\Sdk\Http\Response;
use Whity\Sdk\PluginInterface;
use Whity\Sdk\PluginRequirementsInterface;

/**
 * Tasker — a kanban board with milestones, focus mode, and an agent-facing
 * MCP surface, packaged as a Whity plugin.
 *
 * Depends on whity/plugin-sdk only. The host seams are resolved at request
 * time: the shared Database service from the \Whity container, and the
 * caller's tenant from TenantContext. Handlers never touch either — route
 * methods on this class resolve them and pass plain values down, which keeps
 * the handlers unit-testable against a bare PDO.
 */
final class TaskerPlugin implements PluginInterface, PluginRequirementsInterface
{
    public function getName(): string
    {
        return 'Tasker';
    }

    public function getVersion(): string
    {
        return '0.1.0';
    }

    public function getSdkConstraint(): string
    {
        return '^1.9';
    }

    public function getCoreConstraint(): string
    {
        return '';
    }

    /**
     * @return array<string, string>
     */
    public function getPluginDependencies(): array
    {
        return [];
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function getRoutes(): array
    {
        return [
            [
                'method' => 'GET',
                'path' => '/api/tasker/pings',
                'handler' => [$this, 'listPings'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_ping:view',
                'schema' => [
                    // operationId IS the derived MCP tool name. Never omit it.
                    'operationId' => 'list_pings',
                    'summary' => 'List the tenant\'s connectivity pings',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => 'TaskerPingListResponse',
                        403 => ['description' => 'Missing tasker_ping:view or unresolved tenant context'],
                    ],
                    'components' => self::pingComponents(),
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/pings',
                'handler' => [$this, 'createPing'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_ping:manage',
                'schema' => [
                    'operationId' => 'create_ping',
                    'summary' => 'Create a connectivity ping in the caller\'s tenant',
                    'tags' => ['tasker'],
                    'request' => 'TaskerPingCreateRequest',
                    'responses' => [
                        201 => 'TaskerPingResponse',
                        400 => ['description' => 'label missing, empty, or longer than 255 characters'],
                        403 => ['description' => 'Missing tasker_ping:manage or unresolved tenant context'],
                    ],
                    'components' => self::pingComponents(),
                ],
            ],
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
                        200 => ['description' => 'Tag already attached (idempotent)'],
                        201 => 'TaskerEntityTagResponse',
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        403 => ['description' => 'Missing tasker_ping:manage or unresolved tenant context'],
                        404 => ['description' => 'Ping not found in the caller\'s tenant'],
                        422 => ['description' => 'tag_id does not belong to the caller\'s tenant'],
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
        ];
    }

    /**
     * OpenAPI component schemas published by the ping resource.
     *
     * @return array<string, array<string, mixed>>
     */
    private static function pingComponents(): array
    {
        return [
            'TaskerPing' => [
                'type' => 'object',
                'required' => ['id', 'tenantId', 'label', 'createdAt'],
                'properties' => [
                    'id' => ['type' => 'integer'],
                    'tenantId' => ['type' => 'integer'],
                    'label' => ['type' => 'string'],
                    'createdAt' => ['type' => 'string', 'nullable' => true],
                ],
            ],
            'TaskerPingListResponse' => [
                'type' => 'object',
                'required' => ['data'],
                'properties' => [
                    'data' => [
                        'type' => 'array',
                        'items' => ['$ref' => '#/components/schemas/TaskerPing'],
                    ],
                ],
            ],
            'TaskerPingResponse' => [
                'type' => 'object',
                'required' => ['data'],
                'properties' => [
                    'data' => ['$ref' => '#/components/schemas/TaskerPing'],
                ],
            ],
            'TaskerPingCreateRequest' => [
                'type' => 'object',
                'required' => ['label'],
                'properties' => [
                    'label' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 255],
                ],
            ],
        ];
    }

    /**
     * @return list<string>
     */
    public function getPermissions(): array
    {
        return [
            'tasker_ping:view',
            'tasker_ping:manage',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function getHooks(): array
    {
        return [];
    }

    /**
     * @return list<class-string>
     */
    public function getMigrations(): array
    {
        return [
            CreateTaskerPingTable::class,
            GrantTaskerPingPermissions::class,
        ];
    }

    /**
     * GET /api/tasker/pings
     *
     * @param array<string, string> $params
     */
    public function listPings(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new PingApiHandler($this->resolvePdo()))->list($tenantId);
    }

    /**
     * POST /api/tasker/pings
     *
     * @param array<string, string> $params
     */
    public function createPing(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new PingApiHandler($this->resolvePdo()))->create($tenantId, $request->getBody());
    }

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

    /**
     * The caller's resolved tenant, or null when context is unresolved.
     */
    private function requireTenantId(): ?int
    {
        return \Whity\Core\Tenant\TenantContext::getTenantId();
    }

    /**
     * Resolve a live PDO from the host container.
     *
     * Resolved per request, never cached, so the host's connection
     * self-healing and recycling are honoured.
     */
    private function resolvePdo(): \PDO
    {
        $database = \Whity\app(\Whity\Database\Database::class);
        if (!$database instanceof \Whity\Database\Database) {
            throw new \RuntimeException('The host did not register the shared Database service');
        }

        return $database->getPdo();
    }
}
