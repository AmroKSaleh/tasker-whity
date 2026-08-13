# Coherence-pass record: coherence_decisions Foundation field (TDE-300)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**What shipped:** Bootstrap's Phase 2 probe (`phase_2_draft_and_probe`, the "drafted" step) now records its resolved decisions as a `coherence_decisions` field on the Foundation — decision provenance so future agents inherit the WHY and don't re-litigate settled calls or re-propose deferred scope.

**Key realization (why it was small):** There is no code step literally named "coherence" — the "coherence pass" IS the Phase 2 draft-and-probe. And the Foundation brief is already a flexible JSON object stored verbatim in `project.context` and surfaced by `renderFoundation`. So this needed NO migration, NO new column, NO new write path — just a new key on the brief the agent already submits.

**Shape decision — strings, not objects:** `coherence_decisions` is an array of self-contained "<decision> — because <rationale>" strings (e.g. "Deferred subscriptions to Phase 2 — core booking flow must prove out first"). Chose strings over `{decision, rationale, scope_ref}` objects by the same principle as the seed-checklist merge: don't structure for behavior nothing consumes yet. The consumer is an LLM reading the project-context block; a sentence beats a JSON object for that. Trivial to upgrade later (tiny volume, human-readable).

**Scope:** bootstrap-only for now. Did NOT build a mid-project "append a decision" write path — no demand yet. If it becomes the general decision-log home, revisit.

**Implementation:**
- `FOUNDATION_LABELS`/`FOUNDATION_ORDER`: added `coherence_decisions` → label "Deliberate decisions (why)", rendered last.
- `renderFoundation`: special-cases the key — pushes ONE multi-line out[] entry (`label:\n  • a\n  • b`) so the label takes the caller's "- " prefix while bullets keep just "•". This avoids a double marker across all three callers (get_project_foundation + get_task both prefix "- "; get_project does not).
- `bootstrap_advance` Phase 2 return: new `record_decisions` instruction telling the agent to capture each resolved probe into `coherence_decisions[]` in the brief; `next` hint mentions the key. Resilient: the blessed step falls back to the stored draft brief, so the field survives even if a re-edit omits it.

**Verified:** created a project with a `coherence_decisions` context, get_project_foundation rendered clean one-per-line bullets. NOT yet exercised through a live interactive bootstrap interview (the capture-by-agent path) — will be on the next real bootstrap.
