<?php

declare(strict_types=1);

namespace Tasker;

use Tasker\Access\IdentifierResolver;
use Tasker\Api\AttentionApiHandler;
use Tasker\Api\BoardApiHandler;
use Tasker\Api\GroupsApiHandler;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Api\PingApiHandler;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\SectionsApiHandler;
use Tasker\Api\SessionApiHandler;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\AddTaskerTaskShortIdUnique;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerPingTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;
use Tasker\Migrations\CreateTaskerUserPrefsTable;
use Tasker\Migrations\GrantTaskerMilestonePermissions;
use Tasker\Migrations\GrantTaskerPingPermissions;
use Tasker\Migrations\GrantTaskerProjectPermissions;
use Tasker\Migrations\GrantTaskerTaskPermissions;
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
            [
                'method' => 'GET',
                'path' => '/api/tasker/environments',
                'handler' => [$this, 'listEnvironments'],
                // requiredRole 'admin', requiredPermission null — deliberately
                // NOT a tasker_*:manage permission. Verified by reading core's
                // own OU route registrations (host/.core/public/index.php,
                // `$router->register('GET', '/api/ous', [$ousHandler, 'list'], 'admin')`
                // et al.): core gates ALL FOUR of its own OU mutation endpoints
                // on the requiredRole 'admin' and declares NO requiredPermission
                // at all — there is no OU permission slug to "reuse verbatim"
                // because core does not have one. Mirroring core's role gate
                // exactly (rather than inventing a tasker_environment:manage
                // permission) is what keeps a caller holding ordinary Tasker
                // board permissions from mutating platform-wide OUs without
                // ever holding admin — see task-10-report.md for the full
                // verification trail.
                'requiredRole' => 'admin',
                'requiredPermission' => null,
                'schema' => [
                    'operationId' => 'list_environments',
                    'summary' => 'List the tenant\'s Environments (organizational units) — alias of core\'s OU list',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The Environment list'],
                        403 => ['description' => 'Missing the admin role or unresolved tenant context'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/environments',
                'handler' => [$this, 'createEnvironment'],
                'requiredRole' => 'admin',
                'requiredPermission' => null,
                'schema' => [
                    'operationId' => 'create_environment',
                    'summary' => 'Create an Environment (organizational unit) — alias of core\'s OU create',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['name'],
                        'properties' => [
                            'name' => ['type' => 'string', 'description' => 'Environment name'],
                            'parent_id' => ['type' => ['integer', 'null'], 'description' => 'Optional parent Environment id.'],
                            'description' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created Environment'],
                        400 => ['description' => 'name missing/empty, or a field exceeds its length limit'],
                        403 => [
                            'description' => 'Missing the admin role, unresolved tenant context, or parent_id outside the tenant '
                                . '(core reports this as 403, not 404 — this alias passes core\'s own response through unchanged)',
                        ],
                        409 => ['description' => 'An Environment with this name or slug already exists in the tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/environments',
                'handler' => [$this, 'renameEnvironment'],
                'requiredRole' => 'admin',
                'requiredPermission' => null,
                'schema' => [
                    'operationId' => 'rename_environment',
                    'summary' => 'Rename or reparent an Environment (organizational unit) — alias of core\'s OU update',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['environment_id'],
                        'properties' => [
                            'environment_id' => ['type' => ['string', 'integer'], 'description' => 'The Environment id to rename.'],
                            'name' => ['type' => 'string'],
                            'description' => ['type' => 'string'],
                            'parent_id' => ['type' => ['integer', 'null'], 'description' => 'New parent Environment id, or null to move to root.'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated Environment'],
                        400 => ['description' => 'environment_id missing, or a field exceeds its length limit'],
                        403 => [
                            'description' => 'Missing the admin role, unresolved tenant context, or the Environment does not exist in the '
                                . 'caller\'s tenant (core reports a not-found OU as 403, not 404 — this alias passes core\'s own response through unchanged)',
                        ],
                        422 => ['description' => 'Setting parent_id would create a cycle in the hierarchy'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/environments',
                'handler' => [$this, 'deleteEnvironment'],
                'requiredRole' => 'admin',
                'requiredPermission' => null,
                'schema' => [
                    'operationId' => 'delete_environment',
                    'summary' => 'Delete an Environment (organizational unit) — alias of core\'s OU delete',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['environment_id'],
                        'properties' => [
                            'environment_id' => ['type' => ['string', 'integer'], 'description' => 'The Environment id to delete.'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        400 => ['description' => 'environment_id missing'],
                        403 => [
                            'description' => 'Missing the admin role, unresolved tenant context, or the Environment does not exist in the '
                                . 'caller\'s tenant (core reports a not-found OU as 403, not 404 — this alias passes core\'s own response through unchanged)',
                        ],
                        409 => ['description' => 'The Environment has child Environments or active members and cannot be deleted'],
                    ],
                ],
            ],
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
            [
                'method' => 'GET',
                'path' => '/api/tasker/project',
                'handler' => [$this, 'getProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => 'get_project',
                    'summary' => 'Get a single project: its sections and every task, regardless of status',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'project_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.'],
                        ['name' => 'include_notes', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'boolean'], 'description' => 'Include each task\'s detail field. Defaults to false — on a large project this can be very large.'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The project, its sections, and their tasks'],
                        404 => ['description' => 'Project not found, outside OU scope, or no default project set'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/project/context',
                'handler' => [$this, 'updateProjectContext'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'update_project_context',
                    'summary' => 'Merge or replace a project\'s Foundation context',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['context'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.'],
                            'context' => [
                                'type' => 'object',
                                'description' => 'The keys to write — goal, why, scope, definition_of_done and related Foundation keys. Merged into the existing context by default (a shallow merge: a nested object you supply replaces the corresponding nested object wholesale, it does not deep-merge inner keys). Pass replace: true to discard the existing context entirely instead.',
                            ],
                            'replace' => [
                                'type' => 'boolean',
                                'description' => 'When true, context replaces the whole document instead of merging into it. Defaults to false (merge) — the original tool is used to add Foundation keys incrementally.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The project, with its updated context'],
                        400 => ['description' => 'project_id looks like a short id but is malformed, or context is missing'],
                        404 => ['description' => 'Project not found, outside OU scope, or no default project set'],
                        422 => ['description' => 'context is not a JSON object'],
                    ],
                ],
            ],
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
            [
                'method' => 'GET',
                'path' => '/api/tasker/groups',
                'handler' => [$this, 'listGroups'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_groups',
                    'summary' => 'List a section\'s groups',
                    'tags' => ['tasker'],
                    'parameters' => [
                        [
                            'name' => 'section_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            // NOT "or slug": this route resolves section_id with no
                            // parent id (see listGroups()), and resolveSection()
                            // refuses a slug without one — a slug is unique only
                            // within its parent. Advertising slug form here promised
                            // a path that cannot execute. Restoring project_id so
                            // slugs DO work is tracked separately.
                            'description' => 'Section UUID or id.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The group list'],
                        404 => ['description' => 'Section not found or outside the caller\'s tenant or OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/groups',
                'handler' => [$this, 'createGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_group',
                    'summary' => 'Create a group within a section',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['name'],
                        'properties' => [
                            // NOT "or slug" — same reason as list_groups above:
                            // createGroup() passes no parent to resolveSection(),
                            // so a slug cannot resolve on this route.
                            'section_id' => ['type' => 'string', 'description' => 'Section UUID or id.'],
                            'name' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created group'],
                        400 => ['description' => 'name missing, empty or too long'],
                        404 => ['description' => 'Section not found or outside OU scope'],
                        409 => ['description' => 'A group with this name already exists in the section'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/groups',
                'handler' => [$this, 'updateGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_group',
                    'summary' => 'Update a group\'s name or sort order',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['group_id'],
                        'properties' => [
                            'group_id' => ['type' => 'string', 'description' => 'Group UUID, id, or slug (slug requires section_id).'],
                            'section_id' => ['type' => 'string', 'description' => 'Needed only when group_id is a slug.'],
                            'name' => ['type' => 'string'],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated group'],
                        400 => ['description' => 'A supplied field is invalid'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/groups/rename',
                'handler' => [$this, 'updateGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'rename_group',
                    'summary' => 'Rename a group (alias of update_group, preserved for existing agents)',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['group_id', 'name'],
                        'properties' => [
                            'group_id' => ['type' => 'string', 'description' => 'Group UUID, id, or slug (slug requires section_id).'],
                            'section_id' => ['type' => 'string', 'description' => 'Needed only when group_id is a slug.'],
                            'name' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The renamed group'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/groups',
                'handler' => [$this, 'deleteGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_group',
                    'summary' => 'Delete a group (its tasks are un-grouped, not deleted)',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['group_id'],
                        'properties' => [
                            'group_id' => ['type' => 'string'],
                            'section_id' => ['type' => 'string', 'description' => 'Needed only when group_id is a slug.'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
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
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/tasks',
                'handler' => [$this, 'updateTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'update_task',
                    'summary' => 'Update a task\'s text, detail, priority, due_date, or status',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'text' => ['type' => 'string'],
                            'detail' => ['type' => ['string', 'null']],
                            'priority' => ['type' => ['string', 'null'], 'enum' => ['rush', 'high', 'medium', 'low', null]],
                            'due_date' => ['type' => ['string', 'null'], 'description' => 'ISO date YYYY-MM-DD, or null to clear.'],
                            'status' => [
                                'type' => 'string',
                                'enum' => ['pending', 'in_progress', 'done'],
                                'description' => 'Setting this to done stamps completed_at; setting it to pending or in_progress clears completed_at -- same as complete_task/uncomplete_task.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated task'],
                        400 => ['description' => 'text empty/too long, priority invalid, or status not one of pending/in_progress/done'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/move',
                'handler' => [$this, 'moveTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'move_task',
                    'summary' => 'Move a task to a different section/group, or reorder it',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'section_id' => ['type' => 'string'],
                            'group_id' => ['type' => ['string', 'null']],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The moved task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                        422 => ['description' => 'section_id does not belong to the task\'s own project, or group_id does not belong to the target section'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/group',
                'handler' => [$this, 'moveTaskToGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'move_task_to_group',
                    'summary' => 'Move a task into a group, or un-group it',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'group_id' => [
                                'type' => ['string', 'null'],
                                'description' => 'Group UUID, id, or slug. Omitting this key un-groups the task, exactly like passing null explicitly — there is no "leave unchanged" form.',
                            ],
                            'section_id' => [
                                'type' => 'string',
                                'description' => 'Optional. Also moves the task into this section, and is the section group_id is validated against. Defaults to the task\'s current section.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The task, in its new group'],
                        400 => ['description' => 'task_id, group_id, or section_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task, group, or section not found in the caller\'s tenant or OU scope'],
                        422 => ['description' => 'section_id does not belong to the task\'s own project, or group_id does not belong to the target section'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/tasks',
                'handler' => [$this, 'deleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:delete',
                'schema' => [
                    'operationId' => 'delete_task',
                    'summary' => 'Delete a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/complete',
                'handler' => [$this, 'completeTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'complete_task',
                    'summary' => 'Mark a task complete',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The completed task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/uncomplete',
                'handler' => [$this, 'uncompleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'uncomplete_task',
                    'summary' => 'Restore a completed task to pending',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The reopened task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/pin',
                'handler' => [$this, 'pinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'pin_task',
                    'summary' => 'Pin a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The pinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/unpin',
                'handler' => [$this, 'unpinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'unpin_task',
                    'summary' => 'Unpin a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The unpinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/tags',
                'handler' => [$this, 'tagTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'tag_task',
                    'summary' => 'Attach an existing tag to a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id', 'tag_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'tag_id' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'Tag attached'],
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/ready-work',
                'handler' => [$this, 'getReadyWork'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_ready_work',
                    'summary' => 'List a project\'s non-done tasks, ranked by what to work on next',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'project_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The ranked task list'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/board',
                'handler' => [$this, 'getBoard'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:view',
                'schema' => [
                    'operationId' => 'get_board',
                    'summary' => 'Get a project\'s full board: sections, groups, tasks, milestones',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'project_id', 'in' => 'query', 'required' => false, 'schema' => ['type' => 'string'], 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project.'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The composed board'],
                        404 => ['description' => 'Project not found, outside OU scope, or no default project set'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/task',
                'handler' => [$this, 'getTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_task',
                    'summary' => 'Get a single task, including its milestones',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'task_id', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string'], 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The task and its milestones'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/rank-tasks',
                'handler' => [$this, 'rankTasks'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'rank_tasks',
                    'summary' => 'Return non-done tasks ranked by priority then due date -- "what should I work on '
                        . 'next?". D1 dropped skip_count, so unlike the original app this cannot rank by skip-decay. '
                        . 'If project_id is omitted, your default project is used when you have one set; otherwise '
                        . 'pass confirmed: true to rank across EVERY project in your scope.',
                    'tags' => ['tasker'],
                    'parameters' => [
                        [
                            'name' => 'project_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project (falls through to confirmed if you have none).',
                        ],
                        [
                            'name' => 'confirmed',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'boolean'],
                            'description' => 'Only needed when project_id is omitted AND you have no default project set. Pass true to rank tasks across ALL projects in your scope.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The ranked task list'],
                        400 => ['description' => 'project_id looks like a short id but is malformed, or no project_id/default project was found and confirmed was not passed as true'],
                        403 => ['description' => 'Tenant context is required, or caller membership could not be resolved'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/attention',
                'handler' => [$this, 'getMyAttention'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_my_attention',
                    'summary' => 'The "what needs me?" triage for the CALLING USER\'S OWN non-done work -- not the '
                        . 'whole team\'s. Matched by created_by (tasker_tasks has no assignee column). Two buckets '
                        . 'in the response: overdue (due_date before today) and stale (in_progress and not updated '
                        . 'in 2+ days -- fixed, not configurable). Within EACH bucket, CRITICAL (pinned) tasks are '
                        . 'listed first, ahead of the bucket\'s own normal order. NOT AVAILABLE ON THIS BACKEND (the '
                        . 'original also covers these, but this schema has no such concept yet): tasks awaiting '
                        . 'review verdict, pending human guidance, and agent sessions awaiting input. A task '
                        . 'qualifying for both available buckets appears in each, not deduplicated. A completed '
                        . '(done) task appears in no bucket. project_id is optional, and omitting it means every '
                        . 'project in your OU scope -- NOT your default project, unlike every other tool in this '
                        . 'plugin.',
                    'tags' => ['tasker'],
                    'parameters' => [
                        [
                            'name' => 'project_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Project prefix, slug, UUID or id. Omit to search across every project in your OU scope (this does NOT fall back to your default project).',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The two buckets: overdue, stale'],
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
                        403 => ['description' => 'Tenant context is required, caller membership could not be resolved, or caller identity could not be resolved'],
                        404 => ['description' => 'project_id was supplied but not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/milestones',
                'handler' => [$this, 'listMilestones'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'list_milestones',
                    'summary' => 'List a task\'s milestones',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'task_id', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string'], 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The milestone list'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/milestones',
                'handler' => [$this, 'addMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'add_milestone',
                    'summary' => 'Add a milestone to a task. The milestone text is passed as text (the original '
                        . 'app\'s argument name); summary is accepted as an alias for it, and is the name this '
                        . 'backend uses for the same field in responses and in update_milestone.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        // PARITY (D1b Task 12): neither name is declared required,
                        // because either satisfies the call and core's
                        // InputSchemaValidator enforces `required` literally —
                        // naming one would reject every call that used the other.
                        // The handler 400s when both are absent.
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'text' => ['type' => 'string', 'description' => 'Milestone text.'],
                            'summary' => ['type' => 'string', 'description' => 'Alias of text, kept because it is this backend\'s own field name. text wins if both are sent.'],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created milestone'],
                        400 => ['description' => 'text (and its summary alias) missing, empty, or too long'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/milestones/complete',
                'handler' => [$this, 'completeMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'complete_milestone',
                    'summary' => 'Mark a milestone complete',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'milestone_id' => ['type' => 'string', 'description' => 'Milestone UUID or id. Preferred over index — stable under reordering.'],
                            'index' => ['type' => 'integer', 'description' => 'Zero-based position within the task\'s milestones. Supported for compatibility; racy if milestones are being reordered concurrently.'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The completed milestone'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/milestones/uncomplete',
                'handler' => [$this, 'uncompleteMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'uncomplete_milestone',
                    'summary' => 'Restore a completed milestone to incomplete',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'milestone_id' => ['type' => 'string', 'description' => 'Milestone UUID or id. Preferred over index — stable under reordering.'],
                            'index' => ['type' => 'integer', 'description' => 'Zero-based position within the task\'s milestones. Supported for compatibility; racy if milestones are being reordered concurrently.'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The reopened milestone'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/milestones',
                'handler' => [$this, 'updateMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'update_milestone',
                    'summary' => 'Update a milestone\'s summary, detail, or sort_order',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'milestone_id' => ['type' => 'string', 'description' => 'Milestone UUID or id. Preferred over index — stable under reordering.'],
                            'index' => ['type' => 'integer', 'description' => 'Zero-based position within the task\'s milestones. Supported for compatibility; racy if milestones are being reordered concurrently.'],
                            'summary' => ['type' => 'string'],
                            'detail' => ['type' => ['string', 'null']],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated milestone'],
                        400 => ['description' => 'summary empty or too long'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/milestones',
                'handler' => [$this, 'deleteMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'delete_milestone',
                    'summary' => 'Delete a milestone',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'milestone_id' => ['type' => 'string', 'description' => 'Milestone UUID or id. Preferred over index — stable under reordering.'],
                            'index' => ['type' => 'integer', 'description' => 'Zero-based position within the task\'s milestones. Supported for compatibility; racy if milestones are being reordered concurrently.'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks/discussion',
                'handler' => [$this, 'getDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_task_discussion',
                    'summary' => 'Read a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'task_id', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string'], 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The discussion (empty shape if none yet)'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PUT',
                'path' => '/api/tasker/tasks/discussion',
                'handler' => [$this, 'putDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'set_task_discussion',
                    'summary' => 'Save a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'messages' => ['type' => 'array'],
                            'reason' => ['type' => ['string', 'null']],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The saved discussion'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
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
            'tasker_project:view',
            'tasker_project:manage',
            'tasker_structure:manage',
            'tasker_task:view',
            'tasker_task:edit',
            'tasker_task:complete',
            'tasker_task:delete',
            'tasker_milestone:edit',
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
            CreateTaskerProjectsTable::class,
            CreateTaskerSectionsTable::class,
            CreateTaskerGroupsTable::class,
            GrantTaskerProjectPermissions::class,
            CreateTaskerTasksTable::class,
            AddTaskerTaskShortIdUnique::class,
            GrantTaskerTaskPermissions::class,
            CreateTaskerMilestonesTable::class,
            GrantTaskerMilestonePermissions::class,
            CreateTaskerTaskDiscussionsTable::class,
            CreateTaskerUserPrefsTable::class,
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
     * GET /api/tasker/environments — alias of core's OU list (D1b Task 10).
     *
     * Delegates rather than querying organizational_units directly: core
     * dispatches ou.* hooks on every OU mutation and its own AuditLogger
     * subscribes to them, so writing directly would silently drop OU changes
     * out of the platform audit trail (see {@see self::ousHandler()}'s own
     * docblock for the full verification trail on that claim).
     *
     * No OU-scope narrowing is applied here (unlike listProjects()'s
     * resolveCallerOu() call): Environments ARE the organizational units
     * themselves, and core's own OU admin surface lists every OU in the
     * tenant for an 'admin'-role caller with no OU-subtree restriction —
     * mirrored here rather than invented, per this task's ruling against
     * building Tasker-side OU resolution.
     *
     * @param array<string, string> $params
     */
    public function listEnvironments(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        try {
            return $this->ousHandler()->list($this->toHostRequest($request));
        } catch (\Throwable $e) {
            // Ruling #4: an uncaught throw is an uncontrolled error path this
            // slice's error discipline does not allow anywhere else. The one
            // concrete case this guards today is ousHandler() failing to
            // resolve a live HookManager/Database from the container. Logged
            // (review finding, Important #2) because catching here bypasses
            // the host's own error boundary (PluginLoader::wrapHandler()),
            // which would otherwise be the only place this failure surfaces
            // with a stack trace at all.
            $this->logEnvironmentAliasFailure('listEnvironments', $tenantId, $e);
            return Response::error('Environments are temporarily unavailable', 500);
        }
    }

    /**
     * POST /api/tasker/environments — alias of core's OU create (D1b Task 10).
     *
     * The body is forwarded to core's OusApiHandler::create() UNCHANGED: it
     * reads 'name' (required), 'parent_id' and 'description' straight off the
     * JSON body itself (verified by reading OusApiHandler::create()'s source
     * — see task-10-report.md), so this alias performs no field renaming or
     * translation, consistent with the brief's "thin alias, no new handler"
     * framing. Only rename_environment/delete_environment need a translation
     * step, because THEIR target handlers (update()/delete()) read the OU id
     * out of a route `{id}` path parameter that this flat, path-parameter-free
     * alias does not have.
     *
     * @param array<string, string> $params
     */
    public function createEnvironment(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        try {
            return $this->ousHandler()->create($this->toHostRequest($request));
        } catch (\Throwable $e) {
            $this->logEnvironmentAliasFailure('createEnvironment', $tenantId, $e);
            return Response::error('Environments are temporarily unavailable', 500);
        }
    }

    /**
     * PATCH /api/tasker/environments — alias of core's OU update (D1b Task 10).
     *
     * core's OusApiHandler::update(Request $request, array $params) reads the
     * target OU id from `$params['id']` (its own routing supplies it via a
     * `{id:\d+}` path segment — host/.core/public/index.php registers
     * `PATCH /api/ous/{id:\d+}` against this exact method). This alias is
     * flat and carries no path parameters at all (ruling #3), so
     * environment_id travels in the body like every other Tasker identifier
     * and is translated into the one key OusApiHandler::update() actually
     * reads — the only identifier mapping this task performs, and the OU id
     * is used completely opaquely (never resolved, classified, or otherwise
     * interpreted by Tasker) per ruling #2.
     *
     * Review finding (promoted from Minor): core's OWN routing constrains the
     * id with a `{id:\d+}` path pattern, so a non-numeric value never reaches
     * OusApiHandler::update() over core's own API. This flat alias has no
     * such pattern to lean on, so a non-numeric environment_id (e.g. an agent
     * passing an Environment NAME where an id is expected — a very plausible
     * MCP call) would otherwise reach Postgres as an integer comparison,
     * throw, and surface as a 500 via OusApiHandler's own catch. Rejected
     * here with a clean 400 instead. `environment_id: 0` / `"0"` are digit
     * strings and pass this check unchanged, exactly like today — they still
     * 400 downstream via OusApiHandler's own `if (!$id)` guard, not this one.
     *
     * @param array<string, string> $params
     */
    public function renameEnvironment(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $environmentId = $this->identifierFromRequest($request, 'environment_id');
        if ($environmentId === null) {
            return Response::error('environment_id is required', 400);
        }
        if (!ctype_digit((string) $environmentId)) {
            return Response::error('environment_id must be numeric', 400);
        }

        try {
            return $this->ousHandler()->update($this->toHostRequest($request), ['id' => (string) $environmentId]);
        } catch (\Throwable $e) {
            $this->logEnvironmentAliasFailure('renameEnvironment', $tenantId, $e);
            return Response::error('Environments are temporarily unavailable', 500);
        }
    }

    /**
     * DELETE /api/tasker/environments — alias of core's OU delete (D1b Task 10).
     *
     * MUST read environment_id via identifierFromRequest(), never the body
     * alone: core's MCP transport merges every remaining tool argument into
     * the query string and empties the body for GET/DELETE/HEAD calls (see
     * identifierFromRequest()'s own docblock), so a body-only read would 400
     * on every real MCP delete_environment call — exactly the mistake that
     * shipped once already in this slice for delete_project.
     *
     * Review finding (promoted from Minor): same non-numeric guard as
     * renameEnvironment() above, for the same reason (core's `{id:\d+}` path
     * pattern has no equivalent on this flat alias) — see that method's
     * docblock.
     *
     * @param array<string, string> $params
     */
    public function deleteEnvironment(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $environmentId = $this->identifierFromRequest($request, 'environment_id');
        if ($environmentId === null) {
            return Response::error('environment_id is required', 400);
        }
        if (!ctype_digit((string) $environmentId)) {
            return Response::error('environment_id must be numeric', 400);
        }

        try {
            return $this->ousHandler()->delete($this->toHostRequest($request), ['id' => (string) $environmentId]);
        } catch (\Throwable $e) {
            $this->logEnvironmentAliasFailure('deleteEnvironment', $tenantId, $e);
            return Response::error('Environments are temporarily unavailable', 500);
        }
    }

    /**
     * Build a core OusApiHandler wired to the host's real, container-shared
     * HookManager — never a Tasker-local instance — so create/update/delete
     * dispatch the SAME `ou.*` hooks core's own admin routes do, keeping the
     * host's audit trail and any other ou.* subscriber intact.
     *
     * VERIFIED NAMESPACE (D1b Task 10): the brief that sketched this method
     * inferred `Whity\Core\HookManager` from the registration line alone and
     * flagged it as unverified. Grepping host/.core/public/index.php's own
     * `use` statement shows the real class is `Whity\Core\Hooks\HookManager`
     * (note the extra `Hooks` segment) — confirmed at the registration site
     * itself: `use Whity\Core\Hooks\HookManager;` then
     * `\Whity\register_service(HookManager::class, $hookManager);`. The
     * brief's guessed namespace would have made this method's own
     * `instanceof` check always false and every environment alias 500 on
     * every call.
     *
     * @throws \RuntimeException When the host has not registered the shared
     *   HookManager (or Database — via resolvePdo()) service. Every caller
     *   above catches \Throwable around this call (ruling #4): this method is
     *   never allowed to let an exception escape a route method.
     */
    private function ousHandler(): \Whity\Api\OusApiHandler
    {
        $hooks = \Whity\app(\Whity\Core\Hooks\HookManager::class);
        if (!$hooks instanceof \Whity\Core\Hooks\HookManager) {
            throw new \RuntimeException('The host did not register the shared HookManager service');
        }

        return new \Whity\Api\OusApiHandler($this->resolvePdo(), $hooks);
    }

    /**
     * Adapt an incoming SDK-typed Request into the core Request type
     * OusApiHandler's methods actually type-hint.
     *
     * REVIEW FIX (Important #1): the first version of this alias REJECTED
     * (500) any request that was not already a `\Whity\Core\Request`
     * instance. That silently broke `list_environments` (and, over the same
     * transport, every one of these four aliases) called via the MCP
     * `resources/read` transport specifically: every GET route with a
     * non-empty `schema` is auto-derived into an MCP resource
     * (`Whity\Mcp\Resources\ResourceDeriver`), and
     * `Whity\Mcp\Resources\ResourcesReadHandler::buildRequest()` constructs
     * its synthesized Request from the SDK's OWN `Whity\Sdk\Http\Request`
     * class directly — never the `Whity\Core\Request` subclass the HTTP
     * kernel (`Request::fromGlobals(): static`) and `tools/call`
     * (`Whity\Mcp\Tools\ToolsCallHandler`, which imports the core class) both
     * pass. This plugin's OTHER pre-existing GET routes never hit this
     * because none of them narrow the request type at all; these four
     * aliases are the first that do, because OusApiHandler itself
     * type-hints `\Whity\Core\Request` (an empty subclass of the SDK's own
     * type — verified directly against host/.core/src/Core/Request.php).
     *
     * Re-wrapping rather than rejecting is safe precisely because
     * `\Whity\Core\Request` adds nothing over the SDK base class: every
     * accessor OusApiHandler/JsonBody/PaginationParams actually call
     * (getMethod/getPath/getHeaders/getBody) is carried across unchanged,
     * including the query string embedded in getPath() — queryParam() (and,
     * through it, identifierFromRequest(), which deleteEnvironment() depends
     * on for its query-string-only MCP transport shape) parses that string,
     * not a structured object, so nothing is lost by rebuilding it. There is
     * no security concern in doing this: resources/read applies the exact
     * same requiredRole gate as every other transport
     * (`ResourcesReadHandler`'s own RBAC check).
     *
     * An already-correct `\Whity\Core\Request` (the HTTP and tools/call
     * paths) is returned unchanged rather than needlessly rebuilt.
     */
    private function toHostRequest(Request $request): \Whity\Core\Request
    {
        if ($request instanceof \Whity\Core\Request) {
            return $request;
        }

        return new \Whity\Core\Request(
            $request->getMethod(),
            $request->getPath(),
            $request->getHeaders(),
            $request->getBody()
        );
    }

    /**
     * Log an environment-alias failure before returning the generic 500.
     *
     * REVIEW FIX (Important #2): ruling #4 requires every route method to
     * catch \Throwable around its OusApiHandler delegation rather than let it
     * escape (see each catch block above). That catch has a cost the ruling
     * did not account for: it runs BEFORE the host's own error boundary,
     * `Whity\Core\PluginLoader::wrapHandler()`, which is what normally logs a
     * structured entry (message, stack trace, tenant_id) and records the
     * failure against the plugin's lifecycle. Catching here silently
     * prevents that from ever happening — the exact failure this guards
     * against (an unregistered HookManager/Database service) would otherwise
     * reach production as "Environments are temporarily unavailable" with
     * ZERO diagnostics anywhere. Logged via error_log(), matching the
     * pattern OusApiHandler's own catch blocks already use
     * (`error_log('[OusApiHandler] create failed: ...')`) rather than
     * inventing a second logging convention. The response body stays
     * generic; only this log line carries the exception detail.
     */
    private function logEnvironmentAliasFailure(string $method, ?int $tenantId, \Throwable $e): void
    {
        error_log(sprintf(
            '[TaskerPlugin] %s failed: tenant_id=%s %s: %s',
            $method,
            var_export($tenantId, true),
            get_class($e),
            $e->getMessage()
        ));
    }

    /**
     * GET /api/tasker/projects
     *
     * @param array<string, string> $params
     */
    public function listProjects(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Tenant context is required', 403);
        }

        return (new ProjectsApiHandler($pdo))->list($tenantId, $callerOu['ouId']);
    }

    /**
     * POST /api/tasker/projects
     *
     * @param array<string, string> $params
     */
    public function createProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Tenant context is required', 403);
        }
        $createdBy = $this->callerProfileId($request) ?? 0;

        return (new ProjectsApiHandler($pdo))
            ->create($tenantId, $callerOu['ouId'], $createdBy, $request->getBody());
    }

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

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $raw = $this->identifierFromRequest($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        return (new ProjectsApiHandler($pdo))->update($tenantId, $ou['ouId'], $projectId, $request->getBody());
    }

    /**
     * DELETE /api/tasker/projects
     *
     * NOTE: this handler deliberately does NOT require the body to decode
     * as a JSON object the way updateProject() does — see
     * {@see self::identifierFromRequest()}'s docblock for why a DELETE
     * request here may legitimately carry no body at all.
     *
     * @param array<string, string> $params
     */
    public function deleteProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->identifierFromRequest($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        return (new ProjectsApiHandler($pdo))->delete($tenantId, $ou['ouId'], $projectId);
    }

    /**
     * GET /api/tasker/project?project_id=&include_notes= — the original's
     * get_project.
     *
     * project_id is optional and falls back to the caller's default project —
     * mirrors getBoard()'s/listSections()'s own shape exactly ("read my
     * current project" is precisely the call an agent makes first).
     * include_notes is an optional query-string boolean, defaulting to false
     * — see {@see self::queryParamBool()} for why a naive `(bool)` cast on
     * the raw string is wrong.
     *
     * @param array<string, string> $params
     */
    public function getProject(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $callerOu['ouId'],
            $raw,
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        $includeNotes = $this->queryParamBool($request, 'include_notes', false);

        return (new ProjectsApiHandler($pdo))->getOne($tenantId, $callerOu['ouId'], $projectId, $includeNotes);
    }

    /**
     * PATCH /api/tasker/project/context — the original's
     * update_project_context.
     *
     * project_id is optional (D1b Task 9 brief resolution #9), matching
     * getProject()/getBoard()/listSections()'s own shape exactly — resolved
     * via identifierFromRequest() (body-then-query) rather than
     * queryParam(), since this is a body-carrying PATCH like updateProject()
     * above, not a bare GET.
     *
     * `replace` (this route's own body field) is the INVERSE of
     * ProjectsApiHandler::updateContext()'s `$merge` parameter (D1b Task 9
     * brief resolution #5) — the inversion itself is
     * {@see self::mergeFromReplace()}, extracted (not inlined here) so it
     * gets a direct unit test; see that method's own docblock for why.
     *
     * `context` must be a genuine JSON object (D1b Task 9 brief resolution
     * #8) — checked via the pure {@see self::isJsonObject()} BEFORE
     * project_id is even resolved, so a malformed context 422s regardless of
     * which project it would have targeted.
     *
     * @param array<string, string> $params
     */
    public function updateProjectContext(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        if (!array_key_exists('context', $decoded)) {
            return Response::error('context is required', 400);
        }
        if (!self::isJsonObject($decoded['context'])) {
            return Response::error('context must be a JSON object', 422);
        }
        /** @var array<string, mixed> $context */
        $context = $decoded['context'];

        $raw = $this->identifierFromRequest($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        $merge = $this->mergeFromReplace($decoded);

        return (new ProjectsApiHandler($pdo))->updateContext($tenantId, $ou['ouId'], $projectId, $context, $merge);
    }

    /**
     * GET /api/tasker/sections?project_id=
     *
     * project_id is optional and falls back to the caller's default project —
     * mirrors listProjects()/updateProject()'s shape, but reads the
     * identifier via queryParam() rather than identifierFromRequest() since a
     * GET request carries no body to check first.
     *
     * @param array<string, string> $params
     */
    public function listSections(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        return (new SectionsApiHandler($pdo))->list($tenantId, $ou['ouId'], $projectId);
    }

    /**
     * POST /api/tasker/sections
     *
     * project_id lives in the body (identifierFromRequest reads body then
     * query) and is optional, falling back to the caller's default project.
     *
     * @param array<string, string> $params
     */
    public function createSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->identifierFromRequest($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        return (new SectionsApiHandler($pdo))
            ->create($tenantId, $ou['ouId'], $projectId, $request->getBody());
    }

    /**
     * PATCH /api/tasker/sections
     * POST /api/tasker/sections/rename (rename_section alias — same handler,
     * different operationId/path; the router rejects two operationIds on one
     * method+path)
     *
     * section_id is required; project_id is read only to resolve section_id
     * when it is a slug (slugs are unique only within their project) — see
     * IdentifierResolver::resolveSection()'s $projectId parameter.
     *
     * @param array<string, string> $params
     */
    public function updateSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $rawSectionId = $this->identifierFromRequest($request, 'section_id');
        if (IdentifierResolver::classify($rawSectionId) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'project_id',
            [IdentifierResolver::class, 'resolveProject']
        );
        if (!$parent['ok']) {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $rawSectionId, $parent['value']);
        if ($sectionId === null) {
            return Response::error('Section not found', 404);
        }

        return (new SectionsApiHandler($pdo))->update($tenantId, $sectionId, $request->getBody());
    }

    /**
     * DELETE /api/tasker/sections
     *
     * NOTE: deliberately does NOT require the body to decode as a JSON
     * object the way updateSection() does — see
     * {@see self::identifierFromRequest()}'s docblock for why a DELETE
     * request here may legitimately carry no body at all.
     *
     * @param array<string, string> $params
     */
    public function deleteSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawSectionId = $this->identifierFromRequest($request, 'section_id');
        if (IdentifierResolver::classify($rawSectionId) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'project_id',
            [IdentifierResolver::class, 'resolveProject']
        );
        if (!$parent['ok']) {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $rawSectionId, $parent['value']);
        if ($sectionId === null) {
            return Response::error('Section not found', 404);
        }

        return (new SectionsApiHandler($pdo))->delete($tenantId, $sectionId);
    }

    /**
     * GET /api/tasker/groups?section_id=
     *
     * Unlike project_id on listSections(), section_id has no "default
     * section" fallback to fall back to (tasker_user_prefs stores only a
     * default PROJECT) — an omitted or unresolved section_id always 404s.
     * The existence check this relies on (GroupsApiHandler::list() calling
     * sectionVisible() before querying) is D1 Task 4 fix-round behaviour and
     * is unchanged here.
     *
     * @param array<string, string> $params
     */
    public function listGroups(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'section_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $raw);
        if ($sectionId === null) {
            return Response::error('Section not found', 404);
        }

        return (new GroupsApiHandler($pdo))->list($tenantId, $ou['ouId'], $sectionId);
    }

    /**
     * POST /api/tasker/groups
     *
     * section_id lives in the body and is required (no default-section
     * fallback exists — see listGroups()'s docblock).
     *
     * @param array<string, string> $params
     */
    public function createGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->identifierFromRequest($request, 'section_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $raw);
        if ($sectionId === null) {
            return Response::error('Section not found', 404);
        }

        return (new GroupsApiHandler($pdo))
            ->create($tenantId, $ou['ouId'], $sectionId, $request->getBody());
    }

    /**
     * PATCH /api/tasker/groups
     * POST /api/tasker/groups/rename (rename_group alias — same handler,
     * different operationId/path)
     *
     * group_id is required; section_id is read only to resolve group_id when
     * it is a slug (slugs are unique only within their section) — see
     * IdentifierResolver::resolveGroup()'s $sectionId parameter. The
     * supplied section_id is itself resolved through resolveSection() (with
     * no project parent) before being handed to resolveGroup() as an
     * integer, per resolveGroup()'s own signature.
     *
     * @param array<string, string> $params
     */
    public function updateGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $rawGroupId = $this->identifierFromRequest($request, 'group_id');
        if (IdentifierResolver::classify($rawGroupId) === 'malformed_short_id') {
            return Response::error('group_id looks like a short id but is malformed', 400);
        }

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'section_id',
            [IdentifierResolver::class, 'resolveSection']
        );
        if (!$parent['ok']) {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $groupId = IdentifierResolver::resolveGroup($pdo, $tenantId, $ou['ouId'], $rawGroupId, $parent['value']);
        if ($groupId === null) {
            return Response::error('Group not found', 404);
        }

        return (new GroupsApiHandler($pdo))->update($tenantId, $groupId, $request->getBody());
    }

    /**
     * DELETE /api/tasker/groups
     *
     * NOTE: deliberately does NOT require the body to decode as a JSON
     * object the way updateGroup() does — see
     * {@see self::identifierFromRequest()}'s docblock for why a DELETE
     * request here may legitimately carry no body at all.
     *
     * @param array<string, string> $params
     */
    public function deleteGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawGroupId = $this->identifierFromRequest($request, 'group_id');
        if (IdentifierResolver::classify($rawGroupId) === 'malformed_short_id') {
            return Response::error('group_id looks like a short id but is malformed', 400);
        }

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'section_id',
            [IdentifierResolver::class, 'resolveSection']
        );
        if (!$parent['ok']) {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $groupId = IdentifierResolver::resolveGroup($pdo, $tenantId, $ou['ouId'], $rawGroupId, $parent['value']);
        if ($groupId === null) {
            return Response::error('Group not found', 404);
        }

        return (new GroupsApiHandler($pdo))->delete($tenantId, $groupId);
    }

    /**
     * GET /api/tasker/tasks?project_id=&section_id=&group_id=&status=
     *
     * project_id follows listSections()'s own shape exactly (optional,
     * falling back to the caller's default project, 404 if neither
     * resolves). section_id and group_id have no such default (there is no
     * "default section/group" concept) — they stay pure optional filters,
     * resolved only when supplied, each scoped to whichever parent was
     * already resolved above it (section_id under project_id, group_id
     * under section_id) so a slug form remains unambiguous.
     *
     * status is passed through as-is (null when the query param is
     * omitted) rather than defaulted to the literal string 'pending' here —
     * see {@see \Tasker\Api\TasksApiHandler::listFiltered()}'s own docblock
     * for why: null means "everything except done" (the original's actual
     * documented default), which is NOT the same predicate as an explicit
     * 'pending'. Only validated (never defaulted) when the caller supplies
     * a value at all.
     *
     * @param array<string, string> $params
     */
    public function listTasks(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawProject = $this->queryParam($request, 'project_id');
        if (IdentifierResolver::classify($rawProject) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }
        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $ou['ouId'],
            $rawProject,
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        $rawSection = $this->queryParam($request, 'section_id');
        if (IdentifierResolver::classify($rawSection) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }
        $sectionId = null;
        if (IdentifierResolver::classify($rawSection) !== 'empty') {
            $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $rawSection, $projectId);
            if ($sectionId === null) {
                return Response::error('Section not found', 404);
            }
        }

        $rawGroup = $this->queryParam($request, 'group_id');
        if (IdentifierResolver::classify($rawGroup) === 'malformed_short_id') {
            return Response::error('group_id looks like a short id but is malformed', 400);
        }
        $groupId = null;
        if (IdentifierResolver::classify($rawGroup) !== 'empty') {
            $groupId = IdentifierResolver::resolveGroup($pdo, $tenantId, $ou['ouId'], $rawGroup, $sectionId);
            if ($groupId === null) {
                return Response::error('Group not found', 404);
            }
        }

        $status = $this->queryParam($request, 'status');
        if ($status !== null && !in_array($status, ['pending', 'in_progress', 'done', 'all'], true)) {
            return Response::error('status must be one of: pending, in_progress, done, all', 400);
        }

        return (new TasksApiHandler($pdo))->listFiltered($tenantId, $projectId, $sectionId, $groupId, $status);
    }

    /**
     * POST /api/tasker/tasks
     *
     * project_id is optional (falls back to the caller's default project,
     * like createSection()). section_id is ALSO optional here — new
     * behaviour for D1b: when omitted, the task defaults into the resolved
     * project's Backlog section (slug 'backlog'), since tasker_tasks.section_id
     * is NOT NULL by design (the original's "ungrouped if omitted" has no
     * literal equivalent). 404s if the resolved project has no backlog
     * section at all — impossible for a project created through
     * create_project (which always seeds one), but reachable for an
     * imported project that never got one.
     *
     * @param array<string, string> $params
     */
    public function createTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawProject = $this->identifierFromRequest($request, 'project_id');
        if (IdentifierResolver::classify($rawProject) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }
        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $ou['ouId'],
            $rawProject,
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        $section = $this->resolveCreateTaskSectionId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            $projectId,
            [IdentifierResolver::class, 'resolveSection']
        );
        if (!$section['ok']) {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }
        if ($section['value'] === null) {
            return $section['usedBacklogFallback']
                ? Response::error('Project has no backlog section', 404)
                : Response::error('Section not found', 404);
        }

        $createdBy = $this->callerProfileId($request) ?? 0;

        return (new TasksApiHandler($pdo))
            ->create($tenantId, $ou['ouId'], $section['value'], $createdBy, $request->getBody());
    }

    /**
     * PATCH /api/tasker/tasks
     *
     * @param array<string, string> $params
     */
    public function updateTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->update($tenantId, $taskId, $request->getBody());
    }

    /**
     * POST /api/tasker/tasks/move
     *
     * section_id/group_id are flexible identifiers (UUID/id — see
     * {@see self::resolveMoveDestinationId()}), exactly like every other
     * identifier and filter in this task's routes, NOT bare integers:
     * {@see \Tasker\Api\TasksApiHandler::move()} itself only ever does a
     * plain `(int)` cast on whatever it is handed, which silently casts a
     * UUID/slug to 0 and 422s. Both are resolved HERE, before delegating,
     * the same way list_tasks resolves its own section_id/group_id filters
     * — the resolved integers are substituted back into the JSON body move()
     * decodes, so move()'s own array_key_exists()-based "supplied vs not
     * supplied"/"explicit null means un-group" logic (see its own docblock)
     * needs no change at all.
     *
     * @param array<string, string> $params
     */
    public function moveTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        $section = $this->resolveMoveDestinationId(
            $decoded,
            'section_id',
            $pdo,
            $tenantId,
            $ou['ouId'],
            [IdentifierResolver::class, 'resolveSection']
        );
        if ($section['status'] === 'malformed') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }
        if ($section['status'] === 'unresolved') {
            return Response::error('Section not found', 404);
        }
        if ($section['status'] === 'resolved') {
            $decoded['section_id'] = $section['value'];
        }

        $group = $this->resolveMoveDestinationId(
            $decoded,
            'group_id',
            $pdo,
            $tenantId,
            $ou['ouId'],
            [IdentifierResolver::class, 'resolveGroup']
        );
        if ($group['status'] === 'malformed') {
            return Response::error('group_id looks like a short id but is malformed', 400);
        }
        if ($group['status'] === 'unresolved') {
            return Response::error('Group not found', 404);
        }
        if ($group['status'] === 'resolved') {
            $decoded['group_id'] = $group['value'];
        }
        // 'absent' -> key untouched in $decoded (move() sees no key at all).
        // 'explicit_null' -> $decoded['group_id'] is already null (move()'s
        // own "explicit null means un-group" semantics preserved exactly).

        $reencoded = json_encode($decoded);
        if ($reencoded === false) {
            return Response::error('Request body must be a JSON object', 400);
        }

        return (new TasksApiHandler($pdo))->move($tenantId, $taskId, $reencoded);
    }

    /**
     * POST /api/tasker/tasks/group — the original's move_task_to_group:
     * group membership only, deliberately narrower than moveTask()'s
     * combined section/group/sort_order scope above.
     *
     * group_id ABSENT and group_id EXPLICIT NULL both un-group (D1b Task 9
     * brief resolution #3) — see {@see self::resolveGroupMembership()}'s own
     * docblock for why this is a deliberate divergence from moveTask()'s own
     * 'absent' handling right above, which must keep "absent" and "explicit
     * null" distinct for move_task's different (and separately carry-over-
     * buggy — see {@see \Tasker\Api\TasksApiHandler::move()}'s own docblock)
     * group_id semantics.
     *
     * Delegates to {@see \Tasker\Api\TasksApiHandler::moveToGroup()}, which
     * is OU-aware (D1b Task 9 brief resolution #2) — this route resolves
     * $ou['ouId'] the same way every other OU-aware route in this class
     * does, and passes it straight through.
     *
     * @param array<string, string> $params
     */
    public function moveTaskToGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded)) {
            return Response::error('Request body must be a JSON object', 400);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        // Optional: no "leave unchanged" meaning is lost by collapsing
        // 'absent'/'explicit_null' to the same null value here the way
        // resolveGroupMembership() must for group_id below — a task simply
        // stays in its current section when this key is not supplied.
        $section = $this->resolveMoveDestinationId(
            $decoded,
            'section_id',
            $pdo,
            $tenantId,
            $ou['ouId'],
            [IdentifierResolver::class, 'resolveSection']
        );
        if ($section['status'] === 'malformed') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }
        if ($section['status'] === 'unresolved') {
            return Response::error('Section not found', 404);
        }
        $sectionId = $section['status'] === 'resolved' ? $section['value'] : null;

        $group = $this->resolveGroupMembership(
            $decoded,
            $pdo,
            $tenantId,
            $ou['ouId'],
            [IdentifierResolver::class, 'resolveGroup']
        );
        if ($group['status'] === 'malformed') {
            return Response::error('group_id looks like a short id but is malformed', 400);
        }
        if ($group['status'] === 'unresolved') {
            return Response::error('Group not found', 404);
        }
        // 'ungroup' (absent OR explicit null) and 'resolved' both carry the
        // right value directly — null for the former, a real id for the
        // latter — with no further mapping needed here.
        $groupId = $group['value'];

        return (new TasksApiHandler($pdo))->moveToGroup($tenantId, $ou['ouId'], $taskId, $groupId, $sectionId);
    }

    /**
     * DELETE /api/tasker/tasks
     *
     * NOTE: deliberately does NOT require the body to decode as a JSON
     * object — see {@see self::identifierFromRequest()}'s docblock for why a
     * DELETE request here may legitimately carry no body at all, and reads
     * task_id via identifierFromRequest() (body-then-query) rather than the
     * body alone for the same reason.
     *
     * @param array<string, string> $params
     */
    public function deleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->delete($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/complete
     *
     * @param array<string, string> $params
     */
    public function completeTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->complete($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/uncomplete
     *
     * @param array<string, string> $params
     */
    public function uncompleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->uncomplete($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/pin
     *
     * @param array<string, string> $params
     */
    public function pinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->pin($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/unpin
     *
     * @param array<string, string> $params
     */
    public function unpinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->unpin($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/tasks/tags
     *
     * @param array<string, string> $params
     */
    public function tagTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->tag($tenantId, $taskId, $request->getBody());
    }

    /**
     * GET /api/tasker/ready-work?project_id=
     *
     * project_id follows listSections()'s own shape exactly (optional,
     * falling back to the caller's default project, 404 if neither
     * resolves).
     *
     * @param array<string, string> $params
     */
    public function getReadyWork(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

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

        return (new TasksApiHandler($pdo))->readyWork($tenantId, $ou['ouId'], $projectId);
    }

    /**
     * GET /api/tasker/board?project_id=
     *
     * project_id is optional and falls back to the caller's default project —
     * mirrors listSections()'s own shape exactly.
     *
     * @param array<string, string> $params
     */
    public function getBoard(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $callerOu['ouId'],
            $raw,
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if ($projectId === null) {
            return Response::error('Project not found', 404);
        }

        return (new BoardApiHandler($pdo))->get($tenantId, $callerOu['ouId'], $projectId);
    }

    /**
     * GET /api/tasker/task?task_id= — the original's get_task.
     *
     * task_id is required — a single task has no "default" fallback the way
     * a project does. Resolved via IdentifierResolver::resolveTask() (itself
     * OU-scoped) BEFORE ever reaching TasksApiHandler::getOne(), which ALSO
     * re-checks OU scope itself — belt-and-braces, matching every other
     * OU-aware handler method in this codebase (see that method's own
     * docblock for why get_task specifically needs this, unlike its
     * tenant-scoped-only siblings update_task/move_task/etc.).
     *
     * @param array<string, string> $params
     */
    public function getTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->queryParam($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->getOne($tenantId, $ou['ouId'], $taskId);
    }

    /**
     * GET /api/tasker/rank-tasks?project_id=&confirmed= — the original's
     * rank_tasks, matched against the LIVE original MCP server (D1b Task 11
     * round 2 — the earlier `rank_by` design was this task's own invention,
     * based on a stale docs page, and has been withdrawn in full; see
     * AttentionApiHandler's own class docblock for the full correction).
     *
     * The live contract's own words: "If no project_id is provided, the
     * user's default project is used when set; otherwise this requires
     * confirmed: true to rank across ALL projects." Four cases, in order:
     *
     *   1. project_id supplied, resolves         -> rank that project.
     *   2. project_id supplied, does NOT resolve -> 404 (wrong tenant/OU scope).
     *   3. project_id omitted, caller HAS a default project -> rank the
     *      default (re-validated through the same OU-scoped resolveProject()
     *      call every other route's default-project fallback uses — a stale
     *      default that has since left OU scope is never trusted directly,
     *      matching every sibling route's own established behaviour of
     *      treating "no identifier and no IN-SCOPE default" as one and the
     *      same outcome, not a distinct case of its own).
     *   4. project_id omitted, caller has NO in-scope default project:
     *      4a. confirmed=true  -> rank across every project in OU scope.
     *      4b. confirmed absent/false -> 400 naming `confirmed` as the way
     *          to proceed, never a silent "rank nothing" or a silent
     *          all-projects scan an agent did not ask for.
     *
     * Cases 3/4 (project_id genuinely omitted) are decided by
     * {@see self::resolveRankTasksOmittedProjectId()}, a pure composition
     * helper extracted for the same reason resolveCreateTaskSectionId()/
     * resolveGroupMembership()/mergeFromReplace() elsewhere in this file
     * are: this route method itself calls resolvePdo(), making it otherwise
     * unreachable from PHPUnit — see TaskerPluginTest for that helper's own
     * direct Reflection coverage of all three of ITS outcomes. Case 1's
     * single-project path and case 4a's all-projects path are both proven
     * against real Postgres in TenantIsolationOuTest via
     * AttentionApiHandler::rank() directly (bypassing this route method,
     * the same split every other resolvePdo()-calling route in this file
     * uses for its own test coverage).
     *
     * @param array<string, string> $params
     */
    public function rankTasks(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        $form = IdentifierResolver::classify($raw);
        if ($form === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        if ($form !== 'empty') {
            $projectId = IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $raw);
            if ($projectId === null) {
                return Response::error('Project not found', 404);
            }

            return (new AttentionApiHandler($pdo))->rank($tenantId, $ou['ouId'], $projectId);
        }

        // project_id omitted: re-validate the caller's stored default (if
        // any) through the SAME OU-scoped query every other route's
        // empty-identifier fallback uses, rather than trusting the stored
        // id directly -- a default that has since moved out of OU scope
        // must not be honoured (matches resolveProject()'s own 'empty'
        // branch precedent, and IdentifierResolverTest's own
        // testResolveProjectFallsBackToTheDefaultOnlyWhenInScope coverage
        // of that exact rule). A stale, now-out-of-scope default is treated
        // identically to "no default at all" below -- the same uniform
        // treatment IdentifierResolver::resolveProject()'s own callers give
        // it everywhere else in this file.
        $storedDefault = $this->defaultProjectIdFor($request, $tenantId);
        $validatedDefault = $storedDefault === null
            ? null
            : IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $raw, $storedDefault);

        $outcome = $this->resolveRankTasksOmittedProjectId(
            $validatedDefault,
            $this->queryParamBool($request, 'confirmed', false)
        );

        if ($outcome['status'] === 'need_confirmation') {
            return Response::error(
                'No project_id was supplied and you have no default project set. '
                    . 'Pass confirmed: true to rank tasks across every project in your scope.',
                400
            );
        }

        return (new AttentionApiHandler($pdo))->rank($tenantId, $ou['ouId'], $outcome['projectId']);
    }

    /**
     * The rank_tasks decision for an OMITTED project_id only (cases 3/4 of
     * {@see self::rankTasks()}'s own docblock) — pure, no database access,
     * extracted so this composition logic (new in D1b Task 11 round 2) has
     * an actual Reflection test seam the way every other route-decision
     * helper in this file does; rankTasks() itself is otherwise unreachable
     * from PHPUnit because it calls resolvePdo().
     *
     * $validatedDefault is the caller's stored default project id ALREADY
     * re-validated through the OU-scoped resolveProject() call — null both
     * when there was no stored default AND when the stored default no
     * longer resolves in scope. Those two are treated IDENTICALLY here,
     * matching every sibling route in this file: none of them distinguishes
     * "no identifier supplied" from "supplied/defaulted identifier resolved
     * to nothing" as separate cases; both fall through to the same outcome
     * (here: the confirmed gate, rather than a stale default silently
     * widening or narrowing what gets ranked).
     *
     * Two outcomes:
     *   - 'need_confirmation': no in-scope default, and $confirmed is not
     *     true. Callers 400, naming `confirmed` as the way to proceed.
     *   - 'use_project': either the validated default (projectId set), or —
     *     when there was no default at all but $confirmed was true —
     *     projectId null, meaning "every project in OU scope".
     *
     * @return array{status: 'use_project'|'need_confirmation', projectId: ?int}
     */
    private function resolveRankTasksOmittedProjectId(?int $validatedDefault, bool $confirmed): array
    {
        if ($validatedDefault !== null) {
            return ['status' => 'use_project', 'projectId' => $validatedDefault];
        }
        if ($confirmed) {
            return ['status' => 'use_project', 'projectId' => null];
        }

        return ['status' => 'need_confirmation', 'projectId' => null];
    }

    /**
     * GET /api/tasker/attention?project_id= — the original's
     * get_my_attention: overdue and stale tasks CREATED BY the calling user
     * (D1b Task 11 ruling #5 — tasker_tasks has no assignee column). The
     * live original's own five buckets also include review-verdict,
     * guidance, and agent-session concepts this D1 schema does not have at
     * all — see AttentionApiHandler::attention()'s own docblock for the full
     * round-2 correction against the live surface (this task's earlier
     * `pinned` bucket, ruling #7, was withdrawn — it was never one of the
     * original's five).
     *

     * project_id is optional, but UNLIKE every other project-scoped route in
     * this file (and unlike this tool's own sibling rankTasks() just above),
     * an omitted value here does NOT fall back to the caller's default
     * project (ruling #6) — defaultProjectIdFor() is deliberately never
     * called on this path. Omitting it means "every project in the caller's
     * OU scope"; AttentionApiHandler::attention() receives a genuine null
     * $projectId in that case, not a resolved default. A SUPPLIED project_id
     * is still resolved and OU/tenant-checked exactly like every other
     * route, 404ing if it does not resolve — the classify()-then-resolve
     * split below (rather than IdentifierResolver::resolveProject()'s own
     * $defaultProjectId parameter) is what keeps "supplied but wrong" (404)
     * distinct from "omitted" (span everything): resolveProject() returns
     * null for BOTH cases when given no default, which would otherwise make
     * a typo'd project_id silently behave like it was never supplied.
     *
     * @param array<string, string> $params
     */
    public function getMyAttention(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        // resolveCallerOu() above only ever returns resolved => true after
        // it has already resolved a non-null callerProfileId() itself (see
        // its own docblock) -- this cannot be null on any path that reaches
        // here today, but "my attention" filters by created_by, so this
        // fails closed on the (currently unreachable) null case rather than
        // trusting that invariant silently forever.
        $callerId = $this->callerProfileId($request);
        if ($callerId === null) {
            return Response::error('Caller identity could not be resolved', 403);
        }

        $raw = $this->queryParam($request, 'project_id');
        $form = IdentifierResolver::classify($raw);
        if ($form === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $projectId = null;
        if ($form !== 'empty') {
            $projectId = IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $raw);
            if ($projectId === null) {
                return Response::error('Project not found', 404);
            }
        }

        return (new AttentionApiHandler($pdo))->attention($tenantId, $ou['ouId'], $projectId, $callerId);
    }

    /**
     * GET /api/tasker/milestones?task_id=
     *
     * task_id is required — a task's milestones have no "default" fallback
     * the way a project does. Resolved via IdentifierResolver::resolveTask(),
     * which is OU-scoped; listForTask() itself stays tenant-scoped only
     * (whole-branch review finding I7 — see MilestonesApiHandler's own doc),
     * so this route adds the OU check the flattened surface now needs, on
     * top of (not instead of) that existing handler-level check.
     *
     * @param array<string, string> $params
     */
    public function listMilestones(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->queryParam($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new MilestonesApiHandler($pdo))->listForTask($tenantId, $taskId);
    }

    /**
     * POST /api/tasker/milestones
     *
     * Uses {@see self::resolveMilestoneTarget()} with $requireMilestone:
     * false — there is no existing milestone to address on a create, only a
     * task to attach the new one to.
     *
     * @param array<string, string> $params
     */
    public function addMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $target = $this->resolveMilestoneTarget(
            $request,
            $pdo,
            $tenantId,
            $callerOu['ouId'],
            [IdentifierResolver::class, 'resolveTask'],
            false
        );
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))
            ->create($tenantId, $callerOu['ouId'], (int) $target['taskId'], $request->getBody());
    }

    /**
     * POST /api/tasker/milestones/complete
     *
     * setChecked(true) is called directly rather than toggle() — see
     * MilestonesApiHandler's own doc for why a toggle cannot express the
     * complete/uncomplete pair.
     *
     * @param array<string, string> $params
     */
    public function completeMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->setChecked($tenantId, (int) $target['milestoneId'], true);
    }

    /**
     * POST /api/tasker/milestones/uncomplete
     *
     * Mirrors completeMilestone() exactly, except it sets checked to false —
     * see that method's own doc.
     *
     * @param array<string, string> $params
     */
    public function uncompleteMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->setChecked($tenantId, (int) $target['milestoneId'], false);
    }

    /**
     * PATCH /api/tasker/milestones
     *
     * @param array<string, string> $params
     */
    public function updateMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->update($tenantId, (int) $target['milestoneId'], $request->getBody());
    }

    /**
     * DELETE /api/tasker/milestones
     *
     * task_id/milestone_id/index all arrive via
     * {@see self::resolveMilestoneTarget()}'s use of identifierFromRequest()
     * (body then query) rather than the body alone — required for a DELETE,
     * whose arguments never survive the MCP transport in the body at all.
     *
     * @param array<string, string> $params
     */
    public function deleteMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $ou = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$ou['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->delete($tenantId, (int) $target['milestoneId']);
    }

    /**
     * GET /api/tasker/tasks/discussion?task_id=
     *
     * @param array<string, string> $params
     */
    public function getDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->queryParam($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $callerOu['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TaskDiscussionsApiHandler($pdo))->get($tenantId, $callerOu['ouId'], $taskId);
    }

    /**
     * PUT /api/tasker/tasks/discussion
     *
     * @param array<string, string> $params
     */
    public function putDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $callerOu['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TaskDiscussionsApiHandler($pdo))
            ->put($tenantId, $callerOu['ouId'], $taskId, $request->getBody());
    }

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

        $pdo = $this->resolvePdo();
        $callerOu = $this->resolveCallerOu($pdo, $request, $tenantId);
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        $decoded = json_decode($request->getBody(), true);
        $raw = is_array($decoded) ? ($decoded['project_id'] ?? null) : null;

        $projectId = $raw === null
            ? null
            : IdentifierResolver::resolveProject($pdo, $tenantId, $callerOu['ouId'], is_scalar($raw) ? $raw : null);

        if ($raw !== null && $projectId === null) {
            return Response::error('Project not found', 404);
        }

        return (new SessionApiHandler($pdo))->setDefaultProject($tenantId, $profileId, $projectId);
    }

    /**
     * Reads $key from the request body (a JSON object) first, falling back
     * to a query parameter of the same name.
     *
     * REGRESSION FIX, found by a live tools/call smoke test rather than the
     * PHPUnit suite — TenantIsolationOuTest exercises ProjectsApiHandler
     * directly and never goes through updateProject()/deleteProject() at
     * all, so nothing in this codebase's existing test plan could have
     * caught it. The host's MCP transport
     * (`Whity\Mcp\Tools\ToolsCallHandler::buildRequest()`, in the
     * gitignored, pinned-ref `host/.core` checkout — out of this plugin's
     * reach entirely) sends EVERY argument to a DELETE (also GET/HEAD, but
     * those don't reach this method) tool call as a query-string parameter
     * baked into the synthesized request's path, and leaves the body
     * empty, unlike POST/PATCH whose body arguments really do arrive
     * JSON-encoded (confirmed empirically for both).
     *
     * Without this fallback, a delete_project route that only looked at the
     * body — this method's first implementation, and the brief's own
     * sketch — 400s on EVERY SINGLE MCP delete_project call with "Request
     * body must be a JSON object", which defeats the entire point of this
     * flattening slice: an agent could never actually delete a project
     * through the tool surface this task builds.
     *
     * SECOND REGRESSION FIX (whole-branch review): the first version of
     * this method parsed the query ONLY off `$request->getPath()`, which
     * works for a hand-built test Request and for ToolsCallHandler's
     * synthesized one (both bake the query into the path string) but is
     * silently a no-op for a genuine HTTP request — `Request::fromGlobals()`
     * (host/.core/public/index.php) builds the Request from
     * `parse_url($requestUri, PHP_URL_PATH)`, which STRIPS the query
     * entirely; `$_GET` is the only place it survives at runtime. Reading
     * only the path meant a real `DELETE /api/tasker/projects?project_id=X`
     * would see `$raw === null`, `IdentifierResolver::classify(null)`
     * returns 'empty' (not 'malformed'), and `resolveProject()` would
     * silently fall through to the caller's DEFAULT project — a 204
     * against the wrong project, not a 404. Delegates to
     * {@see self::queryParam()}, which reads both sources the same way
     * {@see \Whity\Api\PersonsApiHandler::queryParam()} /
     * {@see \Whity\Api\DelegationsApiHandler::queryParams()} already do
     * (WC-167 review: "path-only parsing made every documented filter dead
     * in production") — this handler would otherwise have repeated exactly
     * the mistake that review was about.
     */
    private function identifierFromRequest(Request $request, string $key): string|int|null
    {
        $decoded = json_decode($request->getBody(), true);
        if (is_array($decoded) && array_key_exists($key, $decoded) && (is_string($decoded[$key]) || is_int($decoded[$key]))) {
            return $decoded[$key];
        }

        return $this->queryParam($request, $key);
    }

    /**
     * Read a single query parameter from BOTH runtime sources — see
     * {@see self::identifierFromRequest()}'s docblock for why both are
     * required. `$_GET` is the live runtime source (FrankenPHP strips the
     * query string from the path via `Request::fromGlobals()`); the
     * path-embedded form is how this plugin's own test suite AND the MCP
     * transport (`ToolsCallHandler::buildRequest()`) build a Request. The
     * path-embedded value wins when both are present — mirroring
     * {@see \Whity\Api\PersonsApiHandler::queryParam()} /
     * {@see \Whity\Api\DelegationsApiHandler::queryParams()}'s own
     * precedence exactly, so this plugin does not invent a third
     * convention for the same problem (WC-167).
     *
     * THE CANONICAL QUERY ACCESSOR for this plugin going forward: Tasks
     * 5–7 need query parameters too (`list_sections?project_id=`,
     * `list_tasks?project_id=&status=`, etc.) and should call this rather
     * than re-deriving path-only parsing a third time.
     */
    private function queryParam(Request $request, string $name): ?string
    {
        $value = null;

        if (isset($_GET[$name]) && is_string($_GET[$name])) {
            $value = $_GET[$name];
        }

        $query = parse_url($request->getPath(), PHP_URL_QUERY);
        if (is_string($query) && $query !== '') {
            $params = [];
            parse_str($query, $params);
            if (isset($params[$name]) && is_string($params[$name])) {
                $value = $params[$name];
            }
        }

        return $value;
    }

    /**
     * Parse an OPTIONAL query-string boolean (D1b Task 8: get_project's
     * `include_notes`) — the mirror-image problem to this codebase's own
     * dbTruthy() helpers (see e.g. {@see \Tasker\Api\TasksApiHandler::dbTruthy()}),
     * which parse a stored DB column's driver-returned representation of a
     * bool back into a real one. A query parameter is always a string or
     * entirely absent, never a real PHP bool, so a naive `(bool) $raw` cast
     * is wrong for the non-empty falsy string "false" (PHP's own bool cast
     * treats any non-empty string other than the single character "0" as
     * truthy) — `include_notes=false` would otherwise silently turn ON the
     * very feature it asked to turn off. Handled here in the same spirit as
     * dbTruthy() (same accepted-falsy-string set) rather than a second,
     * differently-shaped convention.
     *
     * $default applies ONLY when the parameter is absent entirely — a bare
     * `?bool` cannot distinguish "not supplied" from "supplied but falsy", so
     * this takes an explicit default rather than folding absence into the
     * falsy-string set (which would silently break a future caller wanting a
     * true default).
     */
    private function queryParamBool(Request $request, string $name, bool $default): bool
    {
        $raw = $this->queryParam($request, $name);
        if ($raw === null) {
            return $default;
        }

        $normalised = strtolower(trim($raw));

        return !in_array($normalised, ['', '0', 'f', 'false', 'no'], true);
    }

    /**
     * Parse an OPTIONAL BOOLEAN out of an already-decoded JSON BODY (D1b
     * Task 9: update_project_context's `replace`) — the body-field
     * counterpart to {@see self::queryParamBool()} above, not a duplicate of
     * it: json_decode() already turns a genuine JSON `true`/`false` into a
     * real PHP bool, used directly with no string parsing at all for that —
     * overwhelmingly common — case. The same accepted-falsy-string set as
     * queryParamBool()/dbTruthy() is applied only defensively, in case a
     * caller sends `"replace": "false"` as a STRING rather than a genuine
     * JSON boolean.
     *
     * $default applies only when the key is absent entirely, matching
     * queryParamBool()'s own reasoning.
     *
     * @param array<string, mixed> $decoded
     */
    private function bodyParamBool(array $decoded, string $key, bool $default): bool
    {
        if (!array_key_exists($key, $decoded)) {
            return $default;
        }

        $raw = $decoded[$key];
        if (is_bool($raw)) {
            return $raw;
        }
        if (is_string($raw)) {
            $normalised = strtolower(trim($raw));

            return !in_array($normalised, ['', '0', 'f', 'false', 'no'], true);
        }

        return (bool) $raw;
    }

    /**
     * The `$merge` value {@see \Tasker\Api\ProjectsApiHandler::updateContext()}
     * receives, computed from update_project_context's own `replace` body
     * field (D1b Task 9 brief resolution #5): `replace` is the INVERSE of
     * `$merge` — `replace: true` -> `$merge = false`; an ABSENT `replace` ->
     * `$merge = true` (merge is the default, since the original's tool is
     * used to add Foundation keys incrementally, one call at a time, not to
     * overwrite the whole document on every call).
     *
     * REVIEW FIX (D1b Task 9 review): this inversion used to be an inline
     * `!$this->bodyParamBool(...)` expression inside updateProjectContext()
     * itself — the ONE line in that task's diff with no test at any layer,
     * because updateProjectContext() calls resolvePdo() and is unreachable
     * from PHPUnit. Both of the inversion's INPUTS were well tested
     * (bodyParamBool()'s own string parsing; ProjectsApiHandler::updateContext()'s
     * behaviour given an explicit `$merge` of `true`/`false`), but the
     * inversion itself — the one line that actually implements "merge is the
     * default, replace flips it" — was not: flipping `!$replace` to
     * `$replace` would have flipped the DEFAULT to "replace on every call"
     * and still passed every existing test, silently destroying a project's
     * accumulated Foundation context on the very next partial update.
     * Extracted here, matching the exact shape already used three times in
     * this same file ({@see self::resolveGroupMembership()},
     * {@see self::isJsonObject()}, {@see self::bodyParamBool()} itself) for
     * composition logic a route method's own resolvePdo() call makes
     * otherwise untestable — see TaskerPluginTest for direct coverage of
     * all three cases (absent, `replace: true`, `replace: false`).
     *
     * @param array<string, mixed> $decoded
     */
    private function mergeFromReplace(array $decoded): bool
    {
        return !$this->bodyParamBool($decoded, 'replace', false);
    }

    /**
     * Whether $value is a genuine JSON OBJECT (D1b Task 9 brief resolution
     * #8: update_project_context's `context` must be one — a scalar, a
     * string, or a JSON array must be rejected with 422, never stored).
     * Pure — no database — so it gets a direct Reflection test in
     * TaskerPluginTest rather than living inline in
     * updateProjectContext(), which calls resolvePdo() and is otherwise
     * unreachable from PHPUnit, the same reason every other composition
     * helper in this file is extracted.
     *
     * An empty JSON object (`{}`) and an empty JSON array (`[]`) are
     * INDISTINGUISHABLE once json_decode(..., true) has already run — PHP
     * represents both as the same empty array — so an empty array is
     * accepted here rather than guessed at; only a NON-EMPTY list
     * (sequential, 0-based integer keys — the shape json_decode() gives a
     * genuine JSON array) is rejected.
     */
    private static function isJsonObject(mixed $value): bool
    {
        return is_array($value) && ($value === [] || !array_is_list($value));
    }

    /**
     * Resolve an OPTIONAL parent identifier supplied alongside a slug-form
     * child identifier — project_id for a section (updateSection()/
     * deleteSection()), section_id for a group (updateGroup()/
     * deleteGroup()). A section/group slug is unique only within its parent
     * (see IdentifierResolver::resolveStructural()'s own docblock), so the
     * parent has to be resolved to an integer before it can be passed as
     * resolveSection()'s/resolveGroup()'s fifth argument.
     *
     * Three outcomes, distinguished the same way resolveCallerOu() above
     * distinguishes its own three outcomes — a bare `?int` cannot tell
     * "not supplied" apart from "supplied but did not resolve":
     *
     *   - not supplied at all ('empty' form): {ok: true, value: null}. The
     *     resolver is never called — a slug lookup against a null parent
     *     legitimately fails to resolve later (resolveSection()/
     *     resolveGroup() return null for a slug/prefix form with $parentId
     *     === null), which becomes the same 404 as "not found", not a
     *     separate error here.
     *   - malformed (looks like a short id but is not one):
     *     {ok: false, value: null}. Callers must 400 on this, matching
     *     every other malformed-short-id check in this file.
     *   - any other supplied form: {ok: true, value: $resolver(...)} — the
     *     resolver's own return value passed straight through (an int, or
     *     null if it did not resolve, e.g. outside the caller's OU scope).
     *
     * Extracted as a private helper — rather than inlined near-identically
     * four times across updateSection()/deleteSection()/updateGroup()/
     * deleteGroup(), as it originally was — for two reasons: it removes that
     * duplication, and it gives this composition logic (new in this task) an
     * actual Reflection test seam. The logic inside updateSection() and
     * friends is otherwise unreachable from PHPUnit: every path through
     * those route methods calls resolvePdo(), which resolves the live host
     * container and has no test double. See TaskerPluginTest for coverage:
     * the 'empty' and 'malformed_short_id' branches are exercised directly
     * (pure — no database call happens on either path); the "supplied"
     * branch is exercised with a spy $resolver, verifying the exact
     * (pdo, tenantId, callerOuId, raw) tuple this method passes through,
     * without requiring a real IdentifierResolver::resolveProject()/
     * resolveSection() call — those need PostgreSQL (OuScopeResolver::
     * whereFragment()'s `= ANY(:scope)` fails at PDO::prepare() under
     * SQLite), which is exactly why this composition logic had no coverage
     * before this extraction.
     *
     * $resolver is IdentifierResolver::resolveProject() or ::resolveSection(),
     * passed as a first-class callable and invoked with no default/
     * grandparent argument — this resolves exactly one level up, never two.
     *
     * @param callable(\PDO, int, ?int, string|int|null): ?int $resolver
     * @return array{ok: bool, value: ?int}
     */
    private function resolveOptionalParentId(
        Request $request,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        string $key,
        callable $resolver
    ): array {
        $raw = $this->identifierFromRequest($request, $key);
        $form = IdentifierResolver::classify($raw);

        if ($form === 'malformed_short_id') {
            return ['ok' => false, 'value' => null];
        }

        if ($form === 'empty') {
            return ['ok' => true, 'value' => null];
        }

        return ['ok' => true, 'value' => $resolver($pdo, $tenantId, $callerOuId, $raw)];
    }

    /**
     * Resolve create_task's section_id: like {@see self::resolveOptionalParentId()},
     * but the 'empty' (not supplied) branch defaults to the resolved
     * project's Backlog section instead of null — our tasker_tasks.section_id
     * is NOT NULL by design, so the original's "ungrouped if omitted" has no
     * literal equivalent; Backlog is the closest one.
     *
     * Four outcomes:
     *   - malformed (looks like a short id but is not one):
     *     {ok: false, value: null, usedBacklogFallback: false}. Callers 400
     *     on this — the fallback must NEVER fire for a malformed identifier,
     *     only for a genuinely absent one.
     *   - not supplied ('empty' form): {ok: true, value: <backlog id or
     *     null>, usedBacklogFallback: true}. value is null only when
     *     $projectId genuinely has no 'backlog' section (see
     *     backlogSectionIdFor()'s own docblock for when that happens) —
     *     callers 404 with a message distinguishing this from a plain
     *     "not found" using usedBacklogFallback.
     *   - any other supplied form, resolves: {ok: true, value: <int>,
     *     usedBacklogFallback: false}.
     *   - any other supplied form, does not resolve: {ok: true, value: null,
     *     usedBacklogFallback: false} — callers 404.
     *
     * $resolver is injected (IdentifierResolver::resolveSection() in
     * production) rather than called directly, for the same reason
     * resolveOptionalParentId() injects its own resolver: it gives this
     * composition a Reflection test seam with a spy, since the real
     * resolver needs PostgreSQL (OuScopeResolver::whereFragment()'s
     * `= ANY(:scope)` fails at PDO::prepare() under SQLite) — see
     * TaskerPluginTest. backlogSectionIdFor() itself carries no such
     * restriction (plain tenant-scoped SQL), so the 'empty' branch is
     * tested directly against a real SQLite fixture, no spy needed.
     *
     * @param callable(\PDO, int, ?int, string|int|null, ?int): ?int $resolver
     * @return array{ok: bool, value: ?int, usedBacklogFallback: bool}
     */
    private function resolveCreateTaskSectionId(
        Request $request,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        int $projectId,
        callable $resolver
    ): array {
        $raw = $this->identifierFromRequest($request, 'section_id');
        $form = IdentifierResolver::classify($raw);

        if ($form === 'malformed_short_id') {
            return ['ok' => false, 'value' => null, 'usedBacklogFallback' => false];
        }

        if ($form === 'empty') {
            return [
                'ok' => true,
                'value' => $this->backlogSectionIdFor($pdo, $tenantId, $projectId),
                'usedBacklogFallback' => true,
            ];
        }

        return [
            'ok' => true,
            'value' => $resolver($pdo, $tenantId, $callerOuId, $raw, $projectId),
            'usedBacklogFallback' => false,
        ];
    }

    /**
     * Resolve one of move_task's destination identifiers (section_id or
     * group_id) from an ALREADY-DECODED request body — TasksApiHandler::move()
     * itself only ever does a plain `(int)` cast on whatever it is handed,
     * which silently casts a UUID/slug to 0 and 422s (task review finding);
     * this is what fixes that, resolving both identifiers before moveTask()
     * ever delegates to move().
     *
     * Five outcomes, distinguished the same way resolveOptionalParentId()'s
     * three distinguish theirs — a bare `?int` cannot tell "absent" apart
     * from "explicitly null" apart from "supplied but did not resolve":
     *
     *   - status 'absent': the key is not in $decoded at all — move()'s own
     *     `array_key_exists()` check must see it stay absent (its "leave
     *     unchanged" case).
     *   - status 'explicit_null': the key IS present with a literal null
     *     value — group_id's own "explicit null means un-group" (see
     *     move()'s docblock); section_id has no such meaning, but callers
     *     decide what to do with it (letting move()'s own project-membership
     *     check reject it is enough — no separate handling needed here).
     *   - status 'malformed': present, a string/int, but classifies as
     *     malformed_short_id. Callers 400.
     *   - status 'unresolved': present, classifies as a real form, but
     *     $resolver found nothing (wrong tenant/OU, or genuinely absent).
     *     Callers 404 — distinct from move()'s own 422 for "exists, but
     *     doesn't belong to the target project/section", which only
     *     triggers once a resolved id reaches move() at all.
     *   - status 'resolved': present, resolves to a real id. value carries
     *     it; callers substitute it back into $decoded before re-encoding.
     *
     * A non-string/non-int, non-null value (e.g. an array) is treated as
     * 'malformed' defensively — IdentifierResolver::classify()'s own
     * signature does not accept it, and this codebase's strict_types would
     * otherwise throw a TypeError instead of a clean 400.
     *
     * $resolver is IdentifierResolver::resolveSection() or ::resolveGroup(),
     * injected for the same Reflection-testability reason as
     * resolveOptionalParentId()'s own $resolver — see TaskerPluginTest.
     *
     * @param array<string, mixed> $decoded
     * @param callable(\PDO, int, ?int, string|int|null): ?int $resolver
     * @return array{status: 'absent'|'explicit_null'|'malformed'|'unresolved'|'resolved', value: ?int}
     */
    private function resolveMoveDestinationId(
        array $decoded,
        string $key,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        callable $resolver
    ): array {
        if (!array_key_exists($key, $decoded)) {
            return ['status' => 'absent', 'value' => null];
        }

        $raw = $decoded[$key];
        if ($raw === null) {
            return ['status' => 'explicit_null', 'value' => null];
        }

        if (!is_string($raw) && !is_int($raw)) {
            return ['status' => 'malformed', 'value' => null];
        }

        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return ['status' => 'malformed', 'value' => null];
        }

        $resolved = $resolver($pdo, $tenantId, $callerOuId, $raw);

        return $resolved === null
            ? ['status' => 'unresolved', 'value' => null]
            : ['status' => 'resolved', 'value' => $resolved];
    }

    /**
     * Resolve move_task_to_group's own group_id (D1b Task 9): unlike
     * {@see self::resolveMoveDestinationId()} (move_task's group_id, where
     * ABSENT means "leave unchanged" — see
     * {@see \Tasker\Api\TasksApiHandler::move()}'s own docblock),
     * move_task_to_group has no "unchanged" concept at all — it exists
     * SOLELY to set group membership (brief resolution #3), so an absent key
     * and an explicit null must behave IDENTICALLY: both un-group. Delegates
     * every other distinction (malformed/unresolved/resolved) straight to
     * resolveMoveDestinationId(), then collapses its 'absent' and
     * 'explicit_null' statuses into one 'ungroup' outcome.
     *
     * FOUR outcomes (one fewer than resolveMoveDestinationId()'s five,
     * because 'absent' and 'explicit_null' are no longer distinguishable
     * here):
     *   - 'malformed': looks like a short id but is not one. Callers 400.
     *   - 'unresolved': supplied, classifies as a real form, but $resolver
     *     found nothing (wrong tenant/OU, or genuinely absent). Callers
     *     404 — this must NEVER collapse into 'ungroup': a caller who named
     *     a specific, wrong group must not silently have their task
     *     un-grouped instead of seeing an error.
     *   - 'ungroup': the key was absent OR explicitly null. value is
     *     always null.
     *   - 'resolved': present, resolves to a real id. value carries it.
     *
     * $resolver is IdentifierResolver::resolveGroup(), injected for the same
     * Reflection-testability reason resolveMoveDestinationId()'s own
     * $resolver is — see TaskerPluginTest.
     *
     * @param array<string, mixed> $decoded
     * @param callable(\PDO, int, ?int, string|int|null): ?int $resolver
     * @return array{status: 'malformed'|'unresolved'|'ungroup'|'resolved', value: ?int}
     */
    private function resolveGroupMembership(
        array $decoded,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        callable $resolver
    ): array {
        $destination = $this->resolveMoveDestinationId($decoded, 'group_id', $pdo, $tenantId, $callerOuId, $resolver);

        if ($destination['status'] === 'absent' || $destination['status'] === 'explicit_null') {
            return ['status' => 'ungroup', 'value' => null];
        }

        /** @var array{status: 'malformed'|'unresolved'|'resolved', value: ?int} $destination */
        return $destination;
    }

    /**
     * Resolve {task_id, milestone_id|index} into a concrete (taskId,
     * milestoneId) pair, OU-scoped through the owning task — the shared
     * two-stage resolution behind every milestone-mutation route:
     * addMilestone() (task only, $requireMilestone: false — there is no
     * existing milestone to address yet), completeMilestone(),
     * uncompleteMilestone(), updateMilestone(), and deleteMilestone().
     *
     * TASK REVIEW FIX: the first version of this task inlined this
     * composition five times, and three of those five copies
     * (completeMilestone/uncompleteMilestone/updateMilestone) read
     * milestone_id/index straight off a bare `json_decode($request->getBody(),
     * true)` rather than through {@see self::identifierFromRequest()}. Under
     * this codebase's `strict_types=1`, a caller sending a non-scalar value —
     * e.g. `{"task_id":"TDE-1","milestone_id":{"x":1}}` — reached
     * `IdentifierResolver::resolveMilestone(..., string|int|null $raw)` as a
     * PHP array and threw an uncaught TypeError instead of a controlled 400.
     * `deleteMilestone()`, in the same original commit, already read both
     * identifiers correctly through `identifierFromRequest()` (required
     * there regardless, since DELETE bodies never survive the MCP
     * transport) — this extraction generalises that already-correct method's
     * approach to all five, rather than leaving four different
     * implementations of the same idea to drift.
     *
     * FIVE outcomes:
     *   - 'malformed_task': task_id classifies as malformed_short_id. The
     *     milestone identifier is never even read — callers 400.
     *   - 'task_not_found': task_id is absent, or does not resolve within
     *     the caller's tenant/OU scope. Callers 404.
     *   - 'malformed_milestone': milestone_id/index classifies as
     *     malformed_short_id (only reachable when $requireMilestone is
     *     true). Callers 400.
     *   - 'milestone_not_found': the task resolved, but
     *     IdentifierResolver::resolveMilestone() found nothing under it
     *     (wrong tenant, wrong task, or genuinely absent/non-scalar — see
     *     the TypeError note above: a non-scalar value is filtered out by
     *     identifierFromRequest() before it ever reaches classify() or
     *     resolveMilestone(), so it lands here rather than throwing).
     *     Callers 404.
     *   - 'resolved': the task resolved (and, unless $requireMilestone is
     *     false, so did the milestone within it).
     *
     * $taskResolver is injected — IdentifierResolver::resolveTask() in
     * production — for the same Reflection-testability reason
     * resolveOptionalParentId()/resolveMoveDestinationId()/
     * resolveCreateTaskSectionId() inject theirs: it calls
     * OuScopeResolver::whereFragment() unconditionally, which SQLite's
     * PDO::prepare() rejects outright. IdentifierResolver::resolveMilestone()
     * itself is called directly, NOT injected — it carries no OU-scoping and
     * no Postgres-only syntax at all (plain tenant/task-scoped SQL), so it
     * runs for real against a bare SQLite fixture in this class's own tests,
     * the same way resolveCreateTaskSectionId() calls backlogSectionIdFor()
     * directly rather than injecting it.
     *
     * @param callable(\PDO, int, ?int, string|int|null): ?int $taskResolver
     * @return array{status: 'malformed_task'|'task_not_found'|'malformed_milestone'|'milestone_not_found'|'resolved', taskId: ?int, milestoneId: ?int}
     */
    private function resolveMilestoneTarget(
        Request $request,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        callable $taskResolver,
        bool $requireMilestone = true
    ): array {
        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return ['status' => 'malformed_task', 'taskId' => null, 'milestoneId' => null];
        }

        $taskId = $taskResolver($pdo, $tenantId, $callerOuId, $rawTaskId);
        if ($taskId === null) {
            return ['status' => 'task_not_found', 'taskId' => null, 'milestoneId' => null];
        }

        if (!$requireMilestone) {
            return ['status' => 'resolved', 'taskId' => $taskId, 'milestoneId' => null];
        }

        $rawMilestone = $this->identifierFromRequest($request, 'milestone_id')
            ?? $this->identifierFromRequest($request, 'index');
        if (IdentifierResolver::classify($rawMilestone) === 'malformed_short_id') {
            return ['status' => 'malformed_milestone', 'taskId' => $taskId, 'milestoneId' => null];
        }

        $milestoneId = IdentifierResolver::resolveMilestone($pdo, $tenantId, $taskId, $rawMilestone);
        if ($milestoneId === null) {
            return ['status' => 'milestone_not_found', 'taskId' => $taskId, 'milestoneId' => null];
        }

        return ['status' => 'resolved', 'taskId' => $taskId, 'milestoneId' => $milestoneId];
    }

    /**
     * Turn a {@see self::resolveMilestoneTarget()} outcome into the matching
     * error Response, or null when it resolved and the caller should
     * proceed. Extracted so the five milestone-mutation route methods share
     * one mapping from status to (message, code) rather than repeating a
     * four-armed if/match each.
     *
     * @param array{status: 'malformed_task'|'task_not_found'|'malformed_milestone'|'milestone_not_found'|'resolved', taskId: ?int, milestoneId: ?int} $target
     */
    private function milestoneTargetError(array $target): ?Response
    {
        return match ($target['status']) {
            'malformed_task' => Response::error('task_id looks like a short id but is malformed', 400),
            'task_not_found' => Response::error('Task not found', 404),
            'malformed_milestone' => Response::error('milestone_id looks like a short id but is malformed', 400),
            'milestone_not_found' => Response::error('Milestone not found', 404),
            default => null,
        };
    }

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

    /**
     * The Backlog section id for $projectId, or null when the project has
     * none — used by {@see self::resolveCreateTaskSectionId()} as the
     * fallback when create_task's section_id is omitted (D1b: our
     * tasker_tasks.section_id is NOT NULL, so "ungrouped if omitted" from
     * the original becomes "goes to Backlog" here instead). Every project
     * created through create_project always seeds a 'backlog' section (see
     * ProjectsApiHandler::create()); this only returns null for a project
     * that reached this state some other way, e.g. imported without one.
     *
     * Tenant-scoped only, matching the class docblock's reasoning on
     * TasksApiHandler: $projectId arriving here has already been resolved
     * (and OU-checked) by IdentifierResolver::resolveProject() above in
     * createTask(), so this is a discovered value, not a raw path parameter.
     * Plain tenant-scoped SQL, no OU/Postgres-only syntax — exercised
     * directly (no spy needed) in TaskerPluginTest's
     * resolveCreateTaskSectionId() Reflection tests.
     */
    private function backlogSectionIdFor(\PDO $pdo, int $tenantId, int $projectId): ?int
    {
        $stmt = $pdo->prepare(
            "SELECT id FROM tasker_sections WHERE project_id = :project_id AND tenant_id = :tenant_id AND slug = 'backlog' LIMIT 1"
        );
        $stmt->execute([':project_id' => $projectId, ':tenant_id' => $tenantId]);
        $id = $stmt->fetchColumn();

        return $id === false ? null : (int) $id;
    }

    /**
     * The caller's own profile (user) id, from the JWT payload RbacMiddleware
     * attaches to the request as {@see Request::$user} once a route's
     * requiredRole/requiredPermission check passes. Null only when $user is
     * absent/malformed, which should not happen on any route reachable here
     * (every tasker_project/tasker_structure route requires a permission),
     * but is handled defensively rather than assumed.
     *
     * `profile_id` is the canonical identity claim (ADR 0005 §1) — the same
     * field RbacMiddleware itself validates as an int before attaching
     * $user — mirroring the established pattern used across the host's own
     * handlers (e.g. DocumentTemplatesApiHandler, AiPrincipalsApiHandler).
     *
     * NOTE ON A BRIEF DEVIATION: the plan this task implements sketched this
     * as `TenantContext::getUserId()`. `Whity\Core\Tenant\TenantContext`
     * (verified directly against its source, per this task's own
     * instructions) exposes only getTenantId()/getId()/hasTenant() —
     * it has no user/profile accessor at all, tenant id is the only thing it
     * ever holds. The actor's profile id lives on the Request instead.
     */
    private function callerProfileId(Request $request): ?int
    {
        $actor = $request->user;

        return is_object($actor) && isset($actor->profile_id) && is_int($actor->profile_id)
            ? $actor->profile_id
            : null;
    }

    /**
     * Resolves the caller's OU for the active tenant, distinguishing three
     * outcomes that a bare `?int` cannot tell apart:
     *
     *   - resolved, unrestricted (tenant-root): {resolved: true, ouId: null}
     *   - resolved, restricted to OU X:          {resolved: true, ouId: X}
     *   - could not resolve the caller at all:   {resolved: false, ouId: null}
     *
     * REGRESSION FIX (whole-branch review finding I4): the previous
     * `callerOuId(): ?int` returned null — which OuScopeResolver treats as
     * unrestricted — for BOTH "no membership row exists for this tenant" AND
     * "membership row exists with ou_id IS NULL" (genuine tenant-root). Those
     * are different situations that must not produce the same (unrestricted)
     * result: an actor whose identity/membership cannot be established must
     * fail closed (403), never silently proceed as tenant-root. Only a
     * membership row that genuinely HAS ou_id IS NULL is unrestricted.
     *
     * NOTE ON A BRIEF DEVIATION: the plan sketched this as
     * `TenantContext::getOuId()`, which does not exist (see
     * {@see self::callerProfileId()}'s note — TenantContext holds only the
     * tenant id). No JWT claim carries OU either (verified against every
     * `jwtParser->create()` call site in AuthHandler: profile_id,
     * active_tenant_id, email, role, token_epoch — no ou_id/active_ou_id).
     * The caller's OU is a property of their `memberships` row for this
     * tenant, so it takes one extra lookup via the host's own
     * MembershipRepository (the same repository AuthHandler itself uses to
     * resolve a membership's OU at login) rather than a static accessor.
     *
     * @return array{resolved: bool, ouId: ?int}
     */
    private function resolveCallerOu(\PDO $pdo, Request $request, int $tenantId): array
    {
        $profileId = $this->callerProfileId($request);
        if ($profileId === null) {
            return ['resolved' => false, 'ouId' => null];
        }

        $membership = (new \Whity\Core\Identity\MembershipRepository($pdo))->findByProfile($profileId, $tenantId);
        if ($membership === null) {
            // A profile with RBAC access to this route but NO membership row
            // for this tenant — should not normally happen, but must fail
            // closed rather than silently widen to tenant-root visibility.
            return ['resolved' => false, 'ouId' => null];
        }

        return ['resolved' => true, 'ouId' => $membership['ou_id'] ?? null];
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
