# 137 Contract Layer — Design Decisions

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# 137 Contract Layer — Design Decisions

Running record of the design decisions for TDE-137 (the Flow contract layer), captured during the 2026-06-05 design discussion. The conceptual design is COMPLETE as of 2026-06-05 — this is build-ready. See KB "Flow's Messaging Angle" for the reframe this builds on, and KB "Task Input/Output System Design" for the original (thin) I/O model being upgraded.

## Framing recap (already decided in the reframe)
- 137 is the CONTRACT LAYER, not a workflow runner. The agent (Claude Code) is the engine. 137's job is the part agents don't give themselves: a human-authored quality bar the agent can't quietly fake past.
- Agent-executed via MCP; Tasker stores contracts/state. The agent does the work AND the validation (both deterministic checks and semantic judgment — see "Check execution" below). Tasker makes NO paid AI calls.
- Dev/MCP-exclusive. Supervised autopilot.

## Flow boundary & shape (decided 2026-06-05)
- **A flow is independent of sections and groups.** Sections/groups are purely organizational. The flow is a separate overlay defined entirely by I/O edges.
- **A flow = a connected component of the project-wide I/O graph.** Project-scoped (cross-project flows out of scope). This is ALREADY what `get_flow_order` does (resolves whole project, undirected adjacency from `input.source_task_id`, connected-component detection, emits labeled "Flow 1/2/…"). The decision ratifies existing code.
- **A flow is emergent, not a stored container.** "Create a flow" = create tasks + wire their I/O. The Blueprint view is the flow visualization for free.
- **Flows are DAGs — fan-in AND fan-out.** A task can consume from MULTIPLE upstream tasks (draft needs outline AND research) and feed MULTIPLE downstream. (Current code supports fan-OUT only; each task has one `source_task_id`. Fan-IN is a 137 upgrade.)

## Data-model shape (decided 2026-06-05)
- **Edges authoritative on the INPUT side** (matches existing code — graph built from `input.source_task_id`, never `output.target_task_id`).
- A task's **`input` = a LIST of edges**, each `{ source_task_id, input_contract }`. The input_contract = consumer's acceptance criteria for THAT incoming artifact. Fan-in = multiple edges; each validated independently.
- A task's **`output` = a SINGLE contract** — producer's one definition-of-done for the one artifact it makes. Fan-out needs nothing on the output side; consumers are derivable (tasks that list me as source). `output.target_task_id` becomes redundant for graph purposes.
- Asymmetry: a task PRODUCES one thing (one output contract) but may CONSUME many (one input contract per incoming edge).
- Build consequences: (1) `get_flow_order` depth calc → real TOPOLOGICAL SORT. (2) Migration is light — `input` is JSON; one object → list, backward-compatible by treating a lone `source_task_id` as a one-element list.

## Three-layer separation (decided 2026-06-05)
Every task separates into three layers, stored distinctly:
1. **Process** — steps + order. Fixed across runs.
2. **Contract** — the quality bar. Mostly fixed; the reusable IP. Lives in input/output, NOT detail.
3. **Context** — this run's subject. Varies every run. Lives in title/detail.
Hard rule: **the contract must be context-free / portable** ("draft must cite ≥3 sources", never "draft about the realtime feature"). This is what makes 152 (Flow Templates) possible. 137 doesn't build templates but must store contracts so templates are nearly free later.

## Contract storage (decided 2026-06-05)
- `input`/`output` ALREADY EXIST (migration 20260529120000_add_task_io.sql) but hold a thin "type" + freeform validation_rules string. 137 = UPGRADE the payload to a structured contract, not add fields.
- Contracts stored as **structured, itemized data** (a list of rules), NOT prose. Enables per-rule display/edit, clean template copy, consistent agent validation.

## Rule schema (decided 2026-06-05)
A contract = an ordered LIST of rules (an input contract also carries its `source_task_id`). Each **rule**:
- **`id`** — stable identifier (so feedback can reference a specific rule + you can edit one rule in isolation).
- **`label`** — short name, for chips/lists ("Cites enough sources").
- **`rule`** — THE RULE ITSELF (the assertion checked). Shape depends on `kind`:
  - `judgment`: a precise natural-language criterion the agent evaluates ("Cites ≥3 credible primary sources, linked inline").
  - `check`: a structured `{ type, params }` from a small fixed set (e.g. `min_length`, `max_length`, `must_include`, `matches_pattern`, `valid_format`, plus an environment escape-hatch `{ type: 'command', run: 'npm test', expect: 'exit 0' }`).
- **`description`** — OPTIONAL human context (why it matters / how to satisfy). Read by human + agent; not itself a pass/fail target. (Could merge with `rule` for minimalism; kept split so `rule` stays terse/checkable.)
- **`kind`** — `check` (deterministic) | `judgment` (agent-evaluated).
- **`severity`** — `blocker` | `warning`. A failed BLOCKER reopens the producing task; a failed WARNING is recorded in the ledger but does NOT block the handoff. (Lets one schema carry hard requirements AND soft preferences.)
- On validation, each rule yields a result `{ rule_id, status: pass | fail, note }`. That list IS the feedback-ledger entry.

## Check execution: AGENT-RUN in v1 (decided 2026-06-05 — REVISES the reframe's "deterministic checks in-MCP")
The agent runs BOTH `check` and `judgment` rules; Tasker runs none in v1. Why:
- The output lives in the AGENT's environment (code in the repo, files, a build), not in Tasker. In-MCP checks would require shoveling full output content into Tasker's DB — bloated, duplicative, nonsensical for code. The agent is already standing in the environment with the content.
- One executor keeps 137 small: `validate_output` hands back the contract + "run these checks, judge these criteria, report per-rule results" and treats both rule kinds through one uniform path. No content-transport, no second code path.
- Integrity preserved: the RULES live in Tasker and are human-authored/confirmed — the agent can't change the bar, only execute + report. Deterministic results are trivially human-spot-checkable, and the confirm gate sits on top. Acceptable for supervised autopilot.
- DEFERRED (later hardening, not a v1 blocker): Tasker-run deterministic checks for trust-sensitive checks on content that genuinely lives in Tasker (tamper-proof: agent can't fudge a result Tasker computed). Could become its own task when trust requirements grow.

## Contracts on BOTH ends (decided 2026-06-05)
output contract + input contract(s), NOT redundant:
- In a chain, input and output describe DIFFERENT artifacts.
- At a seam the two play different roles and the GAP is the signal: **output contract** = producer's definition-of-done (pre-handoff self-check); **input contract** = consumer's acceptance criteria. Divergence (A meets its own spec but B can't use the result) is the most valuable feedback and can't be expressed with one contract. This is the foundation of the loop (156).
- Author both to agree, but ALLOW divergence — it's signal, not error.

## Validation gate behavior (decided 2026-06-05)
At a seam, `validate_output`: **consumer's input contract is the GATE** (decides pass/fail, written to the producer's feedback ledger). **Producer's output contract is a self-check** surfaced if it also failed, but doesn't independently gate. (Rejected: producer-output-only.) The agent executes the rules per "Check execution" above.

## Endpoints exception (decided 2026-06-05)
"Both ends" is for MIDDLE tasks. First task: no upstream (input from human/world) → may have only an output contract. Last task: no downstream → may have only an input contract (or human-validated output).

## AI-assisted authoring + the human-confirm moat (decided 2026-06-05)
Human authors the contract by discussing with the AI; AI proposes the structured contract; human reviews + CONFIRMS. The confirm step IS the load-bearing wall: the moment the contract becomes human-authored (external bar) vs AI-guessed (agent grading its own homework). Mandatory, not skippable. The same "AI proposes → human confirms" shape repeats across the journey (one mental model):
- Author contract → propose rules → confirm.
- Templatize → AI strips context, keeps structure/contracts → **template DRAFT** (human edits, draws context-vs-rule line) → confirm → **ready template**.
- Instantiate → AI grills the template's blank slots → confirm filled flow.

## Interrogation = the agent's engine; adopt a LOT of grill-me (decided 2026-06-05)
`/grill-me`-style interviewing (`ask_question`/`AskUserQuestion`) already exists in the agent. Tasker supplies the decision TREE (template slots = questions; contracts = branches + bars), never the engine. **Adopt a LOT of the rich grill-me behavior** (one-question-at-a-time, recommend-a-path, codebase-first, design-tree traversal, end-in-approval-artifact) — because the interview is the CONSTRUCTION MECHANISM for the flow foundation that all tasks check against. Thin interview → thin contracts; rigorous interview → real bar. Three modes differ in shape: CREATE builds the tree, INSTANTIATE walks a fixed tree, TEMPLATIZE extracts a tree. Full detail in TDE-189.

## Flow creation: decomposition direction & task grain (decided 2026-06-05)
- **FORWARD decomposition is the default** (start → … → goal), chosen because it feels more natural to the user (target-audience member). Tentative / empirically tested via backlog task. Caveat: forward needs a known start, but the hard case is "user doesn't know their current state" → forward mode needs a light grounding opener ("what do you already have"), codebase-first for the dev audience.
- **Task grain = the CONTRACT is the unit of granularity.** A step earns its own task only if it produces a distinct, checkable output a later step depends on (a handoff worth a contract). No contract-worthy output → milestone/detail inside a task. Stops at (a) something the user already has, or (b) no distinct downstream-consumed output. Prevents 40-micro-task flows.

## Scope line: 137 vs 156
- **137** = both-ends contract data model (incl. fan-in: input as list of edges) + structured rule schema + validate a SINGLE handoff (per-edge, agent-run) + write feedback to the producer's ledger + reopen that one producer.
- **156** = the multi-step revision LOOP (feedback cascades ≤2 tasks upstream, retry cap 3, then ask the human) + AND-join readiness (a fan-in task is "ready" only when all inputs are done+valid).

## Still open (non-blocking — design is build-ready)
- Exact small fixed set of `check` types + their params (finalize during build).
- UI vs MCP-conversational surface — DEFERRED to its own task (created 2026-06-05).
- Tasker-run deterministic checks — deferred hardening (see "Check execution").
- Degree of grill-me design-tree state mgmt + the unconfirmed re-grill-on-pivot behavior (TDE-189).

