# Flows: contract-gate logic is mirrored in TWO places — keep in sync (UPDATED: the gate no longer blocks, TDE-820)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

⚠ SUPERSEDED IN PART — 2026-07-28 (TDE-820). The mirroring warning below still holds, but the gate itself no longer BLOCKS anything, so what needs syncing has changed.

## What changed (TDE-820)
`contractGateViolations()` is gone, replaced by **`contractAdvisories()`** + `renderContractAdvisory()` in V2/supabase/functions/mcp/contract_gate.ts. The old function collapsed three different states into one "violation" list and `name_flow` hard-blocked on any of them. That contradicted the Flows definition settled 2026-07-28 (contracts are OPTIONAL; gate only at seams) and forced legitimately-ungated flows through `bypass: true`, permanently stamping them gate-bypassed.

The three states are now distinguished and NONE of them blocks:
- **ungated** — no contract on the handoff. Legitimate and common. Informational.
- **vague** — a contract exists but trips lintRule. Warning; already surfaced at authoring time.
- **unblessed** — sharp rules, not human-confirmed. Warning; the blessing should bite at VALIDATION time (see TDE-216), not when naming a flow.

`name_flow` now always succeeds and returns an advisory. `bypass`/`bypass_reason` are accepted but IGNORED (deprecated, kept so older callers don't error) — a flow finalized today is never stamped gate_bypassed.

## The mirroring warning (STILL TRUE)
Contract logic exists in two places and drifts silently:
1. **Server**: V2/supabase/functions/mcp/contract_gate.ts — the authority. Unit-tested in contract_gate.test.ts (16 tests as of TDE-820).
2. **Client**: V2/app/src/lib/flowGraph.js — a deliberate client-side mirror of `lintRule` and the gate summary, so the Flows page can render badges without a round-trip. Its own comment says so.
If you change rule-quality or gate semantics on the server, check flowGraph.js. As of TDE-820 the client was ALREADY aligned with the new definition (its comment notes "gates belong only at seams, and a flow may have none — but 'no violations' and 'nothing to violate' are different states"); it was the SERVER that lagged. Don't assume the server is the more current of the two.

## gate_bypassed on old flows
Kept as data (no migration, no history rewritten) but re-worded in the UI: the badge now reads "◷ Pre-gate-change" in neutral styling instead of "⛔ Gate bypassed" in alarm red, because under the old rule the ONLY way to create a valid ungated flow was to bypass — so most of those records are not wrongdoing. FlowsPage.jsx GateBadge holds the wording.
