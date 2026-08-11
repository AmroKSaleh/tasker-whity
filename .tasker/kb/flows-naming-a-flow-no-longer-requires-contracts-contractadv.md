# Flows: naming a flow no longer requires contracts — contractAdvisories replaces the blocking gate (TDE-820)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

SHIPPED + DEPLOYED 2026-07-28 (MCP + Netlify), branch tde-820-ungated-flows-not-violations. The third and last surface to be brought in line with the Flows definition settled that day — after TDE-808 (MCP directive) and TDE-813 (Flows UI).

## The bug
`name_flow` HARD-BLOCKED finalization unless every internal handoff carried a non-trivial, human-blessed contract on BOTH sides. Real response when creating a plain two-step flow with no contracts:

  {"status":"contract_gate_failed","blocked":true,
   "violations":["#824 → output def-of-done: no rules (empty contract)",
                 "#825 ← input from #824: no rules (empty contract)"]}

The only way through was `bypass: true`, which permanently stamped the flow **gate_bypassed** and rendered it "visibly weaker than a fully-blessed flow."

That contradicted the settled definition — "CONTRACTS ARE OPTIONAL … a flow with no contracts anywhere is still a flow", "gate only at SEAMS — not every handoff is a seam" — which TDE-808 had already written into the MCP directive and TDE-813 into the UI. Only the MCP's own finalization gate was never updated. Net effect: creating a correct ungated flow was impossible without accepting a false "bypassed" record, which would also have corrupted the moat analytics TDE-784 wants (legitimate ungated flows indistinguishable from real gate-skips).

## The fix — three states, none blocking
`contractGateViolations()` → **`contractAdvisories()`** in contract_gate.ts, returning typed `{kind, where, detail}`:
- **ungated** — no contract. Legitimate; rendered as "normal, gates belong only at seams."
- **vague** — contract exists but trips lintRule. Warning: "a bar nobody can apply is worse than no bar."
- **unblessed** — sharp but unconfirmed. Warning: "fine for now, confirm_contract before relying on it as a gate."

`renderContractAdvisory()` formats them for the operator. **`name_flow` always succeeds.** Rationale for zero blocking (user's call, offered three options): naming a flow asserts identity — "these steps are one operation" — not quality. The vagueness linter already warns at authoring time in set_task_output/set_task_input, so blocking again on a regex word-list at naming time is duplicate ceremony. A missing blessing should bite when the gate RUNS (validation) — that is TDE-216's job.

`bypass` / `bypass_reason` are still accepted so older callers don't error, but are IGNORED and documented DEPRECATED. Flows finalized from now on are never stamped gate_bypassed.

## Historical bypasses: data kept, wording softened (user's call)
No migration, no rewriting of history. The FlowsPage GateBadge now shows "◷ Pre-gate-change" in neutral styling with a tooltip explaining it was finalized before contracts became optional — instead of "⛔ Gate bypassed" in alarm red. Under the old rule the only way to build a valid ungated flow WAS to bypass, so most of those records are not wrongdoing. The flag is preserved for provenance and for TDE-784.
Rejected alternatives: auditing and clearing the flag (edits historical records against a rule that didn't exist when they were made) and retiring the flag entirely (discards a signal the analytics may want).

## Verified live
- Two linked tasks, NO contracts, `name_flow` with NO bypass → succeeds, advisory reads "2 handoffs carry no contract — normal, gates belong only at seams."
- Then a vague output rule + a sharp unblessed input rule → advisory shows the vague and unblessed sections separately; still no block.
- 16 unit tests pass in contract_gate.test.ts, including an explicit regression test that an ABSENT contract is classified `ungated` and that the rendered wording contains no "violation/issue/blocked" language.

## Watch out
- The client mirror in V2/app/src/lib/flowGraph.js was ALREADY aligned with the new definition; the SERVER was the stale one. Don't assume the server is more current — see the mirroring KB entry.
- Re-calling `name_flow` on an existing flow reassigns a NEW flow short ID (observed TDE-F4 → TDE-F5 on the same flow UUID). Documented wrong usage (use update_flow_context to rename) but it churns silently rather than erroring. Not fixed here.
