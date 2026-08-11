<?php

declare(strict_types=1);

namespace Tasker;

use Tasker\Access\IdentifierResolver;
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
                            'description' => 'Section UUID, id, or slug (slug requires project_id).',
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
                            'section_id' => ['type' => 'string', 'description' => 'Section UUID, id, or slug (slug requires project_id).'],
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
                    'summary' => 'Update a task\'s text, detail, priority, or due_date',
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
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The updated task'],
                        400 => ['description' => 'text empty/too long, or priority invalid'],
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
                    'summary' => 'Add a milestone to a task',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id', 'summary'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'summary' => ['type' => 'string'],
                            'sort_order' => ['type' => 'integer'],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created milestone'],
                        400 => ['description' => 'summary missing, empty, or too long'],
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
