<?php

declare(strict_types=1);

namespace Tasker;

use Tasker\Api\GroupsApiHandler;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Api\PingApiHandler;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\SectionsApiHandler;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Api\TasksApiHandler;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerPingTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
use Tasker\Migrations\CreateTaskerTasksTable;
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
                    'responses' => [
                        201 => ['description' => 'The created project'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        422 => ['description' => 'ou_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/projects/{id:\d+}',
                'handler' => [$this, 'updateProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'update_project',
                    'summary' => 'Update a project\'s name, ou_id, prefix, or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated project'],
                        400 => ['description' => 'name empty/too long, or prefix not 2-5 uppercase letters'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                        422 => ['description' => 'ou_id is outside the caller\'s scope'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/projects/{id:\d+}',
                'handler' => [$this, 'deleteProject'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_project:manage',
                'schema' => [
                    'operationId' => 'delete_project',
                    'summary' => 'Delete a project and everything under it',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects/{projectId:\d+}/sections',
                'handler' => [$this, 'listSections'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_sections',
                    'summary' => 'List a project\'s sections',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The section list'],
                        404 => ['description' => 'Project not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/projects/{projectId:\d+}/sections',
                'handler' => [$this, 'createSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_section',
                    'summary' => 'Create a section within a project',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created section'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        404 => ['description' => 'Project not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/sections/{id:\d+}',
                'handler' => [$this, 'updateSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_section',
                    'summary' => 'Update a section\'s name, description, sort_order, or view_prefs',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated section'],
                        400 => ['description' => 'name empty or too long'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/sections/{id:\d+}',
                'handler' => [$this, 'deleteSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_section',
                    'summary' => 'Delete a section (and its groups/tasks)',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                        409 => ['description' => 'Cannot delete a project\'s last remaining section'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/sections/{sectionId:\d+}/groups',
                'handler' => [$this, 'listGroups'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_groups',
                    'summary' => 'List a section\'s groups',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The group list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections/{sectionId:\d+}/groups',
                'handler' => [$this, 'createGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'create_group',
                    'summary' => 'Create a group within a section',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created group'],
                        400 => ['description' => 'name missing, empty, or too long'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/groups/{id:\d+}',
                'handler' => [$this, 'updateGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_group',
                    'summary' => 'Update a group\'s name or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated group'],
                        400 => ['description' => 'name empty or too long'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/groups/{id:\d+}',
                'handler' => [$this, 'deleteGroup'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_group',
                    'summary' => 'Delete a group (its tasks are un-grouped, not deleted)',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Group not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/sections/{sectionId:\d+}/tasks',
                'handler' => [$this, 'listTasksForSection'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'list_tasks',
                    'summary' => 'List a section\'s tasks',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The task list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/sections/{sectionId:\d+}/tasks',
                'handler' => [$this, 'createTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'create_task',
                    'summary' => 'Create a task in a section',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created task'],
                        400 => ['description' => 'text missing, empty, too long, or priority invalid'],
                        404 => ['description' => 'Section not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/tasks/{id:\d+}',
                'handler' => [$this, 'updateTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'update_task',
                    'summary' => 'Update a task\'s text, detail, priority, or due_date',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated task'],
                        400 => ['description' => 'text empty/too long, or priority invalid'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/move',
                'handler' => [$this, 'moveTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'move_task',
                    'summary' => 'Move a task to a different section/group, or reorder it',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The moved task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                        422 => ['description' => 'section_id/group_id does not belong to the task\'s own project'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/tasks/{id:\d+}',
                'handler' => [$this, 'deleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:delete',
                'schema' => [
                    'operationId' => 'delete_task',
                    'summary' => 'Delete a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/complete',
                'handler' => [$this, 'completeTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'complete_task',
                    'summary' => 'Mark a task complete',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The completed task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/uncomplete',
                'handler' => [$this, 'uncompleteTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:complete',
                'schema' => [
                    'operationId' => 'uncomplete_task',
                    'summary' => 'Restore a completed task to pending',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The reopened task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/pin',
                'handler' => [$this, 'pinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'pin_task',
                    'summary' => 'Pin a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The pinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/unpin',
                'handler' => [$this, 'unpinTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'unpin_task',
                    'summary' => 'Unpin a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The unpinned task'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{id:\d+}/tags',
                'handler' => [$this, 'tagTask'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'tag_task',
                    'summary' => 'Attach an existing tag to a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'Tag attached'],
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/projects/{id:\d+}/ready-work',
                'handler' => [$this, 'getReadyWork'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_ready_work',
                    'summary' => 'List a project\'s non-done tasks, ranked by what to work on next',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The ranked task list'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks/{taskId:\d+}/milestones',
                'handler' => [$this, 'listMilestones'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'list_milestones',
                    'summary' => 'List a task\'s milestones',
                    'tags' => ['tasker'],
                    'responses' => [200 => ['description' => 'The milestone list']],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/{taskId:\d+}/milestones',
                'handler' => [$this, 'addMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'add_milestone',
                    'summary' => 'Add a milestone to a task',
                    'tags' => ['tasker'],
                    'responses' => [
                        201 => ['description' => 'The created milestone'],
                        400 => ['description' => 'summary missing, empty, or too long'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'POST',
                'path' => '/api/tasker/milestones/{id:\d+}/toggle',
                'handler' => [$this, 'toggleMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'complete_milestone',
                    'summary' => 'Toggle a milestone\'s checked state',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated milestone'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/milestones/{id:\d+}',
                'handler' => [$this, 'updateMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'update_milestone',
                    'summary' => 'Update a milestone\'s summary, detail, or sort_order',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The updated milestone'],
                        400 => ['description' => 'summary empty or too long'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/milestones/{id:\d+}',
                'handler' => [$this, 'deleteMilestone'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_milestone:edit',
                'schema' => [
                    'operationId' => 'delete_milestone',
                    'summary' => 'Delete a milestone',
                    'tags' => ['tasker'],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        404 => ['description' => 'Milestone not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/tasks/{id:\d+}/discussion',
                'handler' => [$this, 'getDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:view',
                'schema' => [
                    'operationId' => 'get_task_discussion',
                    'summary' => 'Read a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The discussion (empty shape if none yet)'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
                    ],
                ],
            ],
            [
                'method' => 'PUT',
                'path' => '/api/tasker/tasks/{id:\d+}/discussion',
                'handler' => [$this, 'putDiscussion'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'set_task_discussion',
                    'summary' => 'Save a task\'s AI discussion and focus reason',
                    'tags' => ['tasker'],
                    'responses' => [
                        200 => ['description' => 'The saved discussion'],
                        404 => ['description' => 'Task not found in the caller\'s tenant'],
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
            GrantTaskerTaskPermissions::class,
            CreateTaskerMilestonesTable::class,
            GrantTaskerMilestonePermissions::class,
            CreateTaskerTaskDiscussionsTable::class,
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

        return (new ProjectsApiHandler($pdo))->list($tenantId, $this->callerOuId($pdo, $request, $tenantId));
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
        $createdBy = $this->callerProfileId($request) ?? 0;

        return (new ProjectsApiHandler($pdo))
            ->create($tenantId, $this->callerOuId($pdo, $request, $tenantId), $createdBy, $request->getBody());
    }

    /**
     * PATCH /api/tasker/projects/{id}
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

        return (new ProjectsApiHandler($pdo))
            ->update($tenantId, $this->callerOuId($pdo, $request, $tenantId), (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/projects/{id}
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

        return (new ProjectsApiHandler($pdo))
            ->delete($tenantId, $this->callerOuId($pdo, $request, $tenantId), (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/projects/{projectId}/sections
     *
     * @param array<string, string> $params
     */
    public function listSections(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))->list($tenantId, (int) ($params['projectId'] ?? 0));
    }

    /**
     * POST /api/tasker/projects/{projectId}/sections
     *
     * @param array<string, string> $params
     */
    public function createSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['projectId'] ?? 0), $request->getBody());
    }

    /**
     * PATCH /api/tasker/sections/{id}
     *
     * @param array<string, string> $params
     */
    public function updateSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/sections/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new SectionsApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/sections/{sectionId}/groups
     *
     * @param array<string, string> $params
     */
    public function listGroups(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))->list($tenantId, (int) ($params['sectionId'] ?? 0));
    }

    /**
     * POST /api/tasker/sections/{sectionId}/groups
     *
     * @param array<string, string> $params
     */
    public function createGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['sectionId'] ?? 0), $request->getBody());
    }

    /**
     * PATCH /api/tasker/groups/{id}
     *
     * @param array<string, string> $params
     */
    public function updateGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/groups/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteGroup(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new GroupsApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/sections/{sectionId}/tasks
     *
     * @param array<string, string> $params
     */
    public function listTasksForSection(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->listForSection($tenantId, (int) ($params['sectionId'] ?? 0));
    }

    /**
     * POST /api/tasker/sections/{sectionId}/tasks
     *
     * @param array<string, string> $params
     */
    public function createTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        $createdBy = $this->callerProfileId($request) ?? 0;

        return (new TasksApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['sectionId'] ?? 0), $createdBy, $request->getBody());
    }

    /**
     * PATCH /api/tasker/tasks/{id}
     *
     * @param array<string, string> $params
     */
    public function updateTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * POST /api/tasker/tasks/{id}/move
     *
     * @param array<string, string> $params
     */
    public function moveTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))
            ->move($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/tasks/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{id}/complete
     *
     * @param array<string, string> $params
     */
    public function completeTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->complete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{id}/uncomplete
     *
     * @param array<string, string> $params
     */
    public function uncompleteTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->uncomplete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{id}/pin
     *
     * @param array<string, string> $params
     */
    public function pinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->pin($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{id}/unpin
     *
     * @param array<string, string> $params
     */
    public function unpinTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->unpin($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{id}/tags
     *
     * @param array<string, string> $params
     */
    public function tagTask(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TasksApiHandler($this->resolvePdo()))->tag($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * GET /api/tasker/projects/{id}/ready-work
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

        return (new TasksApiHandler($pdo))
            ->readyWork($tenantId, $this->callerOuId($pdo, $request, $tenantId), (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/tasks/{taskId}/milestones
     *
     * @param array<string, string> $params
     */
    public function listMilestones(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->listForTask($tenantId, (int) ($params['taskId'] ?? 0));
    }

    /**
     * POST /api/tasker/tasks/{taskId}/milestones
     *
     * @param array<string, string> $params
     */
    public function addMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))
            ->create($tenantId, (int) ($params['taskId'] ?? 0), $request->getBody());
    }

    /**
     * POST /api/tasker/milestones/{id}/toggle
     *
     * @param array<string, string> $params
     */
    public function toggleMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->toggle($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * PATCH /api/tasker/milestones/{id}
     *
     * @param array<string, string> $params
     */
    public function updateMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))
            ->update($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
    }

    /**
     * DELETE /api/tasker/milestones/{id}
     *
     * @param array<string, string> $params
     */
    public function deleteMilestone(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new MilestonesApiHandler($this->resolvePdo()))->delete($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * GET /api/tasker/tasks/{id}/discussion
     *
     * @param array<string, string> $params
     */
    public function getDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TaskDiscussionsApiHandler($this->resolvePdo()))->get($tenantId, (int) ($params['id'] ?? 0));
    }

    /**
     * PUT /api/tasker/tasks/{id}/discussion
     *
     * @param array<string, string> $params
     */
    public function putDiscussion(Request $request, array $params = []): Response
    {
        $tenantId = $this->requireTenantId();
        if ($tenantId === null) {
            return Response::error('Tenant context is required', 403);
        }

        return (new TaskDiscussionsApiHandler($this->resolvePdo()))
            ->put($tenantId, (int) ($params['id'] ?? 0), $request->getBody());
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
     * The caller's own OU for the active tenant (nullable — null means
     * tenant-root/unrestricted).
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
     * A caller with no membership row for this tenant (should not happen —
     * RBAC already required a role/permission scoped to this tenant to reach
     * here) is treated as unrestricted rather than failing closed, matching
     * OuScopeResolver's own documented stance that a null OU means
     * tenant-root visibility, not "see nothing".
     */
    private function callerOuId(\PDO $pdo, Request $request, int $tenantId): ?int
    {
        $profileId = $this->callerProfileId($request);
        if ($profileId === null) {
            return null;
        }

        $membership = (new \Whity\Core\Identity\MembershipRepository($pdo))->findByProfile($profileId, $tenantId);

        return $membership['ou_id'] ?? null;
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
