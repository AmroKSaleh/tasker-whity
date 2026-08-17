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
 *   GAP       — the original can do something we cannot, on no principle at
 *               all: only scope. Distinguished from DEFERRED (which names a
 *               later slice) and from the deliberately-stricter entries that
 *               cite this plugin's own rules, because calling a plain gap
 *               "principled" is how a gap stops being looked at. D5a Task 10's
 *               get_flow_order is the one entry tagged this way.
 *   SEMANTIC  — the same call does something DIFFERENT here. These are the
 *               dangerous ones. There are SEVEN left: delete_environment
 *               reassigns behind a gate that 409s instead of moving anything,
 *               get_task no longer auto-starts a task, delete_group fails
 *               SAFE (un-groups instead of the destructive delete_tasks:true
 *               the original also offers), get_ready_work ignores the
 *               original's agent_ready gate entirely (WHOLE-BRANCH REVIEW
 *               I2 — see that entry below for why it carries no
 *               missing/extra property at all), D5a Task 8 added TWO
 *               more that are purely behavioural in the same way
 *               (set_task_input and remove_task_input both reset the human
 *               contract blessing on both ends of the edge they touch — and
 *               set_task_input, with replace: true, on every FURTHER producer
 *               it unwires as collateral, a cascade a later round widened
 *               past the literal "both ends" this legend used to claim —
 *               where the original resets neither task's), and D5a Task 9
 *               added derive_output_contract (a 422 where the original
 *               answers 200 and writes nothing either). D5a Task 12 added no
 *               EIGHTH entry: it added a SECOND proven divergence to each of
 *               the two edge tools' existing entries — the cycle refusal on
 *               set_task_input, the flow-order re-stamp on remove_task_input
 *               — which is why `provenBy` now takes a map (see below).
 *               set_task_input's entry is property-less like get_ready_work's;
 *               remove_task_input's is not, but only because it ALSO carries
 *               an unrelated, non-semantic `required` waiver of its own.
 *               move_task — the collision
 *               between the original's cross-project move and D1's
 *               within-project one — was FIXED in D1b Task 12c (a real
 *               port, not a waiver; see TasksApiHandler::moveToProject()),
 *               on top of delete_section and delete_project (both
 *               UNSAFE-direction: the identical call was a refusal on the
 *               original and irreversible data loss here) and the milestone
 *               `index` trio (WRONG-ROW: an id-first resolver silently
 *               mutated the wrong milestone) — both FIXED in D1b Task 12b.
 *               See git history for every closed entry.
 *
 * EVERY SEMANTIC ENTRY MUST CARRY `severity => 'semantic'` AND ONE OF
 * `dischargedBy` / `provenBy`, and the test enforces that. The two name a
 * behavioural test with OPPOSITE polarity, and picking the wrong key silently
 * disables the check (D5a Task 8, review round 1):
 *
 *   `dischargedBy` — for behaviour the original has and we have NOT ported.
 *                    Names the test that must exist BEFORE the entry may be
 *                    removed, so today it deliberately does NOT exist. All four
 *                    of the pre-D5a semantic entries are this kind.
 *   `provenBy`     — for a divergence we deliberately SHIPPED and intend to
 *                    keep. Names the test that PROVES it behaves as described,
 *                    so it must exist NOW — checked on every run, which is what
 *                    stops a rename from silently orphaning the entry.
 *                    set_task_input/remove_task_input's cascade entries are
 *                    this kind.
 *
 * `provenBy` TAKES EITHER ONE TEST NAME OR A MAP OF THEM (D5a Task 12). This
 * file is keyed by TOOL NAME, so a tool gets exactly one entry — but a tool
 * can ship more than one deliberate divergence, and both edge tools now do.
 * So a multi-divergence entry writes
 * `'provenBy' => ['cycle refusal' => 'testX', 'blessing cascade' => 'testY']`,
 * the label pairing each named test with the numbered divergence in the
 * entry's own `reason`. EVERY name in the map is checked for existence on
 * every run, so a tool with two proven divergences cannot end up with only one
 * of them backed by evidence; a bare LIST is refused rather than accepted,
 * because it cannot express that pairing and a reworded reason would then
 * silently decouple from the tests meant to prove it. See
 * OriginalContractParityTest::provenByTests() for both shapes and the
 * malformed-shape failure.
 *
 * The reason is an escape hatch found in review:
 * every SEMANTIC divergence used to be expressed as a `missing` property
 * (get_ready_work, added by WHOLE-BRANCH REVIEW I2, is the one exception —
 * see its own entry for why it names no property at all), so declaring that
 * property on the route schema would make the entry stale, force its
 * removal, and turn the build green — with the behaviour unchanged and now
 * MORE dangerous, because the caller believes the flag is honoured where today
 * it at least fails visibly as "not accepted" (core drops undeclared
 * arguments). So for a semantic entry the rule is inverted: declaring the
 * property FAILS unless the behavioural test the entry names actually exists in
 * the suite. Behaviour first, schema second.
 *
 * 25 entries waiving 75 individual divergences across the 42 shared tools.
 * D5a Task 5 ported name_flow/list_flows/delete_flow and added 3 new DEFERRED
 * entries for them (8 more divergences: 3 for name_flow, 2 for list_flows, 2
 * missing + 1 required for delete_flow) — 19 -> 22 entries, 56 -> 64
 * divergences, 36 -> 39 shared tools, semantic count unchanged at 4 (none of
 * the three are semantic). D5a Task 6 ported get_flow_context/
 * update_flow_context/build_new_flow and added 3 more DEFERRED entries (11
 * more divergences: 1 missing + 1 extra + 1 required for get_flow_context, 3
 * missing + 2 extra + 1 required for update_flow_context, 2 missing for
 * build_new_flow) — 22 -> 25 entries, 64 -> 75 divergences, 39 -> 42 shared
 * tools, semantic count unchanged at 4 (none of the three are semantic).
 * D5a Task 7 ported set_task_input/remove_task_input (the I/O edges
 * themselves) and added exactly ONE new entry, for remove_task_input's own
 * `required` divergence: source_task_id is optional on the original (its
 * absence means "remove every input edge") but REQUIRED here, since this
 * plugin's mutating-route rule forbids a mutation from ever resolving its
 * own target from a caller default and "every edge" is itself such a
 * default. set_task_input needed NO entry at all — its property set
 * (task_id, source_task_id, contract, expected_type, replace) and its
 * required list (task_id, source_task_id) both match the original
 * byte-for-byte. 25 -> 26 entries, 75 -> 76 divergences, 42 -> 43 shared
 * tools, semantic count unchanged at 4 (not semantic — see the entry itself
 * for why: the old shape 400s cleanly rather than silently doing something
 * different, the same reasoning delete_flow's own `required` entry above
 * already carries).
 * D5a Task 8 ported set_task_output/clear_task_output/confirm_contract (the
 * producer's own contract and the human blessing) and moved three numbers:
 * 26 -> 28 entries, 76 -> 79 divergences, 44 -> 47 shared tools, semantic 4
 * -> 6. (The Task 7 paragraph above says 43 shared tools; that figure was one
 * short — counted mechanically at this commit, our 60 operationIds intersect
 * the original's 143 in exactly 47 names, 13 of ours being additions the
 * original has no tool for at all. The three counts that the build actually
 * enforces — entries, divergences and semantic — were all correct.)
 * set_task_output and clear_task_output needed NO entry at all — both
 * property sets and both required lists match the original byte-for-byte.
 * confirm_contract is the ONE new shape divergence (3 missing properties, a
 * genuine capability gap fixed by the schema — see its own entry), and the
 * blessing CASCADE is the semantic pair: entries on set_task_input (new) and
 * remove_task_input (its existing entry, which gains severity/provenBy — this
 * line said `dischargedBy` until D5a Task 12 corrected it, a leftover of the
 * rename that introduced the two keys' opposite polarity in the first place),
 * neither of which waives any additional individual divergence, since both
 * tools' argument shapes still match the original exactly.
 * D5a Task 9 ported derive_output_contract and added ONE property-less
 * SEMANTIC entry for it (the 422 on an empty apply): 28 -> 29 entries, 6 -> 7
 * semantic, divergences unchanged at 79 — its argument shape matches the
 * original exactly. (Task 9 did not restate these totals here; they are
 * recounted mechanically at Task 10's commit, along with everything below.)
 * D5a Task 10 ported get_task_connections/get_flow_order/
 * recompute_flow_steps and added TWO entries (get_task_connections needs
 * none — its shape matches byte-for-byte): 29 -> 31 entries, 79 -> 84
 * divergences (2 for get_flow_order, 3 for recompute_flow_steps), 48 -> 51
 * shared tools, semantic unchanged at 7 — neither new entry is semantic, and
 * the two are deliberately NOT described as the same kind of divergence (one
 * is principled, one is an honest capability gap; see the section above them).
 * D5a Task 12 ported NOTHING and added NO entry: 31 entries, 84 divergences,
 * 51 shared tools and 7 semantic entries are all unchanged, and so are the
 * 64-tool surface and EXPECTED_UNPORTED_COUNT's 92. What it changed is what
 * two EXISTING entries record. It read the original's set_task_input/
 * remove_task_input/recompute_flow_steps source directly instead of reasoning
 * about them, and that reading moved three things: set_task_input gained a
 * second proven divergence (the cycle refusal); remove_task_input gained one
 * (the flow-order re-stamp on removal, which the original does not do);
 * recompute_flow_steps' own comment and reason were CORRECTED, because both
 * claimed a difference in necessity that is only half real. The plan's own
 * Task 12 brief asked for a third entry — "flow_step auto-recomputed, so
 * recompute_flow_steps is no longer required for correctness" — and that one
 * was REFUSED as a fabricated record: the original auto-recomputes too. See
 * the Task 7/8/12 section comment below for the evidence.
 *
 * D1b Task 12c closed move_task's SEMANTIC entry outright (a real port — see
 * moveTask()/moveToProject() — not a waiver) and opened one new ADDITIVE
 * entry for move_task_to_group's own sort_order (rehoming the reordering
 * capability move_task used to own, since the live original exposes no MCP
 * reordering tool at all) — a net-zero change in entry COUNT that still
 * shrank total divergences by 4. D1b Task 12b fixed four EARLIER routes
 * rather than waiving them — delete_section, delete_project, the milestone
 * `index` trio, and list_groups/create_group's missing project_id — closing
 * 4 entries outright (delete_section, delete_project, list_groups,
 * create_group) and dropping the milestone trio's severity from semantic to
 * a plain ADDITIVE remainder (milestone_id itself), on top of the earlier
 * add_milestone fix (also fixed rather than waived — see its entry). That
 * left 18 entries / 56 divergences / 3 semantic; WHOLE-BRANCH REVIEW I2 then
 * added get_ready_work as a 19th entry and 4th semantic one, waiving ZERO
 * additional individual divergences — its argument shape already matches
 * the original's exactly, so the 56 figure is unchanged even though the
 * entry count is not. 19 entries / 56 divergences / 4 semantic is current.
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
    //
    // move_task's own SEMANTIC entry (the collision between the original's
    // cross-project move and D1's within-project one) was CLOSED in D1b Task
    // 12c, not merely discharged: moveTask()/TasksApiHandler::moveToProject()
    // now implement the original's actual cross-project contract exactly
    // (task_id, target_project_id required, target_section_id optional —
    // matching original-tool-schemas.json's move_task property-for-property),
    // so there is no divergence left to waive. See git history for the
    // former entry, and TenantIsolationOuTest's own
    // testMoveTaskMovesATaskIntoADifferentProject() for the behavioural
    // proof. The reordering capability move_task used to own moved to
    // move_task_to_group's own new ADDITIVE entry below.

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

    'get_ready_work' => [
        // WHOLE-BRANCH REVIEW I2. SEMANTIC, and the odd one out in this file:
        // every OTHER semantic entry hangs off a `missing`/`extra` property so
        // OriginalContractParityTest's property-name diff has something to
        // waive. This one has NOTHING to hang on — get_ready_work's own
        // argument shape (just `project_id`, optional, on both sides) is
        // already byte-for-byte identical to the original's. The divergence
        // is entirely in what the ROUTE DOES with a call it accepts, not in
        // the call's shape: the original's ready queue is tasks that are BOTH
        // agent_ready AND pending — a human (or another agent) explicitly
        // hands a task to the agent, typically via update_task's own
        // agent_ready flag (see that tool's own DEFERRED entry above), before
        // it ever appears here. This backend has no agent_ready column at
        // all, so getReadyWork() ranks and returns EVERY non-done task,
        // silently widening what an autonomous caller believes it was
        // explicitly cleared to pick up.
        //
        // No `missing`/`extra`/`required`/enum key is set: there is no
        // property whose presence or absence would make this visible to
        // testEverySharedToolMatchesTheOriginalsArgumentShape(), so nothing
        // here can go stale the way the schema-hooked entries can. It exists
        // solely so the divergence is RECORDED — see this file's own opening
        // rule that an unlisted divergence fails the build precisely because
        // an entry is supposed to be the alternative to "invisible", not a
        // substitute for it. dischargedBy names the test that has to exist
        // BEFORE this entry may be removed: implementing the agent_ready gate
        // without that test landing first would be exactly the kind of
        // silent, unproven fix this file's staleness rule exists to catch on
        // every OTHER semantic entry, even though the mechanical stale-check
        // itself cannot enforce it here.
        'severity' => 'semantic',
        'dischargedBy' => 'testGetReadyWorkOnlyReturnsTasksMarkedAgentReady',
        'reason' => 'SEMANTIC: the original\'s ready queue is tasks that are agent_ready AND pending; a human (or '
            . 'another agent) must explicitly hand a task to the agent before get_ready_work surfaces it. This '
            . 'backend has no agent_ready column, so getReadyWork() ranks and returns every non-done task '
            . 'regardless, showing an autonomous caller strictly more work than the original ever would have. No '
            . 'missing/extra property is waived because get_ready_work\'s own argument shape already matches the '
            . 'original exactly (agent_ready lives on update_task\'s schema, not this route\'s) — the property-name '
            . 'diff this test performs cannot see a purely behavioural divergence, which is exactly why this entry '
            . 'exists.',
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

    'move_task_to_group' => [
        // ADDITIVE (D1b Task 12c): rehomes the reordering capability the
        // now-fixed move_task used to own. Verified directly against the
        // live original: it exposes NO reordering tool over MCP at all —
        // neither update_task nor move_task_to_group carries sort_order
        // there; the original's own drag-and-drop reordering is a web-UI
        // concern served over its own REST layer, not this MCP surface. So
        // porting move_task to its real cross-project contract would
        // otherwise silently DELETE a capability D2's own drag-and-drop
        // frontend needs. Optional; omitting it reproduces the original
        // exactly.
        'extra' => ['sort_order'],
        'reason' => 'ADDITIVE: the live original has NO MCP reordering tool at all (drag-and-drop is served over its '
            . 'own REST layer, not MCP) -- sort_order is rehomed here from the now-fixed move_task (D1b Task 12c) '
            . 'because D2\'s own drag-and-drop frontend needs a reordering call somewhere on this surface. Optional '
            . 'and additive.',
    ],

    // ── DEFERRED (continued, D5a Task 5) ─────────────────────────────────────
    //
    // name_flow/list_flows/delete_flow are D5a's first user-facing flow
    // tools. None of the three's divergences are semantic — every one is
    // either a capability this task's own brief scopes out (pagination,
    // custom short ids, alternate flow lookups) or a deliberately STRICTER
    // requirement this plugin's own mutating-route rule demands.

    'name_flow' => [
        // DEFERRED, both plain no-ops on the original:
        //  - short_id: a caller-chosen custom short id override. Not
        //    implemented — every flow's short_id is auto-generated via
        //    ShortIdAllocator, exactly like tasker_tasks already works, with
        //    no tool anywhere in this plugin letting a caller pin one.
        //  - bypass, bypass_reason: the original's OWN schema marks both
        //    "DEPRECATED — ignored, kept so older callers do not error" /
        //    "kept for backward compatibility". There is no behaviour to
        //    port for a flag the original itself no longer honours.
        //
        // ALSO RECORDED HERE, though it has no `missing`/`extra`/`required`
        // key to hang on (this test never compares TYPES, only property
        // names/required/enum — see testEverySharedToolMatchesTheOriginalsArgumentShape()'s
        // own docblock): `context` is a STRING on the original ("Optional
        // shared context ... background, goals, constraints, or instructions
        // that apply to all tasks in this flow") but an OBJECT here
        // (tasker_flows.context is JSONB, decided in D5a Task 2, not this
        // task). REVIEW FIX: this used to be silently unenforced -- any
        // non-array value (including the original's own string shape) was
        // simply discarded with no 400/422 at all. name_flow now calls the
        // same isJsonObject() guard update_project_context already uses and
        // 422s anything that is not a genuine JSON object, INCLUDING an
        // original-shaped string. We deliberately require an object where
        // the original takes a string, rather than accepting either: Task
        // 6's `context = context || :context::jsonb` merge (now implemented
        // on update_flow_context — see that entry below for the identical
        // note) needs an object on both sides of `||` to actually MERGE (a
        // jsonb array operand makes `||` APPEND instead, e.g.
        // `'[1,2]'::jsonb || '{"a":1}'::jsonb` = `[1, 2, {"a": 1}]`), so
        // accepting a bare string here would only push the same problem one
        // task down the line.
        'missing' => ['short_id', 'bypass', 'bypass_reason'],
        'reason' => 'DEFERRED: short_id (custom short id override) has no equivalent -- every flow\'s short_id is '
            . 'auto-generated via ShortIdAllocator, matching tasker_tasks. bypass/bypass_reason are DEPRECATED '
            . 'no-ops on the original itself ("ignored, kept so older callers do not error"), so there is no live '
            . 'behaviour to port. SEPARATELY (no missing/extra key applies -- this is a TYPE divergence, which the '
            . 'test does not compare): context is a free-text STRING on the original; we require a JSON OBJECT '
            . '(tasker_flows.context is jsonb, decided in D5a Task 2) and 422 anything else, including an '
            . 'original-shaped string -- an object is what the `context || :context::jsonb` merge (Task 6, also on '
            . 'update_flow_context) needs on both sides to actually merge rather than silently append.',
    ],

    'list_flows' => [
        // DEFERRED: pagination. Nothing in this plugin paginates yet —
        // list_tasks carries the identical gap (see its own DEFERRED entry
        // above) despite core shipping PaginationParams.
        'missing' => ['limit', 'cursor'],
        'reason' => 'DEFERRED: pagination (limit/cursor) is not implemented -- list() returns every visible flow '
            . 'unpaginated, the same gap list_tasks already carries despite core shipping PaginationParams. '
            . 'project_id being OPTIONAL here rather than required is us being MORE permissive than the original, '
            . 'which the parity test does not flag.',
    ],

    'delete_flow' => [
        // DEFERRED (alternate lookup forms) + a DELIBERATE stricter
        // requirement, not a gap:
        //  - task_id, project_id: the original resolves the flow via
        //    flow_id OR task_id (any member task), optionally narrowed by
        //    project_id for a partial flow-NAME match. None of that
        //    alternate-lookup machinery is ported — flow_id is the only
        //    way to address a flow here.
        //  - required: [flow_id]: the original marks flow_id optional
        //    (required: []) because it is only ONE of two alternative ways
        //    to identify the flow. We implement just the one, so it is
        //    unconditionally required here — and that is intentional, not
        //    an accident of narrower scope: this plugin's mutating-route
        //    rule forbids a delete route from ever falling back to a
        //    caller default for its OWN target (see
        //    SectionsApiHandler::delete()/ProjectsApiHandler::delete() for
        //    the same rule applied identically elsewhere), so an absent
        //    flow_id must 400, never silently resolve through some other
        //    field or a default.
        'missing' => ['task_id', 'project_id'],
        'required' => ['flow_id'],
        'reason' => 'DEFERRED: the original resolves a flow via flow_id OR task_id (any member task), optionally '
            . 'narrowed by project_id for a name-partial-match lookup -- none of that alternate-lookup machinery is '
            . 'ported, so flow_id is the only way to address a flow here. Making it REQUIRED is deliberate: this '
            . 'plugin\'s mutating-route rule (see delete_project/delete_section) forbids a delete route from ever '
            . 'resolving its own target from a caller default, so an absent flow_id 400s rather than falling back.',
    ],

    // ── DEFERRED (continued, D5a Task 6) ─────────────────────────────────────
    //
    // get_flow_context/update_flow_context/build_new_flow round out D5a's
    // first user-facing flow tools. Same shape as name_flow/list_flows/
    // delete_flow above: every divergence is either an out-of-scope
    // capability (the original's task_id-based alternate lookup, renaming,
    // a caller-chosen short_id, seeds, pagination-adjacent goal priming) or
    // this plugin's own stricter mutating-route rule. None are semantic.

    'get_flow_context' => [
        // DEFERRED: task_id is the original's ONLY way to address a flow
        // here ("any task in the flow") -- not ported, same as delete_flow's
        // own identical divergence. flow_id is REQUIRED (this route has no
        // "default flow" to fall back to, the same reason delete_flow's own
        // flow_id is unconditionally required).
        'missing' => ['task_id'],
        'extra' => ['flow_id'],
        'required' => ['flow_id'],
        'reason' => 'DEFERRED: the original addresses a flow via task_id ("any task in the flow"); that alternate '
            . 'lookup form is not ported, so flow_id is the only way to address a flow here -- same divergence '
            . 'delete_flow already carries. flow_id is REQUIRED for the same reason: there is no default-flow '
            . 'fallback anywhere in this plugin to fall back to.',
    ],

    'update_flow_context' => [
        // DEFERRED, three groups, plus a TYPE divergence with no
        // missing/extra/required key to hang on (same shape as name_flow's
        // own context note above):
        //  - task_id: same alternate-lookup gap as get_flow_context/
        //    delete_flow.
        //  - name, short_id: the original's update_flow_context ALSO renames
        //    the flow and lets a caller set/change its short_id. Neither is
        //    implemented -- this task's own brief scopes update_flow_context
        //    to context + step_list_open only.
        //  - flow_id (extra, required): same reasoning as get_flow_context.
        //  - replace (extra): ADDITIVE, matching update_project_context's
        //    own `replace` -- the original's update_flow_context always
        //    replaces wholesale ("New shared context (replaces existing)"),
        //    so `replace: true` reproduces that, and the default (merge) is
        //    our own, non-destructive addition.
        //
        // SEPARATELY (no missing/extra/required key applies -- this is a
        // TYPE divergence, which the parity test does not compare): context
        // is a free-text STRING on the original; we require a JSON OBJECT,
        // for the identical reason name_flow does (tasker_flows.context is
        // jsonb; `context || :context::jsonb` needs an object on both sides
        // to actually merge rather than silently append an array element).
        // Enforced via the SAME isJsonObject() 422 nameFlow()/
        // updateProjectContext() already use -- see
        // FlowsApiHandler::updateContext()'s own docblock.
        'missing' => ['task_id', 'name', 'short_id'],
        'extra' => ['flow_id', 'replace'],
        'required' => ['flow_id'],
        'reason' => 'DEFERRED: task_id is the same unported alternate lookup as get_flow_context/delete_flow; name '
            . '(renaming the flow) and short_id (a caller-chosen short id) are not implemented -- this task\'s brief '
            . 'scopes update_flow_context to context + step_list_open only. flow_id (extra, required) mirrors '
            . 'get_flow_context exactly. replace is ADDITIVE, matching update_project_context\'s own field: the '
            . 'original always replaces wholesale, so replace: true reproduces that and the merge default is our own '
            . 'non-destructive addition. SEPARATELY (a TYPE divergence the parity test cannot see): context is a '
            . 'free-text STRING on the original; we require a JSON OBJECT (tasker_flows.context is jsonb, decided in '
            . 'D5a Task 2) and 422 anything else via the SAME isJsonObject() check name_flow/update_project_context '
            . 'already use -- an object is what the `context || :context::jsonb` merge needs on both sides to '
            . 'actually merge rather than silently append.',
    ],

    'build_new_flow' => [
        // DEFERRED: seed_id resolves a flow SEED (resolve_seed et al. are
        // entirely unported, same gap create_task's own seed fields carry);
        // goal primes the interview with the end deliverable in the
        // caller's words, which this backend's static FlowBuildPlaybook does
        // not need pre-supplied -- the playbook itself is the priming.
        // project_id being OPTIONAL here (defaultProjectIdFor() fallback)
        // rather than required, unlike the original, is us being MORE
        // permissive, which the parity test does not flag (see list_flows'
        // own identical note).
        'missing' => ['goal', 'seed_id'],
        'reason' => 'DEFERRED: seed_id resolves a flow seed -- the whole seed family (resolve_seed et al.) is '
            . 'unported. goal primes the interview with the deliverable in the caller\'s own words; this backend '
            . 'returns a STATIC playbook (FlowBuildPlaybook) with no seed to prime against, so there is nothing for '
            . 'it to do yet. project_id being optional (vs. the original\'s required) is us being more permissive, '
            . 'which the parity test does not flag.',
    ],

    // ── D5a Tasks 7, 8 and 12: the edges, and what they invalidate ───────────
    //
    // set_task_input/remove_task_input wire and unwire the I/O edges
    // themselves. NEITHER diverges in SHAPE -- both property sets and both
    // required lists match the original, except remove_task_input's one
    // deliberate stricter requirement below. What they diverge in is
    // BEHAVIOUR, and each of them now carries TWO such divergences, which is
    // why both entries name their proving tests as a `provenBy` MAP: this
    // file gives a tool exactly one entry, so the second divergence had
    // nowhere to go until Task 12 widened the key (see the header, and
    // OriginalContractParityTest::provenByTests()).
    //
    // THE BLESSING CASCADE (Task 8): each of them resets the human contract
    // blessing on both ends of the edge it touches -- and set_task_input,
    // when `replace: true` deletes the consumer's OTHER inbound edges as
    // collateral, resets it on every producer it unwires that way too. This
    // comment used to say "BOTH ENDS" flatly; a later round widened the
    // cascade past that (see TaskEdgesApiHandler::setInput()'s own
    // $displacedProducerIds and testReplaceAllDropsTheOtherInboundEdges),
    // and the wording is corrected here rather than left to mislead.
    //
    // VERIFIED AGAINST THE ORIGINAL rather than assumed (D5a Task 8's own
    // Step 3 required it, because the spec chose the cascade on reasoning and
    // not on evidence). The original's set_task_input writes the CONSUMER's
    // `tasks.input` JSON column — resetting that EDGE's own
    // `contract.confirmed` flag, since it rewrites the whole edge object —
    // and never touches either task's `output.contract.confirmed`. Its
    // remove_task_input likewise rewrites only the consumer's `input`.
    //
    // (This paragraph said set_task_input writes that column "and nothing
    // else" until D5a Task 12 read the same function again for a different
    // reason: it also re-stamps `flow_step`, which does not affect the
    // blessing claim above — that function never touches either task's
    // `output` — but does affect two other records. See WHAT TASK 12 FOUND,
    // below.)
    //
    // So the original cascades to NEITHER end, and the spec's decision is a
    // real divergence in both directions:
    //
    //   - the PRODUCER (source) is un-blessed here, and is not there. A
    //     producer contract derived from its consumers' demands (which is
    //     exactly what derive_output_contract builds) is only as valid as the
    //     demands it came from.
    //   - the CONSUMER (target) is un-blessed here too, and is not there. The
    //     original does reset something on this side — the edge's own
    //     `confirmed` — but tasker_task_edges has NO blessing column (see
    //     confirm_contract's entry below), so the nearest thing this schema
    //     can reset is the consumer task's own flag, which is not the same
    //     field.
    //
    // Recorded as SEMANTIC on both tools, in the property-less shape
    // get_ready_work established above: there is no `missing`/`extra`/
    // `required` key to hang either on, because neither tool's ARGUMENT SHAPE
    // moved at all — the divergence is entirely in what an accepted call
    // DOES, which is the one class of divergence
    // testEverySharedToolMatchesTheOriginalsArgumentShape() structurally
    // cannot see, and therefore the one class most worth writing down.
    //
    // ── WHAT TASK 12 FOUND, READING THE ORIGINAL RATHER THAN THE PLAN ───────
    //
    // Task 12's brief prescribed three semantic records. One had already been
    // written (the blessing cascade, above). One is real and is added below
    // (the cycle refusal). The THIRD DOES NOT EXIST, and refusing to write it
    // is this task's main finding.
    //
    // THE FLOW-ORDER RE-STAMP IS NOT A DIVERGENCE ON set_task_input. The
    // brief asked for an entry reading "flow_step auto-recomputed, so
    // recompute_flow_steps is no longer required for correctness". Read
    // against the original's own source, that is false: the original's
    // set_task_input auto-recomputes too — index.ts:8387-8418, under its own
    // comment "Auto-recompute flow_step if either task belongs to a named
    // flow", right down to telling the caller so in its response ("Step order
    // auto-recomputed (N tasks renumbered)"). Our in-transaction re-stamp is
    // a FAITHFUL PORT of behaviour the original already had, and an entry
    // claiming otherwise would have been a fabricated record in the one file
    // whose entire value is that its records are true. NO ENTRY. Stated here
    // rather than left as an absence, so the next reader of this brief does
    // not re-derive it.
    //
    // IT IS A DIVERGENCE ON remove_task_input, which the same reading turned
    // up and the brief did not ask for. The original's remove_task_input
    // (index.ts:8715-8733) rewrites the consumer's `input` column and STOPS:
    // no recompute, no note, nothing. So on the original every edge REMOVAL
    // leaves flow_step describing a dependency that no longer exists, and
    // that stale order stands until somebody calls recompute_flow_steps.
    // Ours re-stamps in the same transaction as the delete. Recorded on
    // remove_task_input's own entry below, and it is also why
    // recompute_flow_steps' entry needed correcting rather than extending:
    // its claim that the hatch is "load-bearing on the original" is true of
    // removals and false of set_task_input, and it was written as a blanket.
    //
    // EDGE NORMALISATION NEEDS NO ENTRY, and that too is written down so
    // nobody adds a redundant one the staleness guard would then reject. D5a
    // Task 2 replaced the original's `tasks.input` jsonb array with the
    // normalised tasker_task_edges table, but `tasks.input` was never an
    // ARGUMENT of any tool — it was the column these two tools wrote — and
    // neither tool's argument shape moved: set_task_input still takes
    // {task_id, source_task_id, contract, expected_type, replace} and
    // remove_task_input still takes {task_id, source_task_id}. So the change
    // is invisible to a property-name/required/enum diff, and there is no
    // `missing`/`extra`/`required`/enum key it could hang on. Nor is it a
    // behavioural divergence needing the property-less shape: the observable
    // contract — "this task consumes that one, with this expected_type and
    // this contract" — is preserved exactly; only where it is stored moved.
    // Where normalisation DID cost something observable, that cost is already
    // recorded at the place it lands rather than here: the edge's own
    // `confirmed` flag has no column, which is why confirm_contract cannot
    // honour contract_type: "input" (its own entry) and why the blessing
    // cascade resets a task flag instead (above). An entry for the
    // normalisation itself would describe no divergence at all, and being
    // property-less it could only be a SEMANTIC one — which the guard would
    // then require a behavioural test to prove, for behaviour that does not
    // differ.
    //
    // ONE FURTHER RE-STAMP DIFFERENCE, RECORDED AND DELIBERATELY NOT ENTERED:
    // the re-stamp GATE. The original recomputes when EITHER endpoint is in a
    // flow (`task.flow_id || source.flow_id`, index.ts:8388) and then
    // force-adds the consumer into the member set it sorts
    // (`memberMap.set(task.id, freshTask)`, 8396) — so an edge into an
    // UNFLOWED consumer from a flowed producer stamps a flow_step onto a task
    // that belongs to no flow, and renumbers that flow's real members around
    // it. Ours gates on the consumer's own flow_id alone (see
    // TaskEdgesApiHandler's docblock for why that is the only flow a call
    // here can change the internal edge set of), so the same call stamps
    // nothing. NOT given an entry: no test pins that case, and this task will
    // not write one to justify a record — what the original does there
    // writes a step number onto a non-member, which is a defect rather than a
    // contract, and the entries in this file are for divergences we would
    // defend, not for bugs we declined to copy. Written down so the next
    // reader of these two gates does not have to re-derive it from index.ts.

    'set_task_input' => [
        'severity' => 'semantic',
        // provenBy, NOT dischargedBy (review round 1, Minor 2): the two keys
        // have opposite polarity. dischargedBy — what delete_environment,
        // get_task, delete_group and get_ready_work above all use — names a
        // test that must NOT exist yet, because it describes behaviour this
        // backend has not ported and has to land before the entry may be
        // removed. This divergence is the other kind: deliberately shipped, not
        // going anywhere, and the named test is the PROOF it behaves as
        // described. OriginalContractParityTest checks provenBy for existence
        // on every run, so renaming that test cannot silently orphan this
        // entry. See staleAllowlistEntries()'s own docblock.
        //
        // A MAP, not a single name (D5a Task 12): this tool ships TWO proven
        // divergences and gets one entry, and each label pairs its test with
        // the numbered divergence in `reason` below. Both are checked for
        // existence on every run.
        'provenBy' => [
            'blessing cascade' => 'testAConsumerEdgeWriteUnblessesTheProducerToo',
            'cycle refusal'    => 'testSetInputRefusesAnEdgeThatWouldCloseACycle',
        ],
        'reason' => 'SEMANTIC, TWO divergences, and NO missing/extra property is waived for either -- '
            . 'set_task_input\'s argument shape still matches the original exactly, which is precisely why this entry '
            . 'has to exist: the property-name diff cannot see a purely behavioural divergence. '
            . '(1) BLESSING CASCADE (D5a Task 8): wiring an input edge resets the human contract blessing '
            . '(output_contract_blessed) on the consumer AND the producer -- and, when replace: true deletes the '
            . 'consumer\'s other inbound edges as collateral, on every producer unwired that way too -- where the '
            . 'original resets neither task\'s output blessing (it rewrites the consumer\'s edge object, resetting '
            . 'that EDGE\'s own `confirmed` flag, a field this schema has no column for). Deliberate, per the spec\'s '
            . 'blast-radius decision: a producer contract derived from its consumers\' demands is only as valid as '
            . 'those demands, and a blessing that silently outlives a change to them is the exact failure the flag '
            . 'exists to prevent. '
            . '(2) CYCLE REFUSAL (D5a Task 12): an edge that would close a dependency cycle is refused with 422 and '
            . 'NOTHING is written, where the original writes it. Its set_task_input has no cycle check at all '
            . '(index.ts:8365-8424; the only edge it refuses is a self-loop, 8370, which we refuse too), and its own '
            . 'step sorter then absorbs the loop the call just created -- `if (stack.has(id)) return 0`, 8403 -- so '
            . 'the caller is handed a step order no dependency ordering justifies, over a graph that can no longer be '
            . 'ordered at all. We refuse the write instead, and over the whole I/O graph rather than one flow\'s '
            . 'members, so a cycle never reaches storage. Deliberately STRICTER than the original, and in the safe '
            . 'direction: the refused call 422s naming the cycle, so it is never mistaken for having succeeded.',
    ],

    'remove_task_input' => [
        // The original treats an ABSENT source_task_id as "remove every
        // input edge on task_id" -- a genuine capability (bulk removal) that
        // this backend does not implement: TaskEdgesApiHandler::removeInput()
        // takes a plain `int $sourceTaskId`, never a nullable/absent one.
        // This is NOT expressed as `missing` (a caller sending the original
        // shape is not silently ignored) -- it is `required`: an old-shaped
        // call (`{task_id}` alone) gets a clean 400 naming the missing field,
        // never a silent, different action. Same reasoning as delete_flow's
        // own `required => ['flow_id']` entry above: this plugin's
        // mutating-route rule forbids a mutation from ever resolving its own
        // target from a caller default, and "every input edge" is itself
        // such a default -- there is no way to honour the original's absent-
        // source_task_id form without guessing which edges the caller meant.
        //
        // ALSO SEMANTIC, TWICE OVER, on top of that `required` divergence and
        // independent of it:
        //
        //  - (D5a Task 8) removing an edge un-blesses BOTH of its ends, the
        //    same cascade set_task_input's entry above describes in full. This
        //    is the further of the two from the original, which deletes the
        //    edge (and with it the edge's own blessing) and leaves both tasks'
        //    output blessings standing.
        //  - (D5a Task 12) removing an edge also RE-STAMPS the owning flow's
        //    topological order, in the same transaction as the delete. The
        //    original's remove_task_input does not recompute at all -- unlike
        //    its OWN set_task_input, which does. See the section comment above
        //    for the source reading, and for why this is the only half of D5a's
        //    auto-recompute behaviour that is a divergence rather than a port.
        //
        // severity/provenBy are set for those two (the key is a MAP, one label
        // per divergence); the `required` waiver above is NOT semantic and
        // keeps its own reasoning (an old-shaped call 400s cleanly rather than
        // silently doing something different).
        'required' => ['source_task_id'],
        'severity' => 'semantic',
        // provenBy for the same reason set_task_input's entry uses it -- see
        // that entry's own comment on the two keys' opposite polarity.
        'provenBy' => [
            'blessing cascade' => 'testRemoveInputUnblessesBothEndsOfTheEdgeItRemoves',
            'flow-order re-stamp on removal' => 'testRemoveInputDeletesTheEdgeAndRestampsFlowOrder',
        ],
        'reason' => 'THREE divergences. (1) DEFERRED (deliberate, stricter requirement, not a silent gap): the original '
            . 'treats an absent source_task_id as "remove every input edge on task_id"; this plugin\'s mutating-route '
            . 'rule forbids a mutation from resolving its own target from a caller default, and "every edge" is itself '
            . 'such a default, so source_task_id is required here and an old-shaped call 400s cleanly instead of '
            . 'silently doing something different. Bulk removal (omit source_task_id) is not implemented. (2) SEMANTIC '
            . '(D5a Task 8): removing an edge resets the human contract blessing on BOTH ends of it, where the '
            . 'original leaves both tasks\' output blessings standing and only discards the edge\'s own confirmed flag '
            . 'along with the edge -- see set_task_input\'s entry above for the full reasoning and the verification '
            . 'against the original\'s source. (3) SEMANTIC (D5a Task 12): removing an edge ALSO re-stamps every '
            . 'member of the owning flow\'s flow_step, in the same transaction as the delete. The original\'s '
            . 'remove_task_input (index.ts:8715-8733) rewrites the consumer\'s `input` column and stops -- no '
            . 'recompute, no note -- even though its own set_task_input auto-recomputes (8387-8418). So on the '
            . 'original an edge removal leaves flow_step describing a dependency that no longer exists, standing until '
            . 'someone calls recompute_flow_steps; here that stale state cannot arise from a removal at all. This is '
            . 'the ONE half of D5a\'s auto-recompute behaviour that is a genuine divergence: the set_task_input half '
            . 'is a faithful port of what the original already did, and is deliberately NOT recorded as one.',
    ],

    // ── D5a Task 8: the producer's contract and the human blessing ───────────
    //
    // set_task_output and clear_task_output need NO entry, and that is worth
    // stating rather than leaving as an absence: set_task_output's properties
    // (task_id, contract) and required list (task_id, contract) match the
    // original byte-for-byte, and clear_task_output's (task_id, required
    // task_id) do too. Our `contract` property declares no nested rule schema
    // where the original declares a deep one -- this test compares neither
    // types nor nested shapes (see its own docblock), and set_task_input's own
    // ported `contract` already set that precedent in Task 7, so there is
    // nothing here to waive.
    //
    // The blessing CASCADE those two tools trigger is not recorded here either:
    // it belongs to the tools that DO the cascading, set_task_input and
    // remove_task_input, whose entries are above. set_task_output/
    // clear_task_output resetting their OWN task's blessing matches the
    // original (it overwrites the whole contract object, `confirmed: false` and
    // all -- see the original's own TDE-818 comment on that line), so that half
    // of the reset is a faithful port, not a divergence.
    //
    // WITH ONE CARVE-OUT, RECORDED HERE SO IT IS INHERITED RATHER THAN LOST
    // (review round 1, Minor 3 -- this comment used to claim the own-task reset
    // was "exactly" what the original does, which overclaimed): the original
    // does not destroy a human confirmation SILENTLY. Its set_task_output
    // (index.ts:8442-8459) writes a `contract_set` task event carrying
    // `erased_confirmation`, `prior_confirmed_by` and `prior_confirmed_at`
    // alongside a before/after contract snapshot, and warns the caller in the
    // response that "the blessing is now void ... preserved in the task's gate
    // history (get_task_history)"; clear_task_output (8743-8751) records the
    // same for the bar it clears. WE JUST FLIP THE BOOLEAN.
    //
    // Unimplementable in D5a for the identical reason confirm_contract's own
    // `confirmed_by` is (see its entry below): this plugin has no task-event /
    // activity / history table and no tool that reads one -- get_task_history,
    // get_task_activity and append_session_activity are all unported, and are
    // counted in the 96. It carries no `missing`/`extra` key because it is not
    // an ARGUMENT on any of these three tools; it is a side effect their calls
    // have on the original and do not have here, which is the same shape of
    // invisible-to-parity divergence get_ready_work's entry exists to record.
    // Deliberately NOT given its own semantic entry: the gap is one missing
    // FACILITY, identical across all three tools, so three entries would say
    // the same thing three times and none of them would be the place it gets
    // fixed. Whichever slice ports task events owns this, and the audit of a
    // voided human blessing is the highest-value event on the list.

    'confirm_contract' => [
        // DEFERRED, and all three are capability gaps fixed BY SCHEMA rather
        // than by choice:
        //  - contract_type: the original blesses either a task's OUTPUT
        //    contract or the contract on ONE INPUT EDGE ("output" | "input",
        //    default "output"). tasker_task_edges has NO blessing column at
        //    all -- D5a Task 2 fixed its columns as exactly id, public_id,
        //    tenant_id, source_task_id, target_task_id, expected_type,
        //    contract, created_at -- so there is nothing for the "input"
        //    branch to write to. Output-only here.
        //  - source_task_id: only meaningful WITH contract_type: "input" (it
        //    picks which edge, when a task has several). The original itself
        //    ignores it entirely for "output", so ignoring it costs nothing
        //    the "input" gap has not already cost.
        //  - confirmed_by: who confirmed it, default "human". tasker_tasks has
        //    no confirmed_by/confirmed_at pair; the blessing is one boolean
        //    (D5a Task 2). Ignoring it loses the ATTRIBUTION of a confirmation
        //    that did happen, never the identity of what was confirmed.
        //
        // NOT SEMANTIC, and specifically because contract_type is NOT silently
        // ignored the way an undeclared property normally is. Core forwards
        // every tool argument into the synthesized request (its
        // InputSchemaValidator enforces `required` only), so a caller asking to
        // bless an INPUT contract would otherwise have got the task's OUTPUT
        // contract blessed instead -- a wrong-row mutation on the
        // highest-trust act on this surface, and the same failure mode the
        // milestone `index` trio was FIXED for in D1b Task 12b rather than
        // waived. TaskerPlugin::confirmContract() therefore 400s any
        // contract_type that is not "output" (absent/empty still means
        // "output", exactly as on the original), which keeps this entry a
        // plain, visible capability gap: the old shape is refused, never
        // honoured as something else. See
        // testConfirmContractRoute400sOnAContractTypeItCannotHonour().
        'missing' => ['contract_type', 'source_task_id', 'confirmed_by'],
        'reason' => 'DEFERRED, three capability gaps fixed by SCHEMA and not by choice: contract_type\'s "input" '
            . 'branch blesses the contract on one input EDGE, and tasker_task_edges has no blessing column at all '
            . '(D5a Task 2 fixed its columns); source_task_id only selects which edge, so it is meaningless without '
            . 'that branch and the original itself ignores it for "output"; confirmed_by has no confirmed_by/'
            . 'confirmed_at columns to land in -- the blessing here is one boolean, so attribution is lost, never the '
            . 'identity of what was confirmed. NOT semantic, deliberately: contract_type is REFUSED with a 400 rather '
            . 'than silently treated as "output" (core forwards undeclared arguments into the request, so the silent '
            . 'path was real), because blessing the wrong contract is the wrong-row mutation class the milestone '
            . 'index trio was fixed for. Absent or empty still means "output", exactly as on the original.',
    ],

    // ── D5a Task 9: deriving a producer contract from its consumers ───────────
    //
    // derive_output_contract's ARGUMENT SHAPE matches the original exactly --
    // {task_id, apply}, required {task_id} -- so nothing here is waived on the
    // property diff, and the entry exists purely to record a behavioural
    // divergence the diff structurally cannot see. Same property-less shape
    // set_task_input/remove_task_input/get_ready_work use above.
    //
    // NOT RECORDED, because they are strictly LESS lossy than the original
    // rather than divergent in effect (see ContractDeriver's own docblock, which
    // carries the full comparison): our dedupe key is the whole rule where the
    // original's is `(r.rule || '').trim().toLowerCase()` -- a key that also
    // discards, silently and without an assumption, every rule whose prose is
    // still unwritten; and we emit no vagueness-lint assumptions, because
    // nothing in this plugin ports that linter at any authoring site yet, and a
    // second copy of its vocabulary applied ONLY to derived rules would be worse
    // than none. Neither can silently mis-persist anything: every difference
    // shows up in the draft the caller is handed for review.

    'derive_output_contract' => [
        'severity' => 'semantic',
        // provenBy, not dischargedBy -- see set_task_input's own entry above for
        // the two keys' opposite polarity. This divergence is deliberately
        // shipped, and the named test is the proof it behaves as described.
        'provenBy' => 'testDeriveOutputWithApplyRefuses422WhenThereIsNothingToDeriveAndChangesNothing',
        'reason' => 'SEMANTIC: apply: true with NOTHING to derive is REFUSED with a 422 naming the assumptions that '
            . 'explain why, where the original answers 200 with `applied: false` and no error at all (its own guard is '
            . '`if (args.apply && derived.rules.length)`, so it too persists nothing -- the divergence is the STATUS, '
            . 'not the write). Deliberate, and forced by this schema: the derived draft is stored as '
            . '`{"rules": [...]}`, so an empty derivation would store `{"rules": []}` -- a NON-EMPTY json object that '
            . 'sails past set_task_output\'s own 422 for an empty contract, leaving a bar that says nothing and which '
            . 'confirm_contract would then bless as one a human agreed to. The same accepted call with apply omitted '
            . 'still answers 200 with the empty draft and its assumptions, so nothing a READ could do is refused.',
    ],

    // ── D5a Task 10: the three reads, and the repair hatch ───────────────────
    //
    // get_task_connections / get_flow_order / recompute_flow_steps.
    // get_task_connections needs NO entry, and that is worth stating rather
    // than leaving as an absence: its property set (task_id) and its required
    // list (task_id) match the original byte-for-byte.
    //
    // The two entries below are NOT the same kind of divergence, and this task
    // deliberately refuses to describe them as though they were.
    // recompute_flow_steps' is PRINCIPLED (a mutation may not resolve its own
    // target from a caller default) with two precedents already in this file.
    // get_flow_order's is a genuine CAPABILITY GAP: it is a READ, so the
    // mutating-route rule does not reach it, and nothing else justifies
    // dropping what the original offers. Half of that gap was closed by
    // IMPLEMENTING the original's task_id form rather than waiving it (see
    // TaskerPlugin::getFlowOrder()); what is left is written down honestly
    // below.

    'get_flow_order' => [
        // CAPABILITY GAP (not principled, not semantic), plus the flow_id
        // addressing form this plugin uses everywhere else.
        //
        //  - project_id (missing): on the original this is the tool's REQUIRED
        //    argument and its bulk form -- "If omitted [task_id], returns all
        //    flows in the project". We answer for ONE flow per call and do not
        //    implement that project-wide listing at all. There is no principle
        //    behind that: it is scope. The capability is still reachable in two
        //    calls (list_flows enumerates a project's flows, then get_flow_order
        //    per flow), which makes it a bulk-read convenience gap rather than a
        //    lost capability -- but a gap it is, and it is recorded as one.
        //  - flow_id (extra): addressing a flow by its own id/UUID/short id,
        //    which is how every other flow tool here works (delete_flow,
        //    get_flow_context and update_flow_context all carry the identical
        //    `extra`). The original has no flow_id on THIS tool at all.
        //
        // THE ORIGINAL'S OTHER FORM IS PORTED, deliberately, and that is why
        // there is no `task_id` line above: "the order of the flow containing
        // this task" is a real capability, get_task does not expose flow_id, and
        // nothing else on this surface maps a task to its flow -- so dropping it
        // would have cost a caller something with nothing offered in return.
        // Implemented as FlowsApiHandler::orderForTask(); see
        // testOrderResolvesTheFlowFromAnyOfItsMemberTasks().
        //
        // NO `required` DIVERGENCE EXISTS: the original requires project_id and
        // we require neither of our two parameters (the ROUTE 400s when both are
        // absent, which is behaviour rather than schema). NOT semantic either --
        // an original-shaped call (project_id alone) has that argument dropped by
        // core and gets a clean 400 naming what is missing, never a silently
        // different answer for some other flow.
        'missing' => ['project_id'],
        'extra' => ['flow_id'],
        'reason' => 'CAPABILITY GAP, stated as one: project_id is the original\'s required argument AND its bulk form '
            . '("returns all flows in the project"), and we answer for exactly one flow per call -- no principle, just '
            . 'scope. Reachable in two calls (list_flows, then get_flow_order per flow), so it is a bulk-read '
            . 'convenience gap, not a lost capability. flow_id is EXTRA: addressing a flow by its own id is how every '
            . 'other flow tool here works (same extra delete_flow/get_flow_context/update_flow_context carry). The '
            . 'original\'s OTHER form, task_id ("focus on that task\'s specific flow"), is PORTED rather than waived '
            . '-- nothing else here maps a task to its flow, since get_task does not expose flow_id. This is NOT '
            . 'shielded by the mutating-route rule that covers delete_flow/remove_task_input/recompute_flow_steps: '
            . 'that rule constrains mutations and this is a read. Not semantic: an original-shaped call gets a clean '
            . '400, never a different flow\'s order.',
    ],

    'recompute_flow_steps' => [
        // DEFERRED (alternate lookup forms) + a DELIBERATE stricter
        // requirement -- byte-for-byte the same pair delete_flow's own entry
        // above carries, for the same two reasons:
        //  - task_id, project_id: the original resolves the flow from flow_id
        //    OR any member task OR a project-narrowed name/short-id lookup.
        //    None of that alternate-lookup machinery is ported.
        //  - required: [flow_id]: the original requires NOTHING AT ALL (its
        //    `required` list is literally empty), so a bare recompute_flow_steps
        //    picks its own target from the caller's context. This plugin's
        //    mutating-route rule forbids exactly that, and this call rewrites
        //    every member's flow_step -- guessing which flow to rewrite is the
        //    worst possible place to be helpful. An argument-less call 400s
        //    here, cleanly, naming flow_id.
        //
        // NOT SEMANTIC, and worth spelling out because a reader may expect it
        // to be: what the tool DOES when it is called is faithful (re-derive
        // the topological order from the flow's own I/O edges, re-stamp every
        // member). What differs is how often it is NEEDED. A tool that is
        // redundant is not a tool that behaves differently.
        //
        // CORRECTED IN D5a TASK 12, which read the original's source instead
        // of reasoning about it. This comment used to end "...so this hatch
        // normally finds nothing to repair, where on the original it is
        // load-bearing", which overstated the difference by half. The
        // original's OWN set_task_input already auto-recomputes flow_step
        // (index.ts:8387-8418, its own comment and its own response note
        // included), so after a set_task_input the hatch finds nothing to
        // repair THERE either. Where it really is load-bearing on the
        // original is after an edge REMOVAL: remove_task_input (8715-8733)
        // recomputes nothing at all, so the order it leaves is stale until
        // this tool is called. Ours re-stamps on removal too (recorded as a
        // divergence on remove_task_input's own entry above), which is what
        // closes that one genuine gap -- leaving this hatch to repair only
        // what no tool of ours caused: direct database edits, and orders
        // stamped before a fix landed.
        'missing' => ['task_id', 'project_id'],
        'required' => ['flow_id'],
        'reason' => 'DEFERRED + a deliberate stricter requirement, the same pair delete_flow carries. task_id (any '
            . 'member task) and project_id (narrowing a name/short-id lookup) are the original\'s alternate-lookup '
            . 'machinery, which is not ported -- flow_id is the only way to address a flow here. Making it REQUIRED is '
            . 'the principled half: the original requires NO argument at all, so it resolves its own target from the '
            . 'caller\'s context, and this plugin\'s mutating-route rule forbids a mutation from doing that (see '
            . 'delete_flow and remove_task_input for the same rule applied identically) -- especially one that '
            . 'rewrites every member\'s flow_step. An argument-less call 400s naming flow_id. NOT semantic: called '
            . 'with a flow_id it does exactly what the original does; only its NECESSITY differs, and by less than '
            . 'this entry first claimed -- D5a Task 12 read the original and found its own set_task_input '
            . 'auto-recomputes as well (index.ts:8387-8418), so the difference is confined to edge REMOVALS, which '
            . 'recompute nothing there and re-stamp here.',
    ],

];
