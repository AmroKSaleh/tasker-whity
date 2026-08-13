# Session roll-up 2026-07-18: desktop viewer + Local Mode parity push (grounding, create-by-ref, milestones)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

One long session (2026-07-18). All work below is MERGED to main and DEPLOYED to Supabase (mcp function). Ordered as it happened; each has a dedicated KB entry with the details.

**1. Tasker Local — desktop viewer (MERGED, merge e50cf5b).** A read-only Electron app (V2/desktop/) rendering local .tasker/ folders as the editorial board: live fs.watch re-render, card flash, staleness stamp, multi-project registry, light/dark. Plus a manual owner-only "↓ Pull from hub" button (project-scoped device-token auth, indeterminate progress bar) — pull-only, no daemon. Three first-run bugs fixed (nested .tasker/<NAME>/ discovery, UTF-8 BOM in JSON, CSS [hidden]-override making a loaded board invisible). Run: cd V2/desktop && npm install && npm start (clear ELECTRON_RUN_AS_NODE if launching from VS Code). KB: "Tasker Local desktop viewer: architecture + the ELECTRON_RUN_AS_NODE launch gotcha". Deferred wedge: launch-Claude-Code-from-a-card button (turns viewer into a cockpit).

**2. Cost premise CORRECTED.** Measured online-MCP vs local-files for a "read 10 / edit 3" session: local was ~2.2x MORE expensive on tokens because the per-task governance footer duplicated the full IS N times. Conclusion: local is NOT auto-cheaper; its durable wins are latency/offline/git-native. That motivated #3, which also made local win on tokens.

**3. Grounding restructure (MERGED 545073b).** Removed the per-task IS footer; grounding now written ONCE per pull as dedicated files: <prefix>-instruction-set.md, <prefix>-foundation.md, kb/ (one read-only file per KB entry), context.md slimmed to pointers + KB index. ~47%+ fewer ingest tokens. DO NOT re-add the footer. KB: "Local Mode: grounding lives in dedicated files".

**4. Group + section create-by-reference (MERGED d5d47cf = TDE-581 group; 0d771f6 = section).** An unknown group:/section: slug in a task's frontmatter now CREATES it on flush, named verbatim as the slug ("slug-is-name" → guaranteed round-trip). Reported in created_groups[]/created_sections[]. Finding: applyFlush ALREADY honored MOVING across existing sections/into existing groups; only CREATE was missing. KB: "Local Mode: group + section create-by-reference via flush (slug-is-name)".

**5. Milestones in files (MERGED 46eeb18).** Plain milestones round-trip through task files. SEED CLOBBER GUARD: milestones share task_discussions.steps with seed checklists (kind-tagged), so flush refuses to write milestones onto a seed task (warns, leaves checklist intact) — live-verified on TDE-713. KB: "Local Mode: milestones in files — emit + reconcile with the seed clobber guard".

**WHERE LOCAL MODE STANDS NOW:** via files you can read everything offline (tasks, IS, Foundation, KB bodies) and write task fields, section/group placement, group+section CREATE, task create/delete, and milestones. STILL HUB-ONLY: flows (biggest gap), group/section RENAME/DELETE/REORDER (parked seed TDE-713 — needs a writable manifest + stable identity), contract/review authoring, KB authoring. Umbrella: TDE-534.

**PROCESS LESSON (cost real data):** a live test overwrote TDE-302's real milestones (no snapshot first; TDE-302 was doomed anyway — lucky). RULE going forward: destructive live tests use a DEDICATED THROWAWAY task (create → test → delete), never a real one. applyFlush has no mock-sb harness, so live testing is the norm — this recurs.

**OPEN THREADS for a fresh session (both deserve the user in the room for design calls):** flows-in-local (TDE-534), and the structural manifest (TDE-713 seed, 5 open questions).
