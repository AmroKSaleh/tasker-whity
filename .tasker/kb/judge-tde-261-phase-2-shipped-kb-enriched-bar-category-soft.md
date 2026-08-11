# Judge: TDE-261 Phase 2 shipped — KB-enriched bar + category soft-hint

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-261 Phase 2 (the KB-enriched judge bar) shipped on top of TDE-254's read-loop.

**KB-enriched bar (TDE-268):** `enable_task_review` no-bar grounding upgraded from "text+IS only" to "text + IS + relevant KB". It injects the PROJECT KB TITLES INDEX and a TITLE-SCAN instruction: pick only topic-relevant titles (≤5 cap), pull full content of ONLY those via `get_kb_entries`, derive rules, merge into bar.rules (the single merge point). Soft cap + FLAG (don't silently truncate) when >5 match. Freeze stamps `source: 'task_text+IS+KB'`. NOTE: this lifted Phase 1's "no KB" restriction — same tool, evolved.

**Category soft-hint (TDE-269):** `project_knowledge.category` (nullable, CHECK-constrained controlled vocab: architecture, database, deployment, mcp, flows, design, product, gtm, reference, other). `create_kb_entry`/`update_kb_entry` accept + validate it (`KB_CATEGORIES` const). Surfaced as `{category}` in the get_task index + the grounding. **SOFT, not a gate:** neither `get_kb_entries` nor the title-scan filters by category — a relevant-but-differently-categorized entry is still retrievable (verified: a 'reference'-tagged Brand-DNA entry still pulled for an image task).

**Scope note:** Phase 1+2 shipped the judge's CORE (assemble bar from 3 layers → judge loop → verdict surface). TDE-261's broader milestones are still UNBUILT/deferred: multi-vote judges, human override/appeal, async-for-human completion, per-section/project review defaults, cost controls (cheaper validator model), success metrics. TDE-261 left in_progress for those.

All verified live + independently validated. Whole feature built by running flow TDE-F1.
