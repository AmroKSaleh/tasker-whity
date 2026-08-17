<?php

declare(strict_types=1);

namespace Tasker;

use Tasker\Access\IdentifierResolver;
use Tasker\Api\AttentionApiHandler;
use Tasker\Api\BoardApiHandler;
use Tasker\Api\FlowsApiHandler;
use Tasker\Api\GroupsApiHandler;
use Tasker\Api\MilestonesApiHandler;
use Tasker\Api\PingApiHandler;
use Tasker\Api\ProjectsApiHandler;
use Tasker\Api\SectionsApiHandler;
use Tasker\Api\SessionApiHandler;
use Tasker\Api\TaskDiscussionsApiHandler;
use Tasker\Api\TaskEdgesApiHandler;
use Tasker\Api\TasksApiHandler;
use Tasker\Domain\FlowBuildPlaybook;
use Tasker\Migrations\AddTaskerProjectPrefixUnique;
use Tasker\Migrations\AddTaskerTaskFlowAndContractColumns;
use Tasker\Migrations\AddTaskerTaskShortIdUnique;
use Tasker\Migrations\CreateTaskerFlowsTable;
use Tasker\Migrations\CreateTaskerGroupsTable;
use Tasker\Migrations\CreateTaskerMilestonesTable;
use Tasker\Migrations\CreateTaskerPingTable;
use Tasker\Migrations\CreateTaskerProjectsTable;
use Tasker\Migrations\CreateTaskerSectionsTable;
use Tasker\Migrations\CreateTaskerTaskDiscussionsTable;
use Tasker\Migrations\CreateTaskerTaskEdgesTable;
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
     * DESTRUCTIVE ROUTE SWEEP (D1b Task 12b review): a destructive route must
     * never resolve its OWN target identifier from a caller default —
     * confirming a request only means something if the caller also named
     * what they confirmed. deleteProject() violated this (fixed in this same
     * review round: an omitted project_id now 400s instead of falling back
     * to defaultProjectIdFor(), even with confirmed:true). Checked every
     * other DELETE route in this class for the same shape; none of the
     * other five have it:
     *   - deleteEnvironment(): explicit `if ($environmentId === null) return
     *     Response::error('environment_id is required', 400);` — no default
     *     path exists at all.
     *   - deleteTask(): task_id resolves via IdentifierResolver::resolveTask(),
     *     which returns null unconditionally for the 'empty' form (no
     *     $defaultProjectId-shaped 5th argument exists on that method at all).
     *   - deleteMilestone(): task_id resolves the same way (resolveTask());
     *     milestone_id/index resolve via resolveMilestoneById()/
     *     resolveMilestoneByIndex(), neither of which accepts a default.
     *   - deleteSection()/deleteGroup(): section_id/group_id (the actual
     *     delete TARGET) resolve via resolveSection()/resolveGroup(), which
     *     return null unconditionally for the 'empty' form. project_id/
     *     section_id on these two routes is only ever a disambiguating
     *     PARENT for a slug — and both call resolveOptionalParentId() with
     *     no 7th argument, so that parent defaults to null (never a caller
     *     default), matching every other resolveOptionalParentId() call site
     *     except listGroups()/createGroup() (a parent default is a
     *     different, much narrower hazard than a PRIMARY target default: at
     *     worst a slug fails to resolve and 404s, since resolveStructural()
     *     never guesses a parent it wasn't given).
     *
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
                            'description' => 'Optional: only projects in this Environment (OU), by integer id. Omit to see every Environment.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The project list'],
                        400 => ['description' => 'environment_id is not an integer id'],
                        404 => ['description' => 'environment_id names an Environment outside the caller\'s OU scope, or one that does not exist'],
                    ],
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
                        409 => ['description' => 'A project with this name already exists in the tenant, or the requested prefix is already used by another project'],
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
                        400 => ['description' => 'A supplied field is invalid, or project_id was empty'],
                        404 => ['description' => 'Project not found or outside the caller\'s OU scope'],
                        409 => ['description' => 'The requested prefix is already used by another project in this tenant'],
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
                    // PARITY (D1b Task 12b): matches the original app's own
                    // wording exactly — this is the ONE place in the slice
                    // where a REQUIRED property is deliberately correct: it
                    // is a safety gate, not a shape gap, and dropping it is
                    // what made this route dangerous (see confirmed below).
                    'summary' => 'Permanently delete a project and all its sections, tasks, and milestones. Always '
                        . 'confirm with the user before calling this.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['project_id', 'confirmed'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id.'],
                            'confirmed' => ['type' => 'boolean', 'description' => 'Must be true to confirm permanent deletion'],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        400 => ['description' => 'confirmed was not true, or project_id was empty (never guessed from your default project for a destructive call)'],
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
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
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
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit to use your default project — but REQUIRED when replace is true, since a destructive replace is never applied to a project you did not name.'],
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
                        400 => ['description' => 'project_id looks like a short id but is malformed, is of a non-identifier type, or was omitted while replace was true; or context is missing'],
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
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
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
                        404 => ['description' => 'Section not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'section_id or project_id looks like a short id but is malformed'],
                        404 => ['description' => 'Section not found in the caller\'s tenant or OU scope'],
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
                    // PARITY (D1b Task 12b), matching the original app's own
                    // wording so an agent gets the same guidance on either
                    // surface: by default this REFUSES a non-empty section.
                    'summary' => 'Delete a section. By default REFUSES if the section still has tasks (move them to '
                        . 'another section first, e.g. via update_task/move_task_to_group). Pass delete_tasks: true '
                        . 'to delete the section together with all its tasks and groups. Irreversible — confirm with '
                        . 'the user before calling.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['section_id'],
                        'properties' => [
                            'section_id' => ['type' => 'string'],
                            'project_id' => ['type' => 'string', 'description' => 'Needed only when section_id is a slug.'],
                            'delete_tasks' => [
                                'type' => 'boolean',
                                'description' => 'If true, delete the section AND every task/group in it. If false '
                                    . '(default), the section must already be empty or the call is refused.',
                            ],
                        ],
                    ],
                    'responses' => [
                        204 => ['description' => 'Deleted'],
                        400 => ['description' => 'section_id or project_id looks like a short id but is malformed'],
                        404 => ['description' => 'Section not found in the caller\'s tenant or OU scope'],
                        409 => ['description' => 'Cannot delete a project\'s last remaining section, or the section '
                            . 'still has tasks/groups and delete_tasks was not true'],
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
                            // D1b Task 12b FIX: the "NOT or slug" caveat this
                            // description used to carry is gone because it is
                            // no longer true — listGroups() now passes
                            // project_id through to resolveSection() as the
                            // parent a slug needs to disambiguate (see
                            // listGroups() below).
                            'description' => 'Section UUID, id, or slug (slug requires project_id).',
                        ],
                        [
                            'name' => 'project_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Needed only when '
                                . 'section_id is a slug. Omit to use your default project.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The group list'],
                        400 => ['description' => 'section_id or project_id looks like a short id but is malformed'],
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
                            // D1b Task 12b FIX: see list_groups above — the
                            // "NOT or slug" caveat is gone because
                            // createGroup() now passes project_id through to
                            // resolveSection() as the slug's parent.
                            'section_id' => ['type' => 'string', 'description' => 'Section UUID, id, or slug (slug requires project_id).'],
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Needed only when section_id is a slug. Omit to use your default project.'],
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
                        404 => ['description' => 'Group not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'group_id or section_id looks like a short id but is malformed'],
                        404 => ['description' => 'Group not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'group_id or section_id looks like a short id but is malformed'],
                        404 => ['description' => 'Group not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'project_id, section_id, or group_id looks like a short id but is malformed, or status is not one of pending/in_progress/done/all'],
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
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                    'summary' => 'Move a task to a DIFFERENT project',
                    // D1b Task 12c: ported to the ORIGINAL's actual live contract
                    // (captured directly from its live MCP server -- the design
                    // repo's index.ts and docs page are both stale here). This
                    // used to relocate/reorder a task WITHIN one project -- a
                    // NAME COLLISION with the original's own move_task, which
                    // moves a task to a different PROJECT entirely. That
                    // within-project capability now lives on move_task_to_group
                    // (which gained sort_order for exactly this reason).
                    'description' => 'Move a task to a DIFFERENT project. Reassigns the short ID into the target '
                        . 'project\'s own sequence; preserves text, detail, priority, status, pinned, due_date and '
                        . 'completed_at. group_id is always cleared -- a group belongs to a section in the SOURCE '
                        . 'project, so nothing about it can travel. This backend has no flows or cross-project I/O '
                        . 'edges at all, so unlike the original there is nothing to unlink or drop on that front. '
                        . 'target_project_id resolving to the task\'s OWN current project is rejected (422) rather '
                        . 'than silently renumbering/un-grouping it -- for a SAME-project move (section, group, or '
                        . 'board order) use update_task or move_task_to_group instead.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id', 'target_project_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31) to move'],
                            'target_project_id' => ['type' => 'string', 'description' => 'Destination project: prefix (e.g. WCP), slug, or UUID'],
                            'target_section_id' => [
                                'type' => 'string',
                                'description' => 'Optional: a section UUID in the TARGET project to drop the task into. If omitted '
                                    . '(or not in the target project) the task lands in the target project\'s own Backlog section '
                                    . '(this backend\'s substitute for "no section" -- tasker_tasks.section_id cannot be null) -- '
                                    . 'never an error.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The moved task, plus previousShortId/newShortId, droppedGroup and landedInBacklog'],
                        400 => ['description' => 'task_id/target_project_id/target_section_id looks like a short id but is malformed, or target_project_id is missing'],
                        404 => ['description' => 'Task or target project not found in the caller\'s tenant or OU scope, or the target project has no Backlog section'],
                        422 => ['description' => 'target_project_id resolves to the task\'s own current project -- use update_task or move_task_to_group for a same-project move'],
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
                    'summary' => 'Move a task into a group, un-group it, or reorder it',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31)'],
                            'group_id' => [
                                'type' => ['string', 'null'],
                                'description' => 'Group UUID, id, or slug to set. Pass null explicitly to UN-GROUP the task. OMITTING '
                                    . 'this key entirely leaves its group membership UNCHANGED -- this is what makes a sort_order-only '
                                    . 'reorder call safe: it never touches group_id at all. The ONE exception: if section_id moves the '
                                    . 'task to a different section, an omitted group_id CLEARS the group, because a group belongs to one '
                                    . 'section and the task no longer sits in it.',
                            ],
                            'section_id' => [
                                'type' => 'string',
                                'description' => 'Optional. Also moves the task into this section, and is the section group_id is validated against. '
                                    . 'Defaults to the task\'s current section. Moving to a DIFFERENT section clears the task\'s group unless you '
                                    . 'supply a group_id in the same call that belongs to the new section.',
                            ],
                            'sort_order' => [
                                'type' => 'integer',
                                'description' => 'ADDITIVE: explicit board ordering within the task\'s section. The live original exposes '
                                    . 'NO reordering tool over MCP at all (its drag-and-drop is a web-UI concern served over its own '
                                    . 'REST layer) -- D2\'s own drag-and-drop frontend needs this here. Optional: omitting the key, or '
                                    . 'passing it as null, both leave sort_order unchanged (this is what lets a pure reorder call, e.g. '
                                    . '{task_id, sort_order}, leave group_id alone too -- see group_id\'s own description). Any other '
                                    . 'value must be an integer or the call 400s.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The task, in its new group/section/position'],
                        400 => ['description' => 'task_id, group_id, or section_id looks like a short id but is malformed, or sort_order is not an integer'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        200 => ['description' => 'Tag already attached (idempotent)'],
                        201 => ['description' => 'Tag attached'],
                        400 => ['description' => 'tag_id missing or not a positive integer'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
                        422 => ['description' => 'tag_id does not exist or does not belong to the caller\'s tenant'],
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
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
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
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
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
            // ==================== Flows (D5a Task 5) ====================
            [
                'method' => 'POST',
                'path' => '/api/tasker/flows/name',
                'handler' => [$this, 'nameFlow'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'name_flow',
                    'summary' => 'Create a flow: name it, stamp membership on its tasks, and compute their initial '
                        . 'topological order from the I/O edges already wired between them. There is no separate '
                        . 'create tool -- this call both creates the flow and assigns its members.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['name', 'task_ids'],
                        'properties' => [
                            'project_id' => ['type' => 'string', 'description' => 'Project prefix, slug, UUID or id. Omit to use your default project.'],
                            'name' => ['type' => 'string', 'description' => 'Human name for the flow (e.g. "Blog Post Publication Flow").'],
                            'task_ids' => [
                                'type' => 'array',
                                'items' => ['type' => 'string'],
                                'description' => 'Every task in the flow (UUIDs or short IDs, e.g. TDE-31). All must already belong to the project.',
                            ],
                            'context' => [
                                'type' => 'object',
                                'description' => 'Optional shared context for the flow -- background, goals, constraints, or instructions that apply to all tasks in it. Must be a JSON OBJECT (not a string or array) -- see parity-allowlist.php for why this differs from the original.',
                            ],
                            'step_list_open' => [
                                'type' => 'boolean',
                                'description' => 'True when the flow\'s full step list is not yet known (research/investigation -- it discovers steps as it goes). Default false.',
                            ],
                        ],
                    ],
                    'responses' => [
                        201 => ['description' => 'The created flow'],
                        400 => ['description' => 'name, project_id, or a task_ids entry is missing, empty, or looks like a malformed short id'],
                        404 => ['description' => 'Project not found, or a task_ids entry not found, in the caller\'s tenant or OU scope'],
                        409 => ['description' => 'A flow with this name already exists in the project'],
                        422 => ['description' => 'A task_ids entry does not belong to the project or already belongs to another flow, context is not a JSON object, or the tasks form a dependency cycle'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/flows',
                'handler' => [$this, 'listFlows'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'list_flows',
                    'summary' => 'List flows. project_id is optional: it falls back to your default project, and if '
                        . 'you have none set, every flow across your whole OU scope is returned.',
                    'tags' => ['tasker'],
                    'parameters' => [
                        [
                            'name' => 'project_id',
                            'in' => 'query',
                            'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Project prefix (e.g. TDE), slug, UUID or id. Omit for your default project, or every project in scope if you have none set.',
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The flow list'],
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
                        404 => ['description' => 'project_id was supplied but not found or outside the caller\'s OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/flows',
                'handler' => [$this, 'deleteFlow'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'delete_flow',
                    'summary' => 'Delete a flow. Its member tasks are NOT deleted -- they return to the board '
                        . '(flow_id cleared) and keep every I/O edge they already had.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['flow_id'],
                        'properties' => [
                            'flow_id' => ['type' => 'string', 'description' => 'Flow UUID, id, or short ID (e.g. TDE-F1).'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'Deleted; reports how many tasks returned to the board'],
                        400 => ['description' => 'flow_id is missing or looks like a short id but is malformed'],
                        404 => ['description' => 'Flow not found in the caller\'s tenant or OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/flows/context',
                'handler' => [$this, 'getFlowContext'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'get_flow_context',
                    'summary' => 'Get a flow\'s shared context bag (plus its full record: name, members\' step '
                        . 'order is on get_flow_order, step_list_open, etc.)',
                    'tags' => ['tasker'],
                    'parameters' => [
                        ['name' => 'flow_id', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string'], 'description' => 'Flow UUID, id, or short ID (e.g. TDE-F1).'],
                    ],
                    'responses' => [
                        200 => ['description' => 'The flow, including its context and stepListOpen'],
                        400 => ['description' => 'flow_id looks like a short id but is malformed'],
                        404 => ['description' => 'Flow not found in the caller\'s tenant or OU scope'],
                    ],
                ],
            ],
            [
                'method' => 'PATCH',
                'path' => '/api/tasker/flows/context',
                'handler' => [$this, 'updateFlowContext'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'update_flow_context',
                    'summary' => 'Merge or replace a flow\'s shared context, and/or flip step_list_open',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['flow_id'],
                        'properties' => [
                            'flow_id' => ['type' => 'string', 'description' => 'Flow UUID, id, or short ID (e.g. TDE-F1). Always required -- there is no default flow to fall back to.'],
                            'context' => [
                                'type' => 'object',
                                'description' => 'The keys to write. Must be a JSON OBJECT (not a string or array) -- see parity-allowlist.php for why this differs from the original. Merged into the existing context by default (a shallow merge). Omit entirely to leave the context untouched (e.g. when you only want to flip step_list_open). Pass replace: true to discard the existing context wholesale instead.',
                            ],
                            'replace' => [
                                'type' => 'boolean',
                                'description' => 'When true, context replaces the whole document instead of merging into it. Defaults to false (merge). Ignored (treated as a no-op on context) when context itself is omitted.',
                            ],
                            'step_list_open' => [
                                'type' => 'boolean',
                                'description' => 'True = the full step list is not yet known (research/investigation discovering its next step as it goes). Set false once the extent is known -- changeable either way mid-run. Omit to leave unchanged.',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The flow, with its updated context and/or step_list_open'],
                        400 => ['description' => 'flow_id is missing or looks like a short id but is malformed'],
                        404 => ['description' => 'Flow not found in the caller\'s tenant or OU scope'],
                        422 => ['description' => 'context is not a JSON object'],
                    ],
                ],
            ],
            [
                'method' => 'GET',
                'path' => '/api/tasker/flows/build',
                'handler' => [$this, 'buildNewFlow'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_structure:manage',
                'schema' => [
                    'operationId' => 'build_new_flow',
                    'summary' => 'The interview playbook for building a new flow (task selection, I/O wiring, '
                        . 'naming) grounded against a real project. Read-only -- this creates nothing; name_flow '
                        . 'does the actual creating.',
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
                        200 => ['description' => 'The playbook, grounded to the resolved project'],
                        400 => ['description' => 'project_id looks like a short id but is malformed'],
                        404 => ['description' => 'project_id was supplied but not found, or omitted with no default project set'],
                    ],
                ],
            ],
            // ==================== Task edges / I/O (D5a Task 7) ====================
            [
                'method' => 'POST',
                'path' => '/api/tasker/tasks/input',
                'handler' => [$this, 'setTaskInput'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'set_task_input',
                    'summary' => 'Wire an I/O edge: task_id (the CONSUMER) receives source_task_id\'s (the '
                        . 'PRODUCER) output as input. Upserts on the (source_task_id, task_id) pair, and re-stamps '
                        . 'the owning flow\'s step order in the same transaction. Refused if it would close a '
                        . 'dependency cycle.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id', 'source_task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31) -- the CONSUMER.'],
                            'source_task_id' => ['type' => 'string', 'description' => 'Upstream task whose output this task consumes (the PRODUCER for this edge).'],
                            'contract' => [
                                'type' => 'object',
                                'description' => 'A quality contract for this input. Must be a JSON OBJECT (not a string or array).',
                            ],
                            'expected_type' => ['type' => 'string', 'description' => 'Optional coarse type hint for this input.'],
                            'replace' => [
                                'type' => 'boolean',
                                'description' => 'If true, replace ALL of task_id\'s other inbound edges with just this one. Default false (upsert only this source\'s edge).',
                            ],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'The upserted edge'],
                        400 => ['description' => 'task_id or source_task_id is missing or looks like a short id but is malformed'],
                        404 => ['description' => 'task_id or source_task_id not found in the caller\'s tenant or OU scope'],
                        422 => ['description' => 'task_id and source_task_id are the same task, belong to different projects, contract is not a JSON object, or the edge would close a dependency cycle'],
                    ],
                ],
            ],
            [
                'method' => 'DELETE',
                'path' => '/api/tasker/tasks/input',
                'handler' => [$this, 'removeTaskInput'],
                'requiredRole' => null,
                'requiredPermission' => 'tasker_task:edit',
                'schema' => [
                    'operationId' => 'remove_task_input',
                    'summary' => 'Remove the I/O edge feeding task_id (the CONSUMER) from source_task_id (the '
                        . 'PRODUCER), and re-stamp the owning flow\'s step order in the same transaction. '
                        . 'source_task_id is REQUIRED here -- see parity-allowlist.php for why this differs from '
                        . 'the original\'s "omit to remove every input edge" form.',
                    'tags' => ['tasker'],
                    'request' => [
                        'type' => 'object',
                        'required' => ['task_id', 'source_task_id'],
                        'properties' => [
                            'task_id' => ['type' => 'string', 'description' => 'Task UUID or short ID (e.g. TDE-31) -- the CONSUMER.'],
                            'source_task_id' => ['type' => 'string', 'description' => 'The upstream source whose edge to remove.'],
                        ],
                    ],
                    'responses' => [
                        200 => ['description' => 'Removed'],
                        400 => ['description' => 'task_id or source_task_id is missing or looks like a short id but is malformed'],
                        404 => ['description' => 'task_id or source_task_id not found in the caller\'s tenant or OU scope, or no such input edge exists'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
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
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id or milestone_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id or milestone_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant or OU scope'],
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
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id or milestone_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task or milestone not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'task_id looks like a short id but is malformed'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        400 => ['description' => 'Request body must be a JSON object, reason must be a string, or messages must be an array'],
                        404 => ['description' => 'Task not found in the caller\'s tenant or OU scope'],
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
                        404 => ['description' => 'Project not found in the caller\'s tenant or OU scope'],
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
            // After the table, before anything that can write a prefix: makes
            // (tenant_id, prefix) unique so a short id is a real reference
            // (whole-branch review B2).
            AddTaskerProjectPrefixUnique::class,
            CreateTaskerSectionsTable::class,
            CreateTaskerGroupsTable::class,
            GrantTaskerProjectPermissions::class,
            CreateTaskerTasksTable::class,
            AddTaskerTaskShortIdUnique::class,
            // D5a Task 2: flows/edges depend on tasker_projects/tasker_tasks,
            // both already created above; the column migration depends on
            // tasker_flows existing too (flow_id references it), so it runs
            // last of the three.
            CreateTaskerFlowsTable::class,
            CreateTaskerTaskEdgesTable::class,
            AddTaskerTaskFlowAndContractColumns::class,
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

        // I5: a wrong-typed identifier is a 400 naming the type problem, rather
        // than being indistinguishable from an omitted one — see
        // wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'environment_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        // I5: a wrong-typed identifier is a 400 naming the type problem, rather
        // than being indistinguishable from an omitted one — see
        // wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'environment_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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
        // CONSISTENCY FIX (whole-branch review): this used to answer an
        // unresolved caller MEMBERSHIP with 'Tenant context is required' — the
        // message for the DIFFERENT failure immediately above it — while ~40
        // other routes correctly say 'Caller membership could not be resolved'.
        // list_projects and create_project are the two routes an agent calls
        // first, so this was the most-seen and least-accurate diagnostic on the
        // surface.
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
        }

        // WHOLE-BRANCH REVIEW B4: the declared `environment_id` query filter is
        // now actually READ. It was declared on this route's schema and never
        // consulted here — a silently-ignored argument, the precise failure this
        // slice existed to eliminate. Read via queryParam() (which covers both
        // $_GET and the path-embedded form) rather than
        // parse_url($request->getPath()), per this plugin's own canonical
        // query accessor.
        //
        // A non-numeric value is a 400 naming the argument, matching
        // ProjectsApiHandler::create()/update()'s own handling of a
        // non-integer environment_id (see extractOuIdInput()'s docblock for why
        // only integers are accepted: OU ids are core's, and this plugin has no
        // OU-identifier resolver). Deliberately NOT a 404, which would read as
        // "no such Environment" for what is really a malformed argument.
        $rawEnvironmentId = $this->queryParam($request, 'environment_id');
        $environmentId = null;
        if ($rawEnvironmentId !== null && trim($rawEnvironmentId) !== '') {
            $trimmed = trim($rawEnvironmentId);
            if (preg_match('/^\d+$/', $trimmed) !== 1) {
                return Response::error('environment_id must be an integer id', 400);
            }
            $environmentId = (int) $trimmed;
        }

        return (new ProjectsApiHandler($pdo))->list($tenantId, $callerOu['ouId'], $environmentId);
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
        // CONSISTENCY FIX (whole-branch review): see listProjects() above — this
        // was the second of the two routes answering an unresolved MEMBERSHIP
        // with the unresolved-TENANT message, conflating two failure modes.
        if (!$callerOu['resolved']) {
            return Response::error('Caller membership could not be resolved', 403);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $raw = $this->identifierFromRequest($request, 'project_id');
        $form = IdentifierResolver::classify($raw);
        if ($form === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }
        // WHOLE-BRANCH REVIEW I4: this route's schema declares
        // required => ['project_id'] (see getRoutes()), but the reader used to
        // pass defaultProjectIdFor() to resolveProject() as its 5th argument.
        // Over MCP core enforces `required` so the mismatch was invisible; over
        // direct HTTP a bare `PATCH /api/tasker/projects {"name":"X"}` RENAMED
        // the caller's default project. The reader now matches the declaration
        // — and the schema is the honest one here, because update_project can
        // change a project's name, prefix and Environment, none of which anyone
        // should apply to a project they did not name.
        if ($form === 'empty') {
            return Response::error('project_id is required', 400);
        }

        $projectId = IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $raw);

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
     * D1b Task 12b FIX (contract parity, unsafe-direction): the original app
     * REQUIRES confirmed:true before permanently deleting a project and
     * everything under it; this route previously had NO such gate at all —
     * confirmed was declared on neither the schema nor checked here, so core's
     * InputSchemaValidator (which enforces only `required`) silently dropped
     * it as an undeclared argument. confirmed is now declared REQUIRED on the
     * schema (see getRoutes() above — the one deliberate exception to this
     * slice's usual "more permissive than the original" posture: here the
     * original's stricter contract IS the safety gate) and is checked here
     * BEFORE any project resolution, the same way a malformed-short-id check
     * runs before resolution elsewhere in this class — a caller who cannot
     * confirm should not learn anything about whether the project exists
     * from a DIFFERENT failure mode.
     *
     * Read via {@see self::paramBool()}, NOT a naive `(bool)` cast — see
     * deleteSection()'s own docblock for why: core empties the body and
     * flattens every MCP argument into the query string for DELETE, so
     * `confirmed: false` sent by an agent MUST still read as false, never
     * coerced truthy by a bare cast on the non-empty string "false". A direct
     * (non-MCP) HTTP caller can send `confirmed` in the JSON body instead —
     * both flags are declared under this route's `request` schema, so
     * paramBool() checks the body FIRST, then the query string, the same
     * precedence identifierFromRequest() already uses for every other field.
     *
     * REVIEW FIX (post-merge): project_id is now REQUIRED to be genuinely
     * supplied — an EMPTY (omitted) project_id 400s instead of silently
     * falling back to defaultProjectIdFor(). This route previously called
     * IdentifierResolver::resolveProject() with the caller's default project
     * as its 5th argument, the exact shape identifierFromRequest()'s own
     * docblock warns against for a DELETE ("would silently fall through to
     * the caller's DEFAULT project — a 204 against the wrong project"): a
     * caller could send `confirmed: true` with NO project_id at all and
     * permanently delete whatever project happened to be their default,
     * having "confirmed" a target they never named. A destructive route must
     * never guess its target from a default — see {@see self::getRoutes()}'s
     * own "DESTRUCTIVE ROUTE SWEEP" note for the other five DELETE routes in
     * this class, all of which were already safe. This also improves
     * parity: the original REQUIRES project_id on delete_project (schema
     * unchanged here — it already required project_id before this fix; only
     * the resolution behaviour changes).
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

        if (!$this->paramBool($request, 'confirmed', false)) {
            return Response::error(
                'confirmed must be true to permanently delete a project and everything under it',
                400
            );
        }

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $raw = $this->identifierFromRequest($request, 'project_id');
        $form = IdentifierResolver::classify($raw);
        if ($form === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }
        if ($form === 'empty') {
            return Response::error('project_id is required', 400);
        }

        $projectId = IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $raw);

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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $merge = $this->mergeFromReplace($decoded);

        $raw = $this->identifierFromRequest($request, 'project_id');
        $form = IdentifierResolver::classify($raw);
        if ($form === 'malformed_short_id') {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        // WHOLE-BRANCH REVIEW B3: replace:true makes this a DESTRUCTIVE route —
        // ProjectsApiHandler::updateContext() turns it into a wholesale
        // `context = :context::jsonb`, discarding a project's entire accumulated
        // Foundation unrecoverably. This route's `required` is ['context'] only,
        // so over MCP `update_project_context({context: {...}, replace: true})`
        // wiped whatever project happened to be the caller's default.
        //
        // That violates this class's own documented rule (see getRoutes()'s
        // DESTRUCTIVE ROUTE SWEEP note): a destructive route must never resolve
        // its OWN target identifier from a caller default, because confirming a
        // request only means something if the caller also named what they
        // confirmed. Task 12b's sweep enumerated by HTTP VERB — "every other
        // DELETE route" — so a destructive PATCH escaped it entirely.
        //
        // Mirrors deleteProject()'s own empty-project_id refusal exactly.
        //
        // MERGE keeps its default-project fallback: it is not destructive, and
        // the original app always merges and always requires project_id, so
        // `replace` is our own invention — the original has no destructive form
        // of this tool for the fallback to be dangerous on.
        if (!$merge && $form === 'empty') {
            return Response::error(
                'project_id is required when replace is true (a destructive replace is never applied to your '
                    . 'default project — name the project explicitly)',
                400
            );
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). project_id is
        // read too, as this route's slug-disambiguating PARENT via
        // resolveOptionalParentId(), which has no Response channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'section_id', 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        return (new SectionsApiHandler($pdo))->update($tenantId, $ou['ouId'], $sectionId, $request->getBody());
    }

    /**
     * DELETE /api/tasker/sections
     *
     * NOTE: deliberately does NOT require the body to decode as a JSON
     * object the way updateSection() does — see
     * {@see self::identifierFromRequest()}'s docblock for why a DELETE
     * request here may legitimately carry no body at all.
     *
     * delete_tasks is read via {@see self::paramBool()} (body-then-query),
     * NOT a naive `(bool)` cast — see that method's own docblock for why
     * both sources matter: DELETE arguments arrive as query-string
     * parameters over the MCP transport (core empties the body and flattens
     * every argument into the query string for GET/DELETE/HEAD), so
     * `delete_tasks: false` sent by an agent MUST still be read as false,
     * never coerced truthy by a bare cast on the non-empty string "false" —
     * but the route's own schema declares delete_tasks under a JSON body
     * shape too, for a direct (non-MCP) HTTP caller.
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). project_id is
        // read too, as this route's slug-disambiguating PARENT via
        // resolveOptionalParentId(), which has no Response channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'section_id', 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        $deleteTasks = $this->paramBool($request, 'delete_tasks', false);

        return (new SectionsApiHandler($pdo))->delete($tenantId, $ou['ouId'], $sectionId, $deleteTasks);
    }

    /**
     * GET /api/tasker/groups?section_id=&project_id=
     *
     * Unlike project_id on listSections(), section_id has no "default
     * section" fallback to fall back to (tasker_user_prefs stores only a
     * default PROJECT) — an omitted or unresolved section_id always 404s.
     * The existence check this relies on (GroupsApiHandler::list() calling
     * sectionVisible() before querying) is D1 Task 4 fix-round behaviour and
     * is unchanged here.
     *
     * D1b Task 12b FIX: this route used to call resolveSection() with NO
     * parent id at all — the only section-consuming route (besides
     * createGroup(), fixed alongside it) that did not even pass null
     * explicitly the way resolveOptionalParentId() callers do. Since
     * resolveSection() refuses a slug when its parent is null (a slug is
     * unique only within its parent — IdentifierResolver::resolveStructural()),
     * section_id's slug form could never resolve here regardless of what a
     * caller supplied, and the route description was correctly amended to
     * stop advertising a path that could not execute. project_id is restored
     * here — through resolveOptionalParentId()'s $defaultValue parameter,
     * falling back to the caller's default project and RE-VALIDATING it
     * through IdentifierResolver::resolveProject()'s own OU-scoped 'empty'
     * branch (post-merge review fix — see resolveOptionalParentId()'s own
     * docblock), exactly like listTasks()/createTask() and every other
     * defaultProjectIdFor() consumer already do — so slug resolution
     * actually works, and the description above is restored to match.
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). project_id is
        // read via resolveOptionalParentId(), which has no Response channel of
        // its own. A no-op in practice on this GET (core sends no body, and a
        // query parameter is always a string), but present so the guard is
        // uniform across every route that reads an identifier — the kind of
        // "sweep stopped early" gap this review keeps finding.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'project_id',
            [IdentifierResolver::class, 'resolveProject'],
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if (!$parent['ok']) {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        $raw = $this->queryParam($request, 'section_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $raw, $parent['value']);
        if ($sectionId === null) {
            return Response::error('Section not found', 404);
        }

        return (new GroupsApiHandler($pdo))->list($tenantId, $ou['ouId'], $sectionId);
    }

    /**
     * POST /api/tasker/groups
     *
     * section_id lives in the body and is required (no default-section
     * fallback exists — see listGroups()'s docblock). project_id is
     * restored for the same reason as listGroups() above — see that
     * method's own docblock.
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

        $parent = $this->resolveOptionalParentId(
            $request,
            $pdo,
            $tenantId,
            $ou['ouId'],
            'project_id',
            [IdentifierResolver::class, 'resolveProject'],
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if (!$parent['ok']) {
            return Response::error('project_id looks like a short id but is malformed', 400);
        }

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). project_id is
        // read too, as this route's slug-disambiguating PARENT via
        // resolveOptionalParentId(), which has no Response channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'section_id', 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $raw = $this->identifierFromRequest($request, 'section_id');
        if (IdentifierResolver::classify($raw) === 'malformed_short_id') {
            return Response::error('section_id looks like a short id but is malformed', 400);
        }

        $sectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $raw, $parent['value']);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). section_id is
        // read too, as this route's slug-disambiguating PARENT via
        // resolveOptionalParentId(), which has no Response channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'group_id', 'section_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        return (new GroupsApiHandler($pdo))->update($tenantId, $ou['ouId'], $groupId, $request->getBody());
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). section_id is
        // read too, as this route's slug-disambiguating PARENT via
        // resolveOptionalParentId(), which has no Response channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'group_id', 'section_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        return (new GroupsApiHandler($pdo))->delete($tenantId, $ou['ouId'], $groupId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). section_id is
        // read too, via resolveCreateTaskSectionId(), which has no Response
        // channel of its own.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id', 'section_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->update($tenantId, $ou['ouId'], $taskId, $request->getBody());
    }

    /**
     * POST /api/tasker/tasks/move — the original's move_task, ported (D1b
     * Task 12c) to its ACTUAL live contract: a CROSS-PROJECT move. task_id
     * and target_project_id are both resolved HERE via
     * {@see \Tasker\Access\IdentifierResolver}, which is OU-scoped — a task
     * or target project outside the caller's tenant/OU scope 404s before
     * {@see \Tasker\Api\TasksApiHandler::moveToProject()} is ever reached
     * (which ALSO re-derives and checks both, belt-and-braces — see that
     * method's own docblock).
     *
     * target_project_id is REQUIRED and never falls back to the caller's
     * default project: a route that mutates must never guess its target —
     * the same rule {@see self::deleteProject()}'s own docblock states and
     * enforces for project_id there. An EMPTY (omitted) target_project_id is
     * therefore a plain 400, checked BEFORE any resolution happens, exactly
     * like deleteProject()'s own confirmed/project_id ordering.
     *
     * target_section_id is OPTIONAL and resolved the SAME way (OU-scoped, via
     * IdentifierResolver::resolveSection(), parented to $targetProjectId for
     * its slug/prefix forms) — but unlike task_id/target_project_id, an
     * unresolved or malformed-looking-but-not-actually-malformed target
     * section is NEVER an error here: only a genuinely MALFORMED short id
     * shape 400s (matching every other identifier in this class). Whether
     * the caller's candidate actually belongs to $targetProjectId is
     * TasksApiHandler::moveToProject()'s own job (its id/UUID forms are not
     * parent-checked by resolveSection() itself — see that method's own
     * doc) — this route only resolves the candidate, never rejects it.
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'target_project_id', 'target_section_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }
        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        $rawTargetProjectId = $this->identifierFromRequest($request, 'target_project_id');
        $targetForm = IdentifierResolver::classify($rawTargetProjectId);
        if ($targetForm === 'malformed_short_id') {
            return Response::error('target_project_id looks like a short id but is malformed', 400);
        }
        if ($targetForm === 'empty') {
            return Response::error('target_project_id is required', 400);
        }
        $targetProjectId = IdentifierResolver::resolveProject($pdo, $tenantId, $ou['ouId'], $rawTargetProjectId);
        if ($targetProjectId === null) {
            return Response::error('Target project not found', 404);
        }

        $rawTargetSectionId = $this->identifierFromRequest($request, 'target_section_id');
        if (IdentifierResolver::classify($rawTargetSectionId) === 'malformed_short_id') {
            return Response::error('target_section_id looks like a short id but is malformed', 400);
        }
        // Absent, unresolved, or (for id/UUID forms) belonging to a DIFFERENT
        // project all arrive at moveToProject() as a candidate that is not
        // usable — resolved here, but never turned into an error here. See
        // this method's own docblock and moveToProject()'s for why that
        // final belongs-to-the-target-project check lives there instead.
        $targetSectionId = IdentifierResolver::resolveSection($pdo, $tenantId, $ou['ouId'], $rawTargetSectionId, $targetProjectId);

        return (new TasksApiHandler($pdo))->moveToProject($tenantId, $ou['ouId'], $taskId, $targetProjectId, $targetSectionId);
    }

    /**
     * POST /api/tasker/tasks/group — the original's move_task_to_group:
     * move a task into a group, un-group it, move it between sections, AND
     * (ADDITIVELY, D1b Task 12c) reorder it — deliberately narrower in scope
     * per-field than the now cross-project moveTask() above, but four
     * independent things can each be requested in one call.
     *
     * group_id ABSENT vs EXPLICIT NULL now DIFFER (D1b Task 12c review round
     * 1 — see {@see \Tasker\Api\TasksApiHandler::moveToGroup()}'s own
     * docblock for the full reasoning): ABSENT (the key is not in the
     * request at all) leaves group_id COMPLETELY UNTOUCHED — the shape a
     * pure reorder call (`{task_id, sort_order: 3}`) actually has, and which
     * used to silently un-group the task before this fix. EXPLICIT NULL
     * still un-groups, exactly as D1b Task 9 established. Read directly via
     * {@see self::resolveMoveDestinationId()} (not the now-retired
     * resolveGroupMembership(), which collapsed exactly this distinction)
     * — its own 'absent' status maps to $groupProvided = false.
     *
     * sort_order is read as a plain integer straight off the decoded body —
     * no identifier resolution needed, it is never an identifier — but
     * VALIDATED, not just cast: absent OR explicit null both leave it
     * unchanged (null); a non-integer, non-numeric-string value (a bool, an
     * array, a non-numeric string) 400s rather than silently coercing to 0/1
     * the way a bare `(int)` cast would (review round 1 finding — every
     * OTHER field on this route either resolves an identifier or validates
     * its shape; sort_order was the one silent exception).
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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
        // 'absent'/'explicit_null' to the same null value here — a task
        // simply stays in its current section when this key is not supplied.
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

        // group_id: 'absent' -> $groupProvided false, group_id left
        // completely untouched by TasksApiHandler::moveToGroup(). 'resolved'
        // -> $groupProvided true, value carries the real id. Anything else
        // ('explicit_null' included) -> $groupProvided true, value null,
        // which moveToGroup() treats as an explicit un-group. See this
        // method's own docblock and moveToGroup()'s for the full reasoning.
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
        $groupProvided = $group['status'] !== 'absent';
        $groupId = $group['value'];

        // sort_order (D1b Task 12c, ADDITIVE): absent or explicit null both
        // leave it unchanged; anything else must be a genuine integer.
        $sortOrder = null;
        if (array_key_exists('sort_order', $decoded) && $decoded['sort_order'] !== null) {
            $rawSortOrder = $decoded['sort_order'];
            $isIntegerLike = is_int($rawSortOrder)
                || (is_string($rawSortOrder) && preg_match('/^-?\d+$/', $rawSortOrder) === 1);
            if (!$isIntegerLike) {
                return Response::error('sort_order must be an integer', 400);
            }
            $sortOrder = (int) $rawSortOrder;
        }

        return (new TasksApiHandler($pdo))->moveToGroup($tenantId, $ou['ouId'], $taskId, $groupId, $groupProvided, $sectionId, $sortOrder);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->delete($tenantId, $ou['ouId'], $taskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->complete($tenantId, $ou['ouId'], $taskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->uncomplete($tenantId, $ou['ouId'], $taskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->pin($tenantId, $ou['ouId'], $taskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->unpin($tenantId, $ou['ouId'], $taskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }

        $taskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($taskId === null) {
            return Response::error('Task not found', 404);
        }

        return (new TasksApiHandler($pdo))->tag($tenantId, $ou['ouId'], $taskId, $request->getBody());
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
     * resolveMoveDestinationId()/mergeFromReplace() elsewhere in this file
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
     * POST /api/tasker/flows/name — the flow-CREATING call (D5a Task 5).
     * There is no separate create tool: this both inserts the flow row and
     * stamps membership/initial order on its tasks.
     *
     * project_id is optional (falls back to the caller's default project,
     * like createSection()/createTask()). Each task_ids entry is resolved
     * HERE via IdentifierResolver::resolveTask() (OU-scoped) — an entry
     * outside the caller's tenant/OU scope 404s before FlowsApiHandler::name()
     * is ever reached, which then ALSO re-checks every resolved id belongs to
     * $projectId itself (see that method's own docblock) — the same
     * defence-in-depth layering every other create route in this plugin
     * applies to its own parent/member identifiers.
     *
     * @param array<string, string> $params
     */
    public function nameFlow(Request $request, array $params = []): Response
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'project_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        $name = (string) ($decoded['name'] ?? '');

        $rawTaskIds = $decoded['task_ids'] ?? null;
        if (!is_array($rawTaskIds) || $rawTaskIds === []) {
            return Response::error('task_ids must be a non-empty array', 400);
        }

        $taskIds = [];
        foreach ($rawTaskIds as $rawTaskId) {
            if (!is_string($rawTaskId) && !is_int($rawTaskId)) {
                return Response::error('Each task_ids entry must be a string or integer identifier', 400);
            }
            if (IdentifierResolver::classify($rawTaskId) === 'malformed_short_id') {
                return Response::error('A task_ids entry looks like a short id but is malformed', 400);
            }
            $resolvedTaskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
            if ($resolvedTaskId === null) {
                return Response::error('Task not found', 404);
            }
            $taskIds[] = $resolvedTaskId;
        }

        // REVIEW FIX: this used to be a bare `is_array(...) ? ... : null`,
        // which let a JSON ARRAY (e.g. `context: [1, 2]`) through unchecked —
        // stored straight into the jsonb column as `[1,2]`, which Task 6's
        // planned `context = context || :context::jsonb` merge does not
        // MERGE with an existing object, it APPENDS
        // (`'[1,2]'::jsonb || '{"a":1}'::jsonb` = `[1, 2, {"a": 1}]`).
        // {@see self::isJsonObject()} already exists for exactly this check
        // (updateProjectContext() uses it above) and was not being reused
        // here. context is OPTIONAL on this route (unlike
        // updateProjectContext(), where it is required), so an absent or
        // explicit `null` context is still fine — only a PRESENT, non-null,
        // non-object value 422s.
        $context = null;
        if (array_key_exists('context', $decoded) && $decoded['context'] !== null) {
            if (!self::isJsonObject($decoded['context'])) {
                return Response::error('context must be a JSON object', 422);
            }
            /** @var array<string, mixed> $context */
            $context = $decoded['context'];
        }

        $stepListOpen = $this->paramBool($request, 'step_list_open', false);
        $createdBy = $this->callerProfileId($request);

        return (new FlowsApiHandler($pdo))
            ->name($tenantId, $ou['ouId'], $projectId, $name, $taskIds, $context, $stepListOpen, $createdBy);
    }

    /**
     * GET /api/tasker/flows?project_id= (D5a Task 5)
     *
     * project_id is optional, using the SAME defaultProjectIdFor() fallback
     * mechanism as listSections() — but unlike listSections() (which 404s
     * when the caller has no default project, since a section has no meaning
     * outside one), an omitted project_id with no resolvable default falls
     * through to null rather than 404ing, and FlowsApiHandler::list() treats
     * null as "every flow across the caller's whole OU scope" — the same
     * "search everywhere on omission" shape getMyAttention() already uses
     * for its own optional project_id, just reached through
     * resolveProject()'s existing 'empty' branch instead of a bespoke one.
     * An EXPLICITLY supplied project_id that fails to resolve still 404s: a
     * caller who named a specific project and got it wrong should be told,
     * not silently shown every flow they can see.
     *
     * @param array<string, string> $params
     */
    public function listFlows(Request $request, array $params = []): Response
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

        $projectId = IdentifierResolver::resolveProject(
            $pdo,
            $tenantId,
            $ou['ouId'],
            $raw,
            $this->defaultProjectIdFor($request, $tenantId)
        );
        if ($projectId === null && $form !== 'empty') {
            return Response::error('Project not found', 404);
        }

        return (new FlowsApiHandler($pdo))->list($tenantId, $ou['ouId'], $projectId);
    }

    /**
     * DELETE /api/tasker/flows (D5a Task 5)
     *
     * flow_id is REQUIRED and never falls back to a caller default — a
     * mutating route never resolves its own target from a default (the same
     * rule deleteProject()/moveTask() state and enforce for their own
     * required identifiers). Read via identifierFromRequest(), which covers
     * body-then-query, since core empties the DELETE body and flattens every
     * MCP argument into the query string instead.
     *
     * @param array<string, string> $params
     */
    public function deleteFlow(Request $request, array $params = []): Response
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

        $wrongTyped = $this->wrongTypedIdentifierError($request, 'flow_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawFlowId = $this->identifierFromRequest($request, 'flow_id');
        $form = IdentifierResolver::classify($rawFlowId);
        if ($form === 'empty') {
            return Response::error('flow_id is required', 400);
        }
        if ($form === 'malformed_short_id') {
            return Response::error('flow_id looks like a short id but is malformed', 400);
        }

        $flowId = IdentifierResolver::resolveFlow($pdo, $tenantId, $ou['ouId'], $rawFlowId);
        if ($flowId === null) {
            return Response::error('Flow not found', 404);
        }

        return (new FlowsApiHandler($pdo))->delete($tenantId, $ou['ouId'], $flowId);
    }

    /**
     * GET /api/tasker/flows/context?flow_id= — the original's
     * get_flow_context (D5a Task 6).
     *
     * flow_id is REQUIRED, unlike getProject()/getBoard()'s project_id: there
     * is no "default flow" fallback anywhere in this plugin (no
     * defaultFlowIdFor(), no tasker_user_prefs column for one), so there is
     * nothing to fall back to. Mirrors getTask()'s own shape exactly —
     * malformed_short_id -> 400, otherwise resolveFlow() (OU-scoped) -> 404
     * on a miss — rather than deleteFlow()'s explicit empty-check: flow_id is
     * declared `required` on THIS route's own `parameters` (a GET query
     * parameter, validated by core's InputSchemaValidator before the handler
     * ever runs), not a `request` body `required` list subject to
     * DELETE's own body-gets-emptied idiosyncrasy (see deleteFlow()'s own
     * docblock for why THAT route needs the extra manual check).
     *
     * PARITY: the original addresses this by `task_id` ("any task in the
     * flow"); that alternate lookup form is not ported, so flow_id is the
     * only way to address a flow here — see this task's own
     * parity-allowlist.php entry.
     *
     * @param array<string, string> $params
     */
    public function getFlowContext(Request $request, array $params = []): Response
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

        $rawFlowId = $this->queryParam($request, 'flow_id');
        if (IdentifierResolver::classify($rawFlowId) === 'malformed_short_id') {
            return Response::error('flow_id looks like a short id but is malformed', 400);
        }

        $flowId = IdentifierResolver::resolveFlow($pdo, $tenantId, $ou['ouId'], $rawFlowId);
        if ($flowId === null) {
            return Response::error('Flow not found', 404);
        }

        return (new FlowsApiHandler($pdo))->getContext($tenantId, $ou['ouId'], $flowId);
    }

    /**
     * PATCH /api/tasker/flows/context — get_flow_context's write counterpart,
     * the original's update_flow_context (D5a Task 6), narrowed to the two
     * fields this backend actually models: context and step_list_open. A
     * caller-chosen rename or short_id change is not ported (see this
     * task's own parity-allowlist.php entry).
     *
     * `context` MUST be a genuine JSON object — the SAME
     * {@see self::isJsonObject()} helper and the SAME 422
     * updateProjectContext()/nameFlow() already use, deliberately not a
     * second validation convention (see FlowsApiHandler::updateContext()'s
     * own docblock for why a JSON ARRAY operand would make the planned
     * `context || :context::jsonb` merge APPEND instead of merging).
     * UNLIKE updateProjectContext(), `context` stays OPTIONAL here —
     * matching the original (only `task_id` is required) AND nameFlow()'s
     * own precedent on this exact resource: an absent or explicit-null
     * `context` makes NO change to the stored context at all, regardless of
     * `replace`. Implemented by forcing $merge=true with an EMPTY object in
     * that case, which is a genuine SQL no-op (`x || '{}'::jsonb = x`) rather
     * than a third SQL shape — the handler still only ever sees one of
     * exactly two hardcoded literals. This deliberately keeps `replace:
     * true` PLUS an omitted context from ever wiping a flow's context by
     * accident, the same class of danger this slice's own review caught on
     * update_project_context's project_id fallback (see next paragraph).
     *
     * `flow_id` is ALWAYS required — 400 on an absent one, for BOTH merge
     * and replace, never a default fallback. This is stricter than
     * updateProjectContext() (which keeps a default-project fallback for
     * its non-destructive merge case): there is no "default flow" concept
     * anywhere in this plugin to fall back TO, so unlike project_id there is
     * no fallback for merge to keep. Mirrors deleteFlow()'s own unconditional
     * requirement for the identical reason, and satisfies this slice's own
     * rule that `replace: true` must never guess its destructive target —
     * the exact defect D1b's review caught on update_project_context, where
     * `replace` could wipe an unnamed project's Foundation.
     *
     * @param array<string, string> $params
     */
    public function updateFlowContext(Request $request, array $params = []): Response
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

        $merge = true;
        $context = [];
        if (array_key_exists('context', $decoded) && $decoded['context'] !== null) {
            if (!self::isJsonObject($decoded['context'])) {
                return Response::error('context must be a JSON object', 422);
            }
            /** @var array<string, mixed> $context */
            $context = $decoded['context'];
            $merge = $this->mergeFromReplace($decoded);
        }

        $stepListOpen = array_key_exists('step_list_open', $decoded)
            ? $this->bodyParamBool($decoded, 'step_list_open', false)
            : null;

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError(). (There is no
        // default to fall through to here, but the same guard still applies
        // before flow_id's own emptiness is even checked.)
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'flow_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawFlowId = $this->identifierFromRequest($request, 'flow_id');
        $form = IdentifierResolver::classify($rawFlowId);
        if ($form === 'empty') {
            return Response::error('flow_id is required', 400);
        }
        if ($form === 'malformed_short_id') {
            return Response::error('flow_id looks like a short id but is malformed', 400);
        }

        $flowId = IdentifierResolver::resolveFlow($pdo, $tenantId, $ou['ouId'], $rawFlowId);
        if ($flowId === null) {
            return Response::error('Flow not found', 404);
        }

        return (new FlowsApiHandler($pdo))
            ->updateContext($tenantId, $ou['ouId'], $flowId, $context, $merge, $stepListOpen);
    }

    /**
     * GET /api/tasker/flows/build?project_id= — the original's
     * build_new_flow (D5a Task 6).
     *
     * A READ, like {@see self::initSession()}: it creates nothing and calls
     * no FlowsApiHandler method at all (there is nothing to persist — a flow
     * is only actually created by name_flow). It composes a STATIC interview
     * playbook ({@see FlowBuildPlaybook::text()}, the flow-building
     * counterpart of {@see \Tasker\Domain\DirectivePlaybook::text()}) with
     * live "project grounding" — here, simply the resolved, OU-scoped
     * project id itself, proving the target project exists and is visible to
     * the caller before the agent starts the interview — and returns both.
     *
     * project_id is OPTIONAL, using the same defaultProjectIdFor() fallback
     * every other project-scoped read in this plugin uses (getProject()/
     * getBoard()/listFlows()); an EXPLICITLY supplied project_id that fails
     * to resolve still 404s, the same "a caller who named a specific project
     * and got it wrong should be told" rule listFlows() already documents.
     *
     * PARITY: the original's build_new_flow also accepts `goal` (elicited
     * inline) and `seed_id` (resolves a flow seed) — neither seeds
     * (resolve_seed et al.) nor a goal-priming mechanism are ported; see this
     * task's own parity-allowlist.php entry.
     *
     * @param array<string, string> $params
     */
    public function buildNewFlow(Request $request, array $params = []): Response
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

        return Response::json([
            'data' => [
                'projectId' => $projectId,
                'playbook'  => FlowBuildPlaybook::text(),
            ],
        ], 200);
    }

    /**
     * POST /api/tasker/tasks/input — the original's set_task_input (D5a Task
     * 7). task_id (the consumer) and source_task_id (the producer) are BOTH
     * resolved HERE via {@see IdentifierResolver}, which is OU-scoped -- a
     * task outside the caller's tenant/OU scope 404s before
     * {@see \Tasker\Api\TaskEdgesApiHandler::setInput()} is ever reached,
     * which ALSO re-checks both via its own taskInfo() (defence in depth,
     * the same layering {@see self::nameFlow()} applies to its own task_ids).
     *
     * NEITHER identifier falls back to a caller default: this plugin's
     * mutating-route rule (see {@see self::deleteFlow()}'s own docblock for
     * the same rule stated identically) forbids a mutation from ever
     * guessing its own target, so an absent task_id OR source_task_id is a
     * plain 400, never a silent fall-through.
     *
     * `contract` must be a genuine JSON OBJECT -- the SAME
     * {@see self::isJsonObject()} 422 {@see self::nameFlow()}/
     * {@see self::updateProjectContext()} already use, not a second
     * validation convention. `replace` maps onto
     * {@see \Tasker\Api\TaskEdgesApiHandler::setInput()}'s own `$replaceAll`
     * parameter -- named `replace` here (not `replace_all`) specifically so
     * this property matches the original's own set_task_input schema
     * byte-for-byte, needing no parity-allowlist entry at all.
     *
     * @param array<string, string> $params
     */
    public function setTaskInput(Request $request, array $params = []): Response
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default -- see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'source_task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        $taskForm = IdentifierResolver::classify($rawTaskId);
        if ($taskForm === 'empty') {
            return Response::error('task_id is required', 400);
        }
        if ($taskForm === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }
        $targetTaskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($targetTaskId === null) {
            return Response::error('Task not found', 404);
        }

        $rawSourceTaskId = $this->identifierFromRequest($request, 'source_task_id');
        $sourceForm = IdentifierResolver::classify($rawSourceTaskId);
        if ($sourceForm === 'empty') {
            return Response::error('source_task_id is required', 400);
        }
        if ($sourceForm === 'malformed_short_id') {
            return Response::error('source_task_id looks like a short id but is malformed', 400);
        }
        $sourceTaskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawSourceTaskId);
        if ($sourceTaskId === null) {
            return Response::error('Source task not found', 404);
        }

        $contract = null;
        if (array_key_exists('contract', $decoded) && $decoded['contract'] !== null) {
            if (!self::isJsonObject($decoded['contract'])) {
                return Response::error('contract must be a JSON object', 422);
            }
            /** @var array<string, mixed> $contract */
            $contract = $decoded['contract'];
        }

        $expectedType = null;
        if (array_key_exists('expected_type', $decoded) && $decoded['expected_type'] !== null) {
            if (!is_string($decoded['expected_type'])) {
                return Response::error('expected_type must be a string', 400);
            }
            $trimmedType = trim($decoded['expected_type']);
            $expectedType = $trimmedType !== '' ? $trimmedType : null;
        }

        $replaceAll = $this->paramBool($request, 'replace', false);

        return (new TaskEdgesApiHandler($pdo))
            ->setInput($tenantId, $ou['ouId'], $targetTaskId, $sourceTaskId, $expectedType, $contract, $replaceAll);
    }

    /**
     * DELETE /api/tasker/tasks/input — the original's remove_task_input (D5a
     * Task 7).
     *
     * MUST read BOTH identifiers via {@see self::identifierFromRequest()}
     * (body-then-query), never the body alone -- core empties a DELETE
     * request's body and flattens every MCP argument into the query string
     * instead (see {@see self::identifierFromRequest()}'s own docblock). A
     * body-only read here would 400 on every real MCP call, exactly the
     * mistake this slice's own brief calls out as having shipped once before
     * and only caught by smoke-testing the real transport.
     *
     * source_task_id is REQUIRED here, UNLIKE the original (which treats an
     * absent source_task_id as "remove every input edge"): this plugin's
     * mutating-route rule forbids a mutation from resolving its own target
     * from a caller default, and there is no "every edge" default to fall
     * back to that is not itself a guess about which edges the caller meant.
     * See `parity-allowlist.php`'s own `remove_task_input` entry for this
     * divergence, recorded rather than silently narrowed.
     *
     * @param array<string, string> $params
     */
    public function removeTaskInput(Request $request, array $params = []): Response
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default -- see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'source_task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $rawTaskId = $this->identifierFromRequest($request, 'task_id');
        $taskForm = IdentifierResolver::classify($rawTaskId);
        if ($taskForm === 'empty') {
            return Response::error('task_id is required', 400);
        }
        if ($taskForm === 'malformed_short_id') {
            return Response::error('task_id looks like a short id but is malformed', 400);
        }
        $targetTaskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawTaskId);
        if ($targetTaskId === null) {
            return Response::error('Task not found', 404);
        }

        $rawSourceTaskId = $this->identifierFromRequest($request, 'source_task_id');
        $sourceForm = IdentifierResolver::classify($rawSourceTaskId);
        if ($sourceForm === 'empty') {
            return Response::error('source_task_id is required', 400);
        }
        if ($sourceForm === 'malformed_short_id') {
            return Response::error('source_task_id looks like a short id but is malformed', 400);
        }
        $sourceTaskId = IdentifierResolver::resolveTask($pdo, $tenantId, $ou['ouId'], $rawSourceTaskId);
        if ($sourceTaskId === null) {
            return Response::error('Source task not found', 404);
        }

        return (new TaskEdgesApiHandler($pdo))->removeInput($tenantId, $ou['ouId'], $targetTaskId, $sourceTaskId);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        // resolveMilestoneTarget() reads all three of these and returns a status
        // array, not a Response, so the guard lives here.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'milestone_id', 'index');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        // resolveMilestoneTarget() reads all three of these and returns a status
        // array, not a Response, so the guard lives here.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'milestone_id', 'index');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->setChecked($tenantId, $ou['ouId'], (int) $target['milestoneId'], true);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        // resolveMilestoneTarget() reads all three of these and returns a status
        // array, not a Response, so the guard lives here.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'milestone_id', 'index');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->setChecked($tenantId, $ou['ouId'], (int) $target['milestoneId'], false);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        // resolveMilestoneTarget() reads all three of these and returns a status
        // array, not a Response, so the guard lives here.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'milestone_id', 'index');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->update($tenantId, $ou['ouId'], (int) $target['milestoneId'], $request->getBody());
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        // resolveMilestoneTarget() reads all three of these and returns a status
        // array, not a Response, so the guard lives here.
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id', 'milestone_id', 'index');
        if ($wrongTyped !== null) {
            return $wrongTyped;
        }

        $target = $this->resolveMilestoneTarget($request, $pdo, $tenantId, $ou['ouId'], [IdentifierResolver::class, 'resolveTask']);
        $error = $this->milestoneTargetError($target);
        if ($error !== null) {
            return $error;
        }

        return (new MilestonesApiHandler($pdo))->delete($tenantId, $ou['ouId'], (int) $target['milestoneId']);
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

        // I5: a wrong-typed identifier is a 400, never a silent fall-through to
        // the caller's default — see wrongTypedIdentifierError().
        $wrongTyped = $this->wrongTypedIdentifierError($request, 'task_id');
        if ($wrongTyped !== null) {
            return $wrongTyped;
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
     *
     * THIRD REGRESSION FIX (whole-branch review I5) — a body value that is
     * PRESENT but of a type no identifier can ever have (float, bool, array,
     * object) no longer FALLS THROUGH to the query string.
     *
     * It used to. And for a body-carrying PATCH/POST the query string is empty,
     * so the fall-through produced null → {@see IdentifierResolver::classify()}
     * 'empty' → the caller's DEFAULT PROJECT. `{"project_id": 42.0}` and
     * `{"project_id": true}` therefore did not fail: they silently RETARGETED
     * the call at whatever project happened to be the caller's default, and
     * update_project_context merged into it. Blocked over MCP by core's
     * InputSchemaValidator, wide open over direct HTTP.
     *
     * Returning null here is FAIL-CLOSED, not the old behaviour: a wrong-typed
     * body value can no longer be silently replaced by a query parameter of the
     * same name. The 400 itself comes from
     * {@see self::wrongTypedIdentifierError()}, which every route reading an
     * identifier calls alongside its existing malformed-short-id guard.
     *
     * WHY NOT A `false` SENTINEL (considered and rejected): returning a value
     * outside `string|int|null` would make PHPStan flag every unhandled call
     * site, which is attractive — the failure mode this review keeps finding is
     * a sweep that stopped early. But it does not work here: PHPStan resolves
     * `Whity\Sdk\Http\Request` loosely enough that it does not propagate this
     * method's return type into the callers' variables at all (verified
     * empirically — a literal `classify(false)` IS reported, the same value
     * arriving via a variable is NOT). So the sentinel would buy no
     * enforcement while making any missed site a strict_types TypeError, i.e. a
     * 500 — strictly worse than the bug being fixed. Completeness is instead
     * enforced by {@see \Tasker\Tests\TaskerPluginTest} walking every route.
     *
     * AN EXPLICIT JSON null IS NOT A WRONG TYPE. `{"project_id": null}` still
     * falls through and still means "use my default", identical to omitting the
     * key: null is how JSON says "not supplied", and every caller that fills
     * optional fields with null would otherwise break.
     */
    private function identifierFromRequest(Request $request, string $key): string|int|null
    {
        if (self::bodyValueIsWrongTypedIdentifier($request, $key)) {
            return null;
        }

        $decoded = json_decode($request->getBody(), true);
        if (is_array($decoded) && array_key_exists($key, $decoded) && (is_string($decoded[$key]) || is_int($decoded[$key]))) {
            return $decoded[$key];
        }

        return $this->queryParam($request, $key);
    }

    /**
     * The 400 for a body value that is present but of a type that can never be
     * an identifier — or null when every $key is absent, explicitly null, or a
     * genuine string/int (whole-branch review I5).
     *
     * VARIADIC so a route states ALL the identifier keys it reads in one guard,
     * including those it reads indirectly through
     * {@see self::resolveOptionalParentId()}/{@see self::resolveCreateTaskSectionId()}
     * (those helpers return ?int / an array and so have no Response channel of
     * their own; the route that owns the request carries the guard instead).
     * {@see self::resolveMoveDestinationId()} needs no entry here — it has
     * ALWAYS rejected a non-string/non-int value itself, as its
     * `!is_string($raw) && !is_int($raw)` arm shows. That it got this right
     * while identifierFromRequest() did not is precisely the inconsistency this
     * fix closes.
     *
     * Pure: it re-reads the request body rather than carrying state, so it can
     * be called at any point in a route method, and calling it twice is free of
     * consequence.
     *
     * Completeness across routes is enforced mechanically — see
     * {@see \Tasker\Tests\TaskerPluginTest::testEveryRouteGuardsEveryIdentifierItReadsAgainstAWrongType()}.
     */
    private function wrongTypedIdentifierError(Request $request, string ...$keys): ?Response
    {
        foreach ($keys as $key) {
            if (self::bodyValueIsWrongTypedIdentifier($request, $key)) {
                return Response::error($key . ' must be a string or integer identifier', 400);
            }
        }

        return null;
    }

    /**
     * Whether the request body carries $key with a non-null value that is
     * neither a string nor an int. The single predicate behind both
     * {@see self::identifierFromRequest()}'s fail-closed null and
     * {@see self::wrongTypedIdentifierError()}'s 400, so the two can never
     * disagree about what "wrong-typed" means.
     */
    private static function bodyValueIsWrongTypedIdentifier(Request $request, string $key): bool
    {
        $decoded = json_decode($request->getBody(), true);
        if (!is_array($decoded) || !array_key_exists($key, $decoded)) {
            return false;
        }

        $value = $decoded[$key];

        return $value !== null && !is_string($value) && !is_int($value);
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
     * Parse an OPTIONAL boolean, checking the JSON BODY first and falling
     * back to the query string — the boolean counterpart of
     * {@see self::identifierFromRequest()}, which already applies exactly
     * this precedence for every identifier field in this class. delete_tasks
     * (deleteSection()) and confirmed (deleteProject()) both need it: their
     * route schemas declare both flags under `request` (a JSON body shape),
     * which is what the MCP transport's tools/call path actually validates
     * against — but MCP DELETE calls arrive with an EMPTY body and every
     * argument flattened into the query string instead (see
     * identifierFromRequest()'s own docblock), so {@see self::queryParamBool()}
     * alone is correct for that transport. A direct, non-MCP HTTP DELETE
     * with a genuine JSON body (`{"confirmed": true}`) is the shape the
     * schema advertises, though, and {@see self::queryParamBool()} alone
     * silently reads that as absent — REVIEW FIX (post-merge): confirmed
     * empirically to read as `false` even when the body said `true`, which
     * is fail-safe (a caller who somehow gets past core's own required-field
     * check gets a refusal, never an un-confirmed delete) but disagrees with
     * the advertised shape, and the D2 frontend (a genuine HTTP client, not
     * MCP) would walk straight into it.
     *
     * Body-then-query, exactly like identifierFromRequest(): a genuine JSON
     * body value wins when present; MCP's query-string-only shape resolves
     * through {@see self::queryParamBool()} unchanged. The same accepted
     * falsy-string set is used on both paths (via {@see self::bodyParamBool()}/
     * {@see self::queryParamBool()}), so `"confirmed": "false"` (a STRING,
     * not a genuine JSON boolean) is handled no differently than
     * `confirmed=false` on the query string.
     */
    private function paramBool(Request $request, string $name, bool $default): bool
    {
        $decoded = json_decode($request->getBody(), true);
        if (is_array($decoded) && array_key_exists($name, $decoded)) {
            return $this->bodyParamBool($decoded, $name, $default);
        }

        return $this->queryParamBool($request, $name, $default);
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
     * this same file ({@see self::resolveMoveDestinationId()},
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
     *   - not supplied at all ('empty' form), $defaultValue null (every
     *     caller except listGroups()/createGroup() — see $defaultValue
     *     below): {ok: true, value: null}. The resolver is never called; a
     *     slug lookup against a null parent legitimately fails to resolve
     *     later (resolveSection()/resolveGroup() return null for a
     *     slug/prefix form with $parentId === null), which becomes the same
     *     404 as "not found", not a separate error here.
     *   - not supplied at all ('empty' form), $defaultValue non-null:
     *     {ok: true, value: $resolver($pdo, $tenantId, $callerOuId, $raw, $defaultValue)}.
     *     REVIEW FIX (post-merge, item 4): the resolver IS called here, with
     *     $raw (null/'') passed through untouched and $defaultValue as its
     *     own 5th argument — this re-validates the caller's stored default
     *     through the resolver's OWN 'empty'-form handling (e.g.
     *     IdentifierResolver::resolveProject()'s `$defaultProjectId ===
     *     null ? null : self::projectByColumn(...)`), the exact same
     *     OU-scoped re-validation EVERY OTHER defaultProjectIdFor() call
     *     site in this class applies (see rankTasks()'s own docblock: "a
     *     default that has since moved out of OU scope must not be
     *     honoured"). The first version of this fix passed $defaultValue
     *     straight through as this method's own return value, bypassing
     *     that re-validation entirely — not exploitable, since
     *     resolveStructural() re-applies tenant/OU scoping on the SECTION
     *     join regardless (a stale out-of-scope default still 404s), but it
     *     meant listGroups()/createGroup() were the only default-project
     *     consumers in this class NOT going through the shared re-validated
     *     path, and the docblock claiming otherwise was wrong.
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
     * the 'empty' (both with and without a default), 'malformed_short_id',
     * and "supplied" branches are exercised with a spy $resolver, verifying
     * the exact tuple this method passes through, without requiring a real
     * IdentifierResolver::resolveProject()/resolveSection() call — those
     * need PostgreSQL (OuScopeResolver::whereFragment()'s `= ANY(:scope)`
     * fails at PDO::prepare() under SQLite), which is exactly why this
     * composition logic had no coverage before this extraction.
     *
     * $resolver is IdentifierResolver::resolveProject() or ::resolveSection(),
     * passed as a first-class callable and invoked with no default/
     * grandparent argument for the "supplied" branch — that resolves exactly
     * one level up, never two. For the 'empty'+$defaultValue branch it is
     * invoked with a 5th argument instead; both production resolvers accept
     * one optionally (resolveProject()'s own $defaultProjectId;
     * resolveSection()'s own $projectId, which is simply null there since
     * updateSection()/deleteSection()/updateGroup()/deleteGroup() never pass
     * a $defaultValue) — a spy closure declaring only 4 parameters still
     * receives the call cleanly, PHP does not error on extra positional
     * arguments to a user-defined callable.
     *
     * $defaultValue (D1b Task 12b): listGroups()/createGroup() were the only
     * two section-consuming routes that passed NO parent to resolveSection()
     * at all — not even null-when-absent, which is what every OTHER caller
     * of this method already does — so a slug-form section_id could never
     * resolve on those two routes regardless of what project_id a caller
     * supplied. Restoring project_id (with the usual defaultProjectIdFor()
     * fallback other list/create routes already apply, e.g. listTasks())
     * fixes that: when project_id is genuinely absent, these two routes pass
     * the caller's resolved default project as the parent instead of null,
     * so a slug resolves even when the caller never named a project
     * explicitly — matching how "read my current project" already works
     * everywhere else in this class. Every other call site keeps passing no
     * 7th argument, so $defaultValue stays null for them, the resolver is
     * never called for the 'empty' form (short-circuits to {ok: true, value:
     * null} exactly as before this parameter existed), and this change is
     * behaviourally invisible there.
     *
     * @param callable(\PDO, int, ?int, string|int|null, ?int=): ?int $resolver
     * @return array{ok: bool, value: ?int}
     */
    private function resolveOptionalParentId(
        Request $request,
        \PDO $pdo,
        int $tenantId,
        ?int $callerOuId,
        string $key,
        callable $resolver,
        ?int $defaultValue = null
    ): array {
        $raw = $this->identifierFromRequest($request, $key);
        $form = IdentifierResolver::classify($raw);

        if ($form === 'malformed_short_id') {
            return ['ok' => false, 'value' => null];
        }

        if ($form === 'empty') {
            if ($defaultValue === null) {
                return ['ok' => true, 'value' => null];
            }

            return ['ok' => true, 'value' => $resolver($pdo, $tenantId, $callerOuId, $raw, $defaultValue)];
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
     * Resolve a destination identifier (section_id or group_id) from an
     * ALREADY-DECODED request body, tolerating every identifier FORM
     * (UUID/id/slug/prefix) rather than the plain `(int)` cast the
     * underlying handler methods themselves do on whatever they are handed.
     *
     * USED BY (D1b Task 12c): {@see self::moveTaskToGroup()}'s own
     * section_id AND group_id, both directly — group_id used to go through a
     * separate resolveGroupMembership() wrapper that collapsed 'absent' and
     * 'explicit_null' into one 'ungroup' outcome, correct back when
     * move_task_to_group existed SOLELY to set group membership; retired
     * once $sortOrder made a pure-reorder call (no group_id at all) a real
     * shape, since that collapse silently un-grouped every such call (review
     * round 1 finding — see moveToGroup()'s own docblock in TasksApiHandler
     * for the full reasoning). move_task's OWN section_id/group_id
     * resolution used to live here too, before Task 12c ported move_task to
     * the original's actual cross-project contract — that route resolves
     * target_section_id directly via IdentifierResolver::resolveSection()
     * now, with no "leave unchanged" concept to preserve (a cross-project
     * move has no "current" section to default to). See git history for
     * move_task's former usage here.
     *
     * Five outcomes, distinguished the same way resolveOptionalParentId()'s
     * three distinguish theirs — a bare `?int` cannot tell "absent" apart
     * from "explicitly null" apart from "supplied but did not resolve":
     *
     *   - status 'absent': the key is not in $decoded at all —
     *     moveToGroup()'s own section_id parameter must see null (its "leave
     *     unchanged" case), and its own group_id/$groupProvided pair must
     *     see $groupProvided = false (ALSO "leave unchanged" — see that
     *     method's own docblock for why this is new as of Task 12c).
     *   - status 'explicit_null': the key IS present with a literal null
     *     value — group_id's own "explicit null means un-group" (unchanged
     *     since D1b Task 9); section_id has no such meaning, but callers
     *     decide what to do with it (letting moveToGroup()'s own
     *     project-membership check reject it is enough — no separate
     *     handling needed here).
     *   - status 'malformed': present, a string/int, but classifies as
     *     malformed_short_id. Callers 400.
     *   - status 'unresolved': present, classifies as a real form, but
     *     $resolver found nothing (wrong tenant/OU, or genuinely absent).
     *     Callers 404 — distinct from moveToGroup()'s own 422 for "exists,
     *     but doesn't belong to the target project/section", which only
     *     triggers once a resolved id reaches moveToGroup() at all.
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
     * e.g. `{"task_id":"TDE-1","milestone_id":{"x":1}}` — reached what was
     * then a single `IdentifierResolver::resolveMilestone(..., string|int|null
     * $raw)` (since split into resolveMilestoneById()/resolveMilestoneByIndex()
     * — see their own docblocks) as a PHP array and threw an uncaught
     * TypeError instead of a controlled 400. `deleteMilestone()`, in the same
     * original commit, already read both
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
     *   - 'milestone_not_found': the task resolved, but neither resolver
     *     below found anything under it (wrong tenant, wrong task, an
     *     out-of-range index, or genuinely absent/non-scalar — see the
     *     TypeError note above: a non-scalar value is filtered out by
     *     identifierFromRequest() before it ever reaches classify() or
     *     either resolver, so it lands here rather than throwing).
     *     Callers 404.
     *   - 'resolved': the task resolved (and, unless $requireMilestone is
     *     false, so did the milestone within it).
     *
     * D1b Task 12b FIX: milestone_id and index used to be coalesced into one
     * `$rawMilestone` value and handed to a single id-first resolver that
     * fell back to positional resolution — see
     * {@see \Tasker\Access\IdentifierResolver::resolveMilestoneById()}'s own
     * docblock for why that made an original-shaped positional call mutate
     * the WRONG milestone whenever the ids happened to land in the low
     * integers. The two identifiers now resolve through two SEPARATE
     * methods with NO cross-fallback in either direction: milestone_id (when
     * present) resolves ONLY by id/UUID via resolveMilestoneById(); index
     * (only consulted when milestone_id is absent, preserving the original
     * `??` precedence) resolves ONLY positionally via
     * resolveMilestoneByIndex(). Neither ever consults the other's meaning.
     *
     * $taskResolver is injected — IdentifierResolver::resolveTask() in
     * production — for the same Reflection-testability reason
     * resolveOptionalParentId()/resolveMoveDestinationId()/
     * resolveCreateTaskSectionId() inject theirs: it calls
     * OuScopeResolver::whereFragment() unconditionally, which SQLite's
     * PDO::prepare() rejects outright. resolveMilestoneById()/
     * resolveMilestoneByIndex() are called directly, NOT injected — neither
     * carries any OU-scoping or Postgres-only syntax at all (plain
     * tenant/task-scoped SQL), so they run for real against a bare SQLite
     * fixture in this class's own tests, the same way
     * resolveCreateTaskSectionId() calls backlogSectionIdFor() directly
     * rather than injecting it.
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

        // milestone_id wins when both are supplied — the same precedence the
        // old coalesced `??` expression had — but each is now resolved by
        // its OWN method; there is no shared fallback path between them.
        $rawMilestoneId = $this->identifierFromRequest($request, 'milestone_id');
        $rawIndex       = $this->identifierFromRequest($request, 'index');
        $usingMilestoneId = $rawMilestoneId !== null;
        $rawMilestone = $usingMilestoneId ? $rawMilestoneId : $rawIndex;

        if (IdentifierResolver::classify($rawMilestone) === 'malformed_short_id') {
            return ['status' => 'malformed_milestone', 'taskId' => $taskId, 'milestoneId' => null];
        }

        $milestoneId = $usingMilestoneId
            ? IdentifierResolver::resolveMilestoneById($pdo, $tenantId, $taskId, $rawMilestone)
            : IdentifierResolver::resolveMilestoneByIndex($pdo, $tenantId, $taskId, $rawMilestone);
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
