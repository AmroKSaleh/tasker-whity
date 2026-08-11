<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * The directive playbook __init_tasker_session returns.
 *
 * A CONSTANT, deliberately, not a database row: this is versioned content
 * that must move in lockstep with the code whose behaviour it describes. A
 * row would let the two drift, and a playbook describing behaviour the code
 * no longer has is worse than none.
 *
 * Keep it short. The original's playbook grew to thousands of words, and a
 * directive nobody finishes reading is not a directive.
 */
final class DirectivePlaybook
{
    public static function text(): string
    {
        return <<<'TEXT'
        TASK LIFECYCLE
        Set a task to in_progress when you start it. Mark it done only when the
        work is genuinely and verifiably complete — otherwise leave it
        in_progress and say what remains.

        DURABLE WORK BELONGS HERE
        If a piece of work should outlive this session, or a human wants it
        persisted, reviewed or shared, create it as a task. Keep transient
        per-step notes in your own scratchpad — mirroring those here is noise.

        IDENTIFIERS
        Every tool accepting an id also accepts a UUID, a short id (TDE-31), a
        project prefix (TDE) or a slug. Omit project_id entirely to use your
        default project. Prefer stable ids over positional indexes.

        VERIFY BEFORE COMPLETE
        When a task's deliverable is checkable — a file, a passing test, a
        live endpoint — run the check and record what you observed. Never
        assert that something passed.
        TEXT;
    }
}
