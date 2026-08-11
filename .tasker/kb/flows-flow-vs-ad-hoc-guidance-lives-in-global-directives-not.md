# {flows} Flow-vs-ad-hoc guidance lives in global directives, not per-project IS (TDE-255 → rewritten TDE-808)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**Where the guidance lives: a GLOBAL directive, not a per-project IS block. The guidance ITSELF was replaced on 2026-07-28.**

## The placement decision (TDE-255, 2026-06-25) — STILL VALID
TDE-255 asked for a "default Instruction Set concerning Flows." We did NOT add it to the auto-seeded per-project baseline IS. Flow MECHANICS (build/run/validate/revision/check-execution/identity) were already fully covered by the global `ASSISTANT_DIRECTIVES` (returned by init_tasker_session every session) plus the tool playbooks (build_new_flow, run_flow). Copying that into every project's editable IS would duplicate it and drift out of sync — the exact pain logged in "contract-gate logic mirrored in TWO places." Per-project IS is for project-SPECIFIC policy, not universal flow knowledge.

**Consequence worth knowing:** there is no default IS entry about flows and there never was. `list_default_is_entries` returns empty. Any task that says "update the TDE-255 default IS entry" is chasing something that does not exist.

## The guidance itself — REPLACED 2026-07-28 (TDE-808)
The original directive said: use a flow only when ALL THREE hold — multi-step toward one goal, steps hand off, and at least one handoff carries quality risk worth gating — plus *"a flow with no contracts is just ordered tasks."*

**That is now retired.** The 11-question ground-up redefinition (TDE-793 … TDE-803, canonical write-up on TDE-792) demoted contracts from the defining trait to an optional per-seam add-on. The current directive says:

> A flow is a single operation too big for one sitting — cut into steps so it holds together across its length, and gated only where one step's output becomes the next step's unexamined premise.

Key reversals now live in the directive: **scale is the floor** and carries the whole boundary (splits fairly into ~2 tasks → not a flow) · **connection is optional** (big sequential and homogeneous batch operations are flows) · **contracts are optional** (a gateless flow is still a flow) · a flow **runs and terminates** (anything that never terminates is a container, not a flow) · granularity is set by **four promotion triggers** (hand an artifact over / change executor / permit a gate / permit a clean cold stop), pushing toward FEWER steps · **there are no flow types** · gates sit only at **seams** (a handoff the receiver will not re-derive), ordered by **blast radius**, and **dissolving a seam beats gating it**.

## The old note called this exactly right
The 2026-06-25 version ended with: *"If TDE-212 shows gating doesn't help, revisit how hard this directive pushes flows."* Round 1 came back contract-proven / validation-unproven, and the redefinition is that revisit.

## Where to edit
Single source of truth remains the `ASSISTANT_DIRECTIVES` array in `V2/supabase/functions/mcp/index.ts`. The `build_new_flow` interview playbook in the same file must be kept in agreement — it previously interviewed for handoffs and contracts as prerequisites and was rewritten in the same pass.

## Gotcha found during the rewrite (TDE-808)
The `name_flow` contract gate (`contractGateViolations` in contract_gate.ts) iterates over **declared input edges only**. A flow with no edges has nothing to violate, so gateless flows finalize cleanly with no code change — good. But declaring an edge FORCES a non-trivial human-blessed contract on both sides, and the new model distinguishes a **handoff** (no gate needed) from a **seam** (gate). So there is currently no way to record "step 2 uses step 1's output" without gating it, and agents will simply stop declaring edges — which costs the I/O graph its information. Unresolved; the interview now tells agents not to wire edges they do not intend to gate.

