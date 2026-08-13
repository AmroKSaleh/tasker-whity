# Positioning: Tasker's wedge is durable, human-shared, quality-gated state (TDE-367)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Decision from the TDE-367 strategy discussion (2026-07-06), user agreed.

**Canonical messaging line (imprint everywhere):** Tasker is "durable, human-shared, quality-gated state that persists across sessions, agents, and people."

**The threat that prompted it:** if an AI platform already has a native task tool (Claude Code's TodoWrite, etc.), why call Tasker's MCP, and isn't it too token-expensive? This is the Foundation's own "MCP commoditized by larger tools" risk made concrete.

**Conclusion (two parts, opposite answers):**
1. SUBSTITUTION — Concede the ephemeral single-session lane. Native todos are strictly better there (zero marginal tokens/latency/auth, baked into the harness, vendor-privileged). Tasker must NOT pitch itself as "a better scratchpad for the agent mid-session" — that framing is fatal. Tasker wins only where native is structurally absent: durability across sessions, a human-inspectable shared board, and quality gates (flows / I/O contracts / validation). Sharpen the IS "AI-native task manager" block: the wedge is not "AI is a first-class user," it's the durable/shared/gated state itself.
2. TOKEN COST — The objection is substantially TRUE of the current build and is now a top-tier product risk, not a nicety. get_task re-injects full Foundation + full IS + the entire KB index on every call (~2–3k tokens of repeated boilerplate). Right baseline isn't "Tasker vs. a free native todo" — it's "Tasker vs. the cost of the agent re-deriving context every session." That math only favors Tasker for multi-session/gated work AND only if the token economy is fixed (tiered/lazy context). TDE-319 is one symptom.

**Real long-term danger (named for future sessions):** not today's ephemeral TodoWrite, but vendors adding DURABLE native memory (CLAUDE.md + persistent memory files already exist). Defense = the quality-gate/flow layer, the hardest piece for a general-purpose vendor to justify replicating. See [[decision_execution_layer_2026_06_19]].

**Unverified assumption to watch:** that durable/shared/gated value outweighs setup+token friction for actual Phase-1 solo-dev users. Empirical, not yet proven.

Follow-ups spawned: messaging imprint task + MCP token-economy/tiered-context task (folds in TDE-319).

---

## REFINEMENT (2026-07-24) — lead with the plain truth, EARN the wedge second

Prompted by a plain-language check ("at the end of the day, Tasker is used by people to manage their different projects, correct?" → yes). This does NOT contradict the wedge above — it puts the correct FLOOR under it, and fixes a messaging-order trap.

**The base truth (must lead):** Strip away all framing and Tasker IS a project management tool that PEOPLE use to manage their projects. Project → sections → tasks → milestones, a board, progress. The human is always the operator at the end of the chain — they decide what the work is, author the quality bar (confirm_contract is human-blessed), own the outcome, and get the value. Agents are the LABOR (they execute items and write results back); the human is the DIRECTOR and OWNER (see TDE-375: human stays owner even when work is delegated).

**Correct framing of "agent-native":** it means WHO does the mechanical execution and WHAT the state is optimized to read/write — NOT that the human is cut out. "A task tool for AI agents" is WRONG and unappealing (sounds like it removes the human). Say instead: "the project manager for people building with AI — you stay in control, agents do the work, and it doesn't forget."

**The messaging-ORDER rule (the actionable takeaway):** Lead with the legible base truth ("manage your projects"), THEN earn the differentiator right after ("...built for how you actually work with AI now — durable, gated, doesn't forget"). This is exactly how Plane won: "open-source project management" FIRST (instantly legible), the open-source angle SECOND (the reason to switch). Do not open with the clever/opaque wedge line to a cold audience — it reads as a different category. Applies directly to TG-56 (one-line hook) and TG-67 (COSS narrative) in Tasker Growth: be a project manager first, be the SPECIAL project manager second.

**Why this matters:** the wedge (durable/shared/gated) is the reason to CHOOSE Tasker, but it only lands once the reader already knows it's a project manager. Wedge-first messaging skips the step where the reader understands what the thing even is.
