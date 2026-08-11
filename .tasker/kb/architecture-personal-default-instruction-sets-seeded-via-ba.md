# {architecture} Personal default Instruction Sets — seeded via baseline trigger (TDE-295)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-295: account-level default Instruction Sets that auto-seed new projects.**

## Mechanism
New table `default_instructions` (user_id, title, content, universal, sort_order). The EXISTING baseline trigger `seed_baseline_instructions()` (AFTER INSERT on projects) was extended: after inserting the two built-in baseline entries, it `INSERT … SELECT`s the creating user's default_instructions into project_instructions, ordered by sort_order. So defaults apply on EVERY creation path (create_project, bootstrap, manual UI) in one place — same reason the baseline lives in the trigger. SECURITY DEFINER lets it read default_instructions regardless of caller RLS. Migration: 20260626120000_default_instruction_sets.sql.

## Important semantics
- Edits/additions to defaults affect FUTURE projects only — already-created projects keep the project_instructions rows they were seeded with (they're copied, not referenced). MCP tool responses and the Settings UI both state this.
- import_project still deletes the trigger-seeded IS and restores the bundle's own IS (unchanged) — correct, an imported project keeps its source IS verbatim. So defaults do NOT pollute imports.

## Surfaces (both, per user choice)
- MCP: create_default_is_entry / list_default_is_entries / update_default_is_entry / delete_default_is_entry (account-level, no project_id).
- Web: Settings → "Default Instruction Set" section (DefaultInstructionsSection.jsx) — add/edit (save-on-blur)/delete, universal toggle. Talks to default_instructions directly (RLS = auth.uid()).

## Scope
Phase 1 = personal. Org/shared team defaults = Phase 2 B2B. Personal default KBs were deprioritized (KB is project-specific; a seed-everything KB mostly seeds irrelevance).

## Verified
Trigger smoke test: created a throwaway project post-migration → baseline still seeds, creation didn't break (the new SELECT…INSERT loop is a no-op when the user has 0 defaults). Full seed-a-real-default path pending (new MCP tools need a CC restart to load, or add one via the live Settings UI).
