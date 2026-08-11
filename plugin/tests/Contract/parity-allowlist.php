<?php

declare(strict_types=1);

/**
 * Deliberate divergences from the ORIGINAL app's tool contract.
 *
 * Every entry needs a reason, and OriginalContractParityTest enforces that
 * mechanically: an entry with no `reason`, or one describing a divergence that
 * no longer exists, fails the build. An empty allowlist is the goal. Entries are
 * debts, not decoration.
 *
 * Built from the first real run of the parity test (28 failures across 20 of the
 * 36 tools both surfaces share), NOT written in advance. Each reason below says
 * either why the divergence is correct or which later slice owns it.
 *
 * The reasons are tagged so the list can be read at a glance:
 *
 *   ADDITIVE  — we accept something extra and optional. The original's exact
 *               call still works and still means the same thing. Cheap.
 *   DEFERRED  — the original has it, we do not, and a named later slice owns it.
 *               A caller sending it gets it SILENTLY IGNORED, not rejected —
 *               core's InputSchemaValidator only enforces `required`, so
 *               undeclared arguments pass straight through and vanish.
 *   SEMANTIC  — the same call does something DIFFERENT here. These are the
 *               dangerous ones. There are FOUR left: move_task is a silent
 *               no-op on a cross-project move, delete_environment reassigns
 *               behind a gate that 409s instead of moving anything, get_task
 *               no longer auto-starts a task, and delete_group fails SAFE
 *               (un-groups instead of the destructive delete_tasks:true the
 *               original also offers). The five most dangerous entries this
 *               file used to carry — delete_section and delete_project (both
 *               UNSAFE-direction: the identical call was a refusal on the
 *               original and irreversible data loss here) and the milestone
 *               `index` trio (WRONG-ROW: an id-first resolver silently
 *               mutated the wrong milestone) — were FIXED in D1b Task 12b,
 *               not merely allowlisted. See git history for their entries.
 *
 * EVERY SEMANTIC ENTRY MUST CARRY `severity => 'semantic'` AND `dischargedBy`,
 * and the test enforces both. The reason is an escape hatch found in review:
 * every SEMANTIC divergence here is expressed as a `missing` property, so
 * declaring that property on the route schema would make the entry stale, force
 * its removal, and turn the build green — with the behaviour unchanged and now
 * MORE dangerous, because the caller believes the flag is honoured where today
 * it at least fails visibly as "not accepted" (core drops undeclared
 * arguments). So for a semantic entry the rule is inverted: declaring the
 * property FAILS unless the behavioural test named in `dischargedBy` actually
 * exists in the suite. Behaviour first, schema second.
 *
 * 18 entries waiving 60 individual divergences across the 36 shared tools, after
 * D1b Task 12b fixed four routes rather than waiving them — delete_section,
 * delete_project, the milestone `index` trio, and list_groups/create_group's
 * missing project_id — closing 4 entries outright (delete_section,
 * delete_project, list_groups, create_group) and dropping the milestone
 * trio's severity from semantic to a plain ADDITIVE remainder (milestone_id
 * itself), on top of the earlier add_milestone fix (also fixed rather than
 * waived — see its entry).
 *
 * Divergence keys:
 *   missing      — property the original accepts and we do not
 *   extra        — property we accept and the original does not
 *   required     — property we require that the original does not
 *   enumMissing  — enum value the original accepts and we reject
 *   enumExtra    — enum value we accept and the original does not
 */
return [

    // ── SEMANTIC ─────────────────────────────────────────────────────────────

    'move_task' => [
        // SEMANTIC COLLISION, and not a shape gap at all: the two tools share a
        // name and do different things. The ORIGINAL's move_task moves a task to
        // a DIFFERENT PROJECT — target_project_id is required. D1's move_task
        // relocates and reorders a task WITHIN its own project; the original's
        // nearest equivalent to that is move_task_to_group, which we also have.
        // So move_task({task_id, target_project_id:'ABC'}) — a perfectly valid
        // original call — is accepted here, ignored, and answered 200: a silent
        // no-op on a cross-project move. Not closable by adding properties:
        // short ids are project-prefixed and OU scope travels with the project,
        // so a real cross-project move is a port, not a parameter. UNOWNED.
        'missing' => ['target_project_id', 'target_section_id'],
        // ADDITIVE relative to the original's move_task_to_group, which carries
        // group_id and section_id; sort_order is ours (explicit board ordering).
        'extra' => ['section_id', 'group_id', 'sort_order'],
        'severity' => 'semantic',
        'dischargedBy' => 'testMoveTaskMovesATaskIntoADifferentProject',
        'reason' => 'SEMANTIC: the original move_task is a cross-project move (target_project_id required); ours is '
            . 'within-project relocation/reordering. A cross-project call silently no-ops with a 200. Needs a real '
            . 'port, not a property — short ids are project-prefixed and OU scope travels with the project. Unowned.',
    ],

    'delete_environment' => [
        // SEMANTIC, both properties, in opposite directions.
        //  - reassign_to_id: the original DELETES the Environment and MOVES its
        //    projects into another one. This alias delegates to core's OU delete
        //    (Task 10), which REFUSES with 409 while the OU still has children or
        //    members — so there is nothing to reassign, and a caller asking for
        //    the move gets a 409 instead.
        //  - confirmed: the original's destructive-confirm gate. No gate here;
        //    core's own 409 refusal is the only guard, which does at least make
        //    the accidental-destruction case the gate protects impossible.
        'missing' => ['reassign_to_id', 'confirmed'],
        'severity' => 'semantic',
        'dischargedBy' => 'testDeleteEnvironmentReassignsItsProjectsBehindAConfirmedGate',
        'reason' => 'SEMANTIC: the original deletes an Environment and reassigns its projects behind a confirmed '
            . 'gate; this alias passes through to core OU delete, which 409s while the OU is non-empty. Owned by the '
            . 'Environment-semantics reconciliation flagged for D2.',
    ],

    'get_task' => [
        // SEMANTIC (peek) + DEFERRED (refresh_context).
        //  - peek: the original's get_task SIDE-EFFECTS — it flips the task to
        //    in_progress unless peek:true. Ours is a pure read, i.e. it always
        //    behaves as though peek:true were passed. A caller sending peek:true
        //    gets exactly what it asked for; a caller relying on the implicit
        //    start does not. Deliberate: no read route in this plugin writes.
        //  - refresh_context: re-inlines the project Foundation, Instruction Set
        //    and KB index. The IS and KB do not exist here at all (get_project_is,
        //    get_knowledge_base and their whole family are unported), so there is
        //    nothing to refresh.
        'missing' => ['peek', 'refresh_context'],
        'severity' => 'semantic',
        'dischargedBy' => 'testGetTaskStartsTheTaskUnlessPeekIsTrue',
        'reason' => 'SEMANTIC: the original get_task auto-starts the task unless peek:true; ours is always a pure '
            . 'read, so it behaves as if peek were always on. refresh_context is DEFERRED — the Instruction Set and '
            . 'KB it re-inlines are entirely unported.',
    ],

    'delete_group' => [
        // SEMANTIC but FAIL-SAFE: ours always un-groups the tasks and never
        // deletes them — which is exactly the original's DEFAULT. A caller
        // passing delete_tasks:true gets un-grouping instead: their tasks survive
        // when they asked for destruction. Wrong, but in the safe direction.
        'missing' => ['delete_tasks'],
        // ADDITIVE: ours accepts a group SLUG, which needs its parent section to
        // disambiguate (Task 5). The original only takes UUIDs.
        'extra' => ['section_id'],
        'severity' => 'semantic',
        'dischargedBy' => 'testDeleteGroupDeletesItsTasksWhenDeleteTasksIsTrue',
        'reason' => 'SEMANTIC/fail-safe: we implement the original\'s DEFAULT (un-group) and omit its destructive '
            . 'delete_tasks:true option, so that flag is silently ignored and tasks survive. section_id is ADDITIVE '
            . 'for slug disambiguation, which the original cannot do.',
    ],

    // ── DEFERRED ─────────────────────────────────────────────────────────────

    'create_task' => [
        // DEFERRED, in four groups:
        //  - kind, seed_target, open_questions → the original's SEED tasks. None
        //    of the seed tools (resolve_seed et al.) are ported, so the flags
        //    would have nothing to act on. D5/D7.
        //  - executor, human_guidance, relay_context → the guide/relay layer
        //    (guide_flow, advance_guide). Unported. D5.
        //  - milestones → inline milestone creation. The milestone TOOLS are
        //    ported, so this is a convenience gap, not a capability gap.
        //  - tags → tag_task exists; attaching at creation does not.
        //  - allow_duplicate → there is no duplicate detection here to override
        //    (merge_task_as_duplicate is unported).
        'missing' => [
            'kind', 'seed_target', 'open_questions', 'milestones', 'executor',
            'human_guidance', 'relay_context', 'allow_duplicate', 'tags',
        ],
        'reason' => 'DEFERRED: flow/seed (kind, seed_target, open_questions) and guide/relay (executor, '
            . 'human_guidance, relay_context) fields belong to D5/D7 and have no backing columns here; milestones '
            . 'and tags are convenience gaps over ported capabilities (add_milestone, tag_task); allow_duplicate has '
            . 'no duplicate detection to override. All are silently ignored rather than rejected.',
    ],

    'update_task' => [
        // DEFERRED, and already ledgered as a D2 carry-over during Task 11:
        // "update_task in the original also carries agent_ready, current_state,
        // delegated_to, executor, human_guidance, relay_context, tags,
        // agent_proposal, agent_proposal_confirmed, append ... None exist here."
        //
        // Four of these are worth separating out because they are NOT missing
        // capability, only missing from THIS tool: section_id, group_id, pinned
        // and tags are all implemented here as separate tools (move_task,
        // move_task_to_group, pin_task/unpin_task, tag_task). So an agent that
        // pins via update_task({task_id, pinned:true}) gets a silent no-op even
        // though pinning works — the worst shape of DEFERRED, because the
        // capability is right there under another name.
        //
        // The rest have no backing columns at all. agent_ready is tied to the
        // already-ledgered get_ready_work parity gap (the original's ready queue
        // is "agent_ready + pending"; D1 ranks by priority with no such concept).
        'missing' => [
            'append', 'section_id', 'group_id', 'pinned', 'executor', 'human_guidance',
            'relay_context', 'delegated_to', 'agent_ready', 'agent_proposal',
            'agent_proposal_confirmed', 'tags', 'current_state',
        ],
        // ADDITIVE: our priority is nullable and the enum carries a literal null
        // so a caller can CLEAR it. The original's enum has no clearing form.
        // Every value the original accepts is still accepted.
        'enumExtra' => ['priority' => [null]],
        'reason' => 'DEFERRED (D2 carry-over, ledgered in Task 11). section_id/group_id/pinned/tags exist here as '
            . 'SEPARATE tools (move_task, move_task_to_group, pin_task/unpin_task, tag_task), so update_task calls '
            . 'using them silently no-op; the rest (append, executor, human_guidance, relay_context, delegated_to, '
            . 'agent_ready, agent_proposal, agent_proposal_confirmed, current_state) have no backing columns. '
            . 'agent_ready is tied to the ledgered get_ready_work gap. The priority enum\'s extra null is ADDITIVE — '
            . 'it is how this backend clears the field.',
    ],

    'list_tasks' => [
        // DEFERRED. This entry grew from 2 waived properties to 10 after review:
        // the reviewer compared the snapshot against the LIVE server for all 36
        // shared tools (not just the 5 sampled here) and found list_tasks alone
        // short by 8 — flow_id, gate_status, blocking, phase_id, cursor, limit,
        // sort, updated_since. Faithful to index.ts, so source staleness rather
        // than an extraction bug; the 8 are now in the generator's live-oracle
        // table as NAMES ONLY, since no shape was captured for them.
        //
        //  - confirmed: the original's all-projects gate. Ours resolves the
        //    caller's default project and 404s when there is none — there is no
        //    all-projects mode to gate. rank_tasks DOES carry this gate (Task 11),
        //    so the pattern exists here and this is a gap, not a decision.
        //  - include_flow_steps, flow_id, gate_status, blocking: flows, flow
        //    steps and quality gates do not exist here at all. D5.
        //  - phase_id: phases post-date index.ts entirely — the whole six-tool
        //    phases family is in liveOnlyToolNames. Unported, unowned.
        //  - cursor, limit, sort, updated_since: pagination, ordering and
        //    incremental sync. Nothing here paginates list_tasks; core ships
        //    PaginationParams, so this is a gap rather than a design choice, and
        //    it is the one group in this entry that a caller notices as a real
        //    functional loss on a large project.
        'missing' => [
            'confirmed', 'include_flow_steps', 'flow_id', 'gate_status', 'blocking',
            'phase_id', 'cursor', 'limit', 'sort', 'updated_since',
        ],
        // ADDITIVE filter, matching the group tools D1 ported.
        'extra' => ['group_id'],
        'reason' => 'DEFERRED, 10 properties: confirmed gates an all-projects listing this route does not implement '
            . '(rank_tasks already carries the same gate, so this is a gap and not a decision); include_flow_steps, '
            . 'flow_id, gate_status and blocking are the flow/gate layer (D5); phase_id belongs to the phases family '
            . 'that post-dates the snapshot entirely; cursor, limit, sort and updated_since are pagination, ordering '
            . 'and incremental sync, which nothing here implements despite core shipping PaginationParams — the one '
            . 'group a caller feels as real functional loss on a large project. group_id is an ADDITIVE filter over '
            . 'groups, which D1 did port.',
    ],

    '__init_tasker_session' => [
        // DEFERRED. The original's session init can re-show the preferences
        // questionnaire on demand. D1's returns preferences plus the directive
        // playbook and has no questionnaire to re-show — tasker_user_prefs stores
        // only the default project. Ignoring the flag gives the same result as
        // the original with the flag absent.
        'missing' => ['show_questionnaire'],
        'reason' => 'DEFERRED: there is no preferences questionnaire in D1 (tasker_user_prefs holds only the default '
            . 'project), so there is nothing to re-show. Owned by whichever slice ports the questionnaire.',
    ],

    // ── ADDITIVE ─────────────────────────────────────────────────────────────

    'add_milestone' => [
        // The `text` half of this divergence was FIXED, not allowlisted: it was
        // the only hard break the parity test found (we REQUIRED `summary`, so
        // core's InputSchemaValidator rejected every original-shaped call before
        // the handler ran). See MilestonesApiHandler::create(). What is left:
        //  - summary: ADDITIVE alias of text. It is this backend's column name,
        //    its response field, and update_milestone's own argument, so dropping
        //    it would trade one incompatibility for another.
        //  - sort_order: ADDITIVE. tasker_milestones has a real sort_order column,
        //    so a milestone can be placed rather than only appended; the
        //    original's jsonb array had position implied by insertion order.
        'extra' => ['summary', 'sort_order'],
        'reason' => 'ADDITIVE: summary is the accepted alias of the original\'s `text` (which add_milestone now takes '
            . '— that half was fixed, not waived) and is this backend\'s own column/response/update_milestone name; '
            . 'sort_order places a milestone explicitly, which the original\'s jsonb array could not.',
    ],

    // The milestone `index` trio (complete_milestone/uncomplete_milestone/
    // delete_milestone) used to carry SEMANTIC/WRONG-ROW entries here: the
    // original addresses milestones POSITIONALLY (index, 0-based, required),
    // but IdentifierResolver::resolveMilestone() resolved an integer ID-FIRST
    // and only fell back to the ordinal list when no milestone with that
    // primary key belonged to the task — so an original-shaped positional
    // call silently completed/reopened/DELETED the wrong milestone whenever
    // ids landed in the low integers. D1b Task 12b fixed this by splitting
    // resolution into IdentifierResolver::resolveMilestoneById() (id/UUID
    // only) and ::resolveMilestoneByIndex() (position only, 0-based, matching
    // the original), with NO cross-fallback in either direction — see
    // testCompleteMilestoneTreatsIndexAsAPositionNotAnId()/
    // testUncompleteMilestoneTreatsIndexAsAPositionNotAnId()/
    // testDeleteMilestoneTreatsIndexAsAPositionNotAnId() in TaskerPluginTest
    // for the behavioural proof (each constructs the exact id/position
    // collision the old resolver got wrong). What is LEFT below is the
    // ordinary ADDITIVE remainder: milestone_id itself is not on the
    // original's surface at all (it only ever had `index`), which is a
    // plain extra-property divergence, not a divergence in MEANING, so none
    // of these three carry `severity`/`dischargedBy` any more.

    'complete_milestone' => [
        'extra' => ['milestone_id'],
        'reason' => 'ADDITIVE: milestone_id is the unambiguous, non-positional way to address a milestone; the '
            . 'original only ever had `index`. (The WRONG-ROW resolution bug this entry used to describe was fixed '
            . 'in D1b Task 12b, not merely allowlisted — see git history.)',
    ],

    'uncomplete_milestone' => [
        'extra' => ['milestone_id'],
        'reason' => 'ADDITIVE, same as complete_milestone: milestone_id has no original counterpart.',
    ],

    'delete_milestone' => [
        'extra' => ['milestone_id'],
        'reason' => 'ADDITIVE, same as complete_milestone: milestone_id has no original counterpart.',
    ],

    // ── ADDITIVE (continued) ─────────────────────────────────────────────────

    'create_environment' => [
        // The plugin AUTHORS this request schema itself (TaskerPlugin.php:201-209)
        // — it is not obliged to forward every field core's OU create accepts, so
        // "cannot drop them" would overstate it. Keeping them is a choice: the
        // route is an alias, and narrowing it would make the alias lie about the
        // endpoint it fronts.
        'extra' => ['parent_id', 'description'],
        'reason' => 'ADDITIVE, inherited from the host: Environments are a thin alias over core\'s organizational '
            . 'units (Task 10), which are HIERARCHICAL and carry a description, while the original\'s Environments '
            . 'are flat and name-only. These are core\'s own OU fields forwarded deliberately — the plugin authors '
            . 'this schema (TaskerPlugin.php:201-209) and COULD narrow it, but narrowing would make the alias '
            . 'advertise less than the endpoint it fronts actually accepts. Reconciling the two models is flagged for D2.',
    ],

    'rename_environment' => [
        'extra' => ['description', 'parent_id'],
        'reason' => 'ADDITIVE, same as create_environment: core\'s OU update accepts a description and a new parent, '
            . 'and this alias passes core\'s own contract through unchanged.',
    ],

    'create_project' => [
        'extra' => ['prefix'],
        'reason' => 'ADDITIVE: the original exposes prefix on update_project but not at creation, deriving it from '
            . 'the name. D1 reproduces that derivation (PrefixDeriver, Task 2) and additionally lets a caller pin the '
            . 'prefix up front instead of create-then-update. Omitting it reproduces the original exactly.',
    ],

    'update_project' => [
        'extra' => ['environment_id', 'sort_order'],
        'reason' => 'ADDITIVE: environment_id moves a project between Environments — the original has no tool that '
            . 'moves a project at all — and sort_order is board ordering. Both optional.',
    ],

    'update_project_context' => [
        'extra' => ['replace'],
        'reason' => 'ADDITIVE: the original always merges into the existing Foundation. Task 9 added replace:true for '
            . 'wholesale replacement; it defaults to false, so omitting it reproduces the original exactly.',
    ],

    // listGroups()/createGroup() used to carry ADDITIVE-INVERSE entries here
    // (project_id waived as `missing`): they were the only two
    // section-consuming routes that called IdentifierResolver::resolveSection()
    // with NO parent id at all, so a slug-form section_id could never resolve
    // on either regardless of what a caller supplied, and their descriptions
    // were correctly amended to stop advertising a path that could not
    // execute. D1b Task 12b restored project_id to both (with the usual
    // defaultProjectIdFor() fallback) and passed it through to
    // resolveSection() as the slug's parent — see
    // testListGroupsAndCreateGroupResolveASectionSlugWhenProjectIdIsSupplied()
    // in TenantIsolationOuTest for the behavioural proof. Both routes' shapes
    // now match the original's exactly (project_id + section_id [+ name]),
    // so neither needs an entry any more.

    'rename_group' => [
        'extra' => ['section_id'],
        'reason' => 'ADDITIVE: ours accepts a group SLUG, which needs its parent section to disambiguate (Task 5). '
            . 'The original only takes UUIDs and so needs no parent.',
    ],
];
