# MCP: Project Foundation + bootstrap_project (TDE-262)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Project bootstrapping shipped as a **Foundation** flow, mirroring `build_new_flow`.

**Storage decision: reuse `projects.context` jsonb — NO new table/column.** Tasker already had a context object + inspector panel (ContextPoints) + create_project accepting context. The Foundation is just an extended context schema, so we extended it rather than add a parallel `foundation` column (avoids context-vs-foundation duplication).

**Hybrid schema (fixed core + flexible rest):**
- CORE (always): goal, why, scope (incl. what's OUT), definition_of_done, failure, quality_bar, assumptions.
- EXTENDED: audience, success_metrics, constraints, risks, ai_behavior.
- FLEXIBLE: any extra context keys the agent adds per project type (content→voice/themes, SaaS→features). ContextPoints renders unknown keys as "flexible" cards via KNOWN_KEYS check.

**New tool `bootstrap_project`** (call BEFORE create_project): returns a `run_foundation_interview` playbook — distill the prior conversation first, react-to-a-draft (never blank asks), dependency-ordered grill-me (why→scope→success→failure→metrics/quality), challenge weak/unrealistic input, ask only load-bearing gaps, mark inferred-vs-only-user-knows, persist on ONE ratification via create_project(name, context). Added matching ASSISTANT_DIRECTIVE + create_project description nudge.

**KEY: get_task now injects "# Project Foundation"** (renderFoundation helper) on every task — previously get_task injected IS + KB index but NOT project context, so tasks weren't grounded by intent/success/failure. This is the payoff.

**Gotcha found:** legacy key mismatch — MCP create_project doc said `done_looks_like` but the UI (ContextPoints) writes `definition_of_done`. renderFoundation maps BOTH to "Success looks like" (done_looks_like kept as legacy alias). Use `definition_of_done` going forward.

**Design rationale (why this shape):** interview-as-human-questionnaire was rejected — users don't know what they don't know (trash in = trash out), and creation is when they have least context. So the agent is the EXPERT (advisor, not stenographer/interrogator); the human is the decision-maker reacting to drafts. Foundation is a living first-draft, deepened as work exposes unknowns; weak output should be attributed back to thin grounding to teach the user that input quality drives output. Related: [[design_conductor_per_connector]] for the connector intake pattern. Feeds the judge (TDE-261): success_metrics + quality_bar + definition_of_done are what task contracts evaluate against.

NOT built (deferred to follow-up): user-defined personal/org default ISs/KBs that auto-seed every project (original milestone 1). Personal default KBs were judged low-value (KB entries are project-specific); personal default IS partly covered by the existing auto-seeded baseline IS.
