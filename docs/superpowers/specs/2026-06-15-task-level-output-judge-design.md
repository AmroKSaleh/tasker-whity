# TDE-261 — Task-Level Output Judge — Design

- **Date:** 2026-06-15
- **Status:** Design approved in discussion; pending written-spec review
- **Related:** TDE-184 (dynamic KB — done), TDE-254 (KB read-loop — prerequisite for Phase 2), TDE-137/200/201/202/203/204/156 (flow contract + validation machinery — done)

## Motivation

LLM execution drifts from intent by default — it's usually just invisible until someone notices. The motivating case is the KB entry *"Case: Brand DNA Drift in Image Prompts"*: image prompts quietly drifted off-brand and nothing caught it at completion.

Flows already enforce conformance via contracts + independent validation — but **only for tasks wired into a flow**. This feature brings the same conformance enforcement to **any** task, including standalone ones.

## Scope

**In scope:** judging a task's **output** (the deliverable) against a bar, on any eligible standalone task, opt-in.

**Out of scope (explicit non-goals):**
- Judging the **process / execution trace** — ruled out as far too expensive.
- **Flow tasks** — hard rule, see *Mutual Exclusivity*.
- Tasks **without a checkable deliverable** — discussion/decision, human-gate, milestone-only.

## The Bar (source of truth)

Assembled once and **frozen at enable-time**. Three layers, most-specific first:

1. **Task text + context** → the specific intent. Always present, so every eligible task has at least a floor bar ("does the output do what the task asked?").
2. **IS (project + section)** → universal standards, already auto-injected into every task.
3. **Relevant KB entries** → selective, via **title-scan**: load all KB titles (cheap, ~IS-level cost), the assembling AI picks the on-topic few, pulls the full text of only those, and translates them into checkable rules.

Rules of assembly:
- **Soft cap ~3–5 standards.** If more match, **flag** (never silently truncate). Many matches is itself a signal the task may be too broad and should be split.
- **Optional manual override:** the user can pin ("use entry X") or exclude ("ignore Y") at task creation or during execution. Never required — automatic is the default.
- **Optional KB `category`** as a *soft hint* to pre-narrow the title-scan. Designed in, but v1 does not depend on it. Requires a controlled vocabulary to avoid category sprawl. A category is a hint, not a hard gate (a hard gate could hide a relevant entry).
- **Frozen snapshot** at enable-time. Steering during execution re-derives the snapshot.

## The Judging Loop (reuses flow validation machinery)

1. Producer completes the task → `store_artifact` (verbatim output; required when judgment rules exist).
2. **Rule split:**
   - `check` rules → run inline/deterministically (no subagent).
   - `judgment` rules → `validate_output` returns a validator prompt → spawn a **fresh, independent adversarial validator subagent** (starts from a FAIL prior) → `submit_validation_result`.
   - **Independence:** the judge receives the artifact **from the server**, never the producer's claims.
3. **Verdict:**
   - `pass` → done.
   - `regenerate` → re-run the producer with the judge's specific feedback, then re-judge. **Loop until pass.**
   - `ask_human` → reached after **3 failed attempts** (the Flows retry limit). Stop and surface the judge's critique to the user via a question. This bound caps cost and catches impossible/contradictory bars instead of looping forever.

## Trigger & Enforcement

- **Opt-in, default OFF per task.** Available on any eligible task; you or the AI flag which tasks get judged. No token tax on unflagged tasks. (Per-section/project defaults are a later option.)
- **AI-driven completion (via MCP): synchronous** — the agent runs the judge immediately after completing and acts on the verdict before moving on (mirrors flows).
- **Human completion (in the app): asynchronous** — the task marks done, is judged in the background, and is reopened with feedback if it fails.

## Eligibility

Only tasks with a **checkable deliverable**. Discussion/decision, human-gate, and milestone-only tasks are out of scope (nothing to judge). In practice: review only fires when the task has output rules / produced an artifact.

## Mutual Exclusivity with Flows (HARD RULE)

A task is **either** flow-governed (its contracts + the flow gate handle QA) **or** eligible for task-level review — **never both**. If a task is in a flow, task-level review does not apply, period. This removes all double-judging/dedup logic — it becomes a single ownership check.

## Dependency & Phasing

KB-enriched judging depends on **TDE-254** (reliable, selective KB read-loop) — the title-scan retrieval is exactly what 254 builds.

- **Phase 1 (now — no 254 needed):** intent + IS judging. Universal; catches "output doesn't match what was asked" and any IS-encoded standard.
- **Phase 2 (after 254):** KB-enriched judging. Catches selective domain drift (the brand case). Anything you want enforced on *every* task can live in the IS and is covered in Phase 1.

## Independence Guarantees

- Artifact stored server-side and passed to the judge; producer claims are never the evidence.
- Judgment rules evaluated by a separate subagent from a FAIL prior.
- (Future, high-stakes) multi-vote: N judges, majority pass — deferred.

## Reused vs Net-New

**Reused (already exists):** `set_task_output`, `store_artifact`, `validate_output`, `submit_validation_result`, the regenerate / `ask_human` escalation policy, the independent-subagent pattern.

**Net-new:**
- Task-level enable flag + eligibility check.
- Bar auto-assembly (title-scan → translate to checkable rules). Phase 2 portion needs TDE-254.
- Opt-in trigger wiring on `complete_task` (sync for agent / async for human).
- Verdict visibility on the task (avoid the `store_artifact`-invisibility trap).
- Flow mutual-exclusivity check.

## Open / Flagged

- **Loop bound:** encoded as the Flows behavior — loop until pass, escalate to human after 3 fails. (Confirm the bound vs a truly unbounded loop.)
- **KB `category` + section-scoped retrieval:** Phase 2+ precision, not v1.
- **Per-section/project review defaults:** later.
- **Verdict UX surface in the web app:** needs its own design pass.
- **Cost controls** (cheaper model tier for the judge, async batching): tune in Phase 2.

## Success Metrics

Drift-catch rate, false-positive rate, tokens/latency per review — to tune where review is worth enabling.
