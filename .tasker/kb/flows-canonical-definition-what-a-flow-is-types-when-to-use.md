# Flows: canonical definition — what a flow IS, types, when to use one, the advantage over ordered tasks (TDE-792)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## The definition
**A flow is a single operation too big for one sitting — cut into steps so it holds together across its length, and gated only where one step's output becomes the next step's unexamined premise.**

## Why flows exist — the root problem (bigness)
A plain ordered list works until an operation gets LARGE; at scale a single-context execution drifts, self-approves its own errors, can't be interrupted/resumed, and becomes an unreadable wall of context. A flow is durable, legible structure that keeps a big operation's quality, memory, and shape intact across its length.

## The two motives (not types — both can coexist in one flow)
- **RUN IT RIGHT** — the operation is sensitive, so seams get gated and quality is protected at the joints.
- **HOLD IT TOGETHER** — the operation is big, so it gets durable structure, resumability, legible progress, protection from drift.
Test: which motive applies? Neither → it's tasks, not a flow.

## The boundary against plain tasks
Scale floor: can't be fairly held in ~2 tasks without a wall of context. Connection between steps is NOT required — big sequential and even homogeneous batch operations are flows. Contracts are optional too — a flow with no gates anywhere is still a flow.

## Container vs operation
A flow RUNS AND TERMINATES. Projects/sections/groups/phases are containers — they hold things indefinitely; a phase ends when you declare its condition met, not by executing. Anything that never terminates is not a flow, however big. Tell: wanting to add unrelated work to it later means you built a container and mislabelled it.

## Step granularity
Promote a boundary to its own step only when it must: hand an artifact over · change executor · permit a gate · permit a clean cold stop. Otherwise it's a milestone inside a step. Size calibrates, never locates. This pushes toward FEWER steps — a 40-step flow rebuilds the context wall one altitude up.

## The seam
A step's context arrives from 4 sources: human-at-creation, human-on-request, AI-asserted (research + operation-output are one category), and durable state. The risk lives entirely in AI-asserted context — it carries no presumption of authority but looks identical to the consumer.
**Handoff vs seam:** a handoff is any AI-produced thing passed forward; a seam is the subset the receiver will NOT re-derive. Gates only ever sit on seams. Test: would the next step notice if this input were wrong? Seams are dissolvable — make the receiver re-derive, or put context in durable state so it's read, not passed. The cheapest gate is no seam.

## The gate
A gate's only job: stop an AI-asserted claim becoming an unexamined premise downstream. Not general QA.
- The RECEIVER authors the bar (what must be true for me to build on this), not the producer's promise of intent. Enforcement stays at the producer's output edge.
- Order by detection power per unit cost, not cheapness — an undetecting gate BLESSES a bad output, which is worse than no gate.
- Blast radius picks which seams to gate first: early seams in long flows, irreversible actions.
- Ladder: dissolve the seam → deterministic check → human gate at high-blast seams + terminal output → producer-side gate with receiver-authored bar → receiver intake read → independent AI judge, last resort.
- **Empirically tested (TDE-791 Round 1 + Round 2):** the contract/spec is a large, reproducible win. Independent AI-judge validation is NOT — it added ~0 pass-rate over spec-only in both rounds, and in Round 2 (harder task, real headroom) never once caught a defect that persisted in every trial, consistent with correlated blind spots (judge shares producer's reasoning and mistakes). When used at all, an independent judge needs: a different model family than the producer, receiver-purpose framing (not producer-reasoning), verdicts recorded as a weaker evidence class than checks, and scope limited to the terminal output + omission-shaped criteria.

## The human
Attention spent exactly 3 times: author the bar once, up front · review EXCEPTIONS only during the run, never passing outputs · gate the terminal output unconditionally. Not a per-step approver — attention degrades with volume (rubber-stamping → blessed errors). The contract's job is to shrink the residue: every criterion made checkable is one never looked at again.

## The agent
Engine, not judge — runs checks, captures raw evidence, does not rule on judgment criteria. Decides WITHIN the bar, never ABOUT the bar. Halts on CONSEQUENCE, not uncertainty: terminal output · irreversible action · an unresolved failed check · a durable stop signal.

## Types
THERE ARE NO FLOW TYPES. Gate kind, shape, executor, batch-vs-process, determinacy all failed the test (does it vary inside a single flow? then it's not a type). No flow_type column, no dropdown, no per-type branching.

## Reuse
The reusable unit is the BAR, not the shape. Step lists are re-derivable in seconds; criteria are where human attention went and are more portable. Promotion to a template is a manual "update template" button with a selective-commit diff (manual is required, not just cautious). The most valuable finding is a rule-gap event: human rejects where every check passed → the bar itself was wrong → propose a new criterion.

## When NOT to use a flow
Fits fairly in ~2 tasks · never terminates · you need it visible on the board (flow steps leave the board — a real, under-named cost) · manufactured gates · needs ~40 micro-steps · neither motive applies.
Explicitly NOT anti-patterns: no contracts anywhere · an all-human executor (Guide Mode, which is structurally gateless — no AI assertions, no seams) · a flow that discovers its own steps as it runs (step-list-open) · homogeneous batch work.

## Success
A single run's success is just the human accepting the terminal output. The FEATURE is judged on: rework rate vs. the same work as plain tasks · rule-gap events per run trending down across template runs · human review load staying flat as flow length grows. Anti-measure: do not measure flow usage — more flows created is a warning sign, not a win.

## What this overturns (older KB entries below are retired — do not follow)
- "A flow with no contracts is just ordered tasks" → false, gateless flows ARE flows.
- "A flow is a connected component of the I/O graph" → false, connection is optional.
- "The contract is the unit of granularity" → replaced by the four step-promotion triggers, which push toward fewer steps.
- Types by executor/gate-kind/shape → there are no types.
- The agent as executor AND validator → engine, not judge.
- Independent validation as the default enforcer → last resort, with conditions.
Retired: "137 Contract Layer — Design Decisions", "Flow-vs-ad-hoc guidance lives in global directives (TDE-255)".

Source: the 11-question ground-up agenda (TDE-793…TDE-803, run 2026-07-25→28) plus the empirical Round 1/Round 2 contract-gating experiments (TDE-212, TDE-791). Full working history lives in each question task's detail and the session memory file `session_flows_ground_up_definition.md`. Directive already shipped to production via TDE-808/813/818 (merged).
