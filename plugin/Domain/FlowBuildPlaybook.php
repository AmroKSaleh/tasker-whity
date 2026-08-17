<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * The static interview playbook `build_new_flow` returns.
 *
 * A CONSTANT, deliberately, matching {@see DirectivePlaybook}'s own
 * reasoning: this is versioned content describing HOW to use name_flow/
 * update_flow_context correctly, and it must move in lockstep with those
 * tools rather than drift as a database row could.
 *
 * build_new_flow itself creates nothing (see TaskerPlugin::buildNewFlow()'s
 * own docblock) — it composes this static text with live project grounding
 * and returns both, exactly the shape SessionApiHandler::init() already
 * uses for __init_tasker_session (DirectivePlaybook::text() plus the
 * caller's own preferences row).
 *
 * Keep it short, matching DirectivePlaybook's own rule: a playbook nobody
 * finishes reading is not a playbook.
 */
final class FlowBuildPlaybook
{
    public static function text(): string
    {
        return <<<'TEXT'
        BUILDING A FLOW
        1. Gather every task the flow will contain. They must already exist
           and already belong to the target project.
        2. Wire the I/O edges between them BEFORE naming the flow — name_flow
           computes each task's step order from those edges, not from the
           order task_ids are listed in.
        3. Call name_flow with the project, a name, and every task_id. A task
           already in another flow is refused, not silently re-homed —
           delete_flow the other one first if you really mean to move it.
        4. Set step_list_open: true only when the full step count is
           genuinely unknown yet (research/investigation flows that discover
           their own next step). Flip it false once the extent is known.
        5. Use update_flow_context afterwards for shared background, goals or
           constraints that apply to every task in the flow — merge is the
           default and non-destructive; pass replace: true only to discard
           the existing context on purpose. An omitted context makes no
           change at all, even with replace: true — to actually clear it,
           you must pass context: {} explicitly alongside replace: true.
        TEXT;
    }
}
