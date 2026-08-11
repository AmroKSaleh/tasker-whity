# Seeds: unified typed checklist (open_questions + prerequisites merged)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**What shipped (TDE-300):** A seed (flow or task) now carries ONE checklist instead of two parallel lists. `open_questions` and prerequisite milestones both fold into `task_discussions.steps` as TYPED milestone items:
- `kind:'question'` — answered WITH the user during the resolution interview (does NOT gate)
- `kind:'prerequisite'` — work to settle BEFORE resolving; SOFT-gated at resolve time
- `kind` absent — plain milestone (normal tasks, unchanged)

**Why merged (don't undo this):** The only thing that justified keeping open_questions and prerequisites as separate primitives was *differentiated downstream behaviour* — auto-feeding an answered question into a flow's design vs. wiring a prerequisite's output as a flow input. That behaviour was deferred (premature until the bootstrap→build-flow loop is exercised for real). With nothing consuming the distinction, two lists + two gates was over-engineering; one soft-gated checklist is simpler to author and read. The `kind` tag is RETAINED (inert today) so future auto-wiring can differentiate again without a data migration or re-interviewing every seed.

**Implementation:**
- New RPC `append_milestone_kind(p_task_id, p_user_id, p_text, p_kind)` (migration 20260626130000_typed_seed_checklist.sql) — mirrors `append_milestone` but stamps optional `kind` on the step object. checked_steps unchanged, so set_milestone_checked / delete_milestone_at / the frontend checklist keep working.
- `create_task` (seed path): open_questions → kind='question', milestones → kind='prerequisite'. `seed_open_questions` column is now written NULL (deprecated; kept only so legacy seeds still render).
- `get_task` (seed block): renders the unified checklist grouped Prerequisites / Open questions / (other), with a soft-gate warning line on unmet prereqs. Legacy fallback reads `seed_open_questions` only when no milestones exist. Generic Milestones block is skipped for seeds.
- `resolve_seed`: SOFT gate — refuses if unchecked `kind='prerequisite'` items exist, lists them, requires `proceed_anyway:true` to override. Questions never gate.
- `build_new_flow`: new optional `seed_id` — returns the seed's pre_brief + checklist + `unresolved_prerequisites` + a soft `gate` note + `on_finish` (mark seed done after name_flow). Soft because build_new_flow only returns a playbook.
- Frontend TaskDetailPanel: milestone rows show a `prereq`/`Q` badge when `step.kind` is set; seed block text points at the checklist; legacy seed_open_questions list kept as fallback.

**Soft not hard** (deliberate): consistent with trusting the honest user; the override-rate is the signal that tells us whether to promote prerequisites to real linked tasks later. Verified live: created a flow seed with 2 questions + 2 prereqs, get_task rendered both groups + the gate, then deleted.
