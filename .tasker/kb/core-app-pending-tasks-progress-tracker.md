# Core App: Pending Tasks — Progress Tracker

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Core App: Pending Tasks — Progress Tracker

Last reviewed: 2026-06-14

## Status Key
- ⏳ pending
- 🔄 in_progress
- ✅ done (if updated here)

---

## Tasks

**TDE-87** — Mobile sucks ⏳
Decision: optimize AFTER desktop/web app is feature-complete. Don't break mobile (no fixed widths), don't optimize it yet.

**TDE-184** — Have the KB of a project be dynamically updating ⏳
*Currently being scoped.* Three candidate interpretations: (a) agents auto-write learnings into KB as they work, (b) entries auto-refresh from task activity, (c) periodic summarization pass rebuilds KB. Closest MVP: behavioral IS prompt that nudges agents to call create_kb_entry on complete_task.

**TDE-155** — Add the ability to use external tools ⏳
Flagged for deep design discussion before any build. Open questions: registration/declaration, sandboxing, where execution happens (local vs edge), invocation contract.
Note: the Google OAuth work (TDE-245) is a separate, adjacent effort — not the same task.

**TDE-186** — Tasker can't move tasks between projects ⏳
Difficulty: MODERATE. Phase 1 = single task move + warn-and-drop cross-boundary I/O edges. Phase 2 = bulk/section move + edge remap.

**TDE-182** — Add task flags + "spotlight" retrieval ⏳
Difficulty: MODERATE. Risk is sync correctness. MVP: auto-synced flags (in_progress, top_priority, blocked) + one cheap spotlight read. `pinned` bool already exists — reuse it.

**TDE-151** — Update the magic prompt 🔄
Needs definition pass first: what IS the magic prompt, where does it live, what's wrong with it.

**TDE-161** — Day progress summary button ⏳
Deferred for later.

**TDE-170** — Persistency across platforms and devices ⏳
Mechanism: per-task context/notes as durable memory layer. Dependency: TDE-181 (append mode) should be sequenced first.

**TDE-243** — Repo-format import: CC native tasks + write-back ⏳
Priority: high. Follow-up to TDE-147 (Spec Kit import, shipped). Remaining: (1) CC native task detection + parsing, (2) write-back for imported sources, (3) npm client bundling.

**TDE-249** — Add custom task statuses ⏳
Difficulty: MODERATE. Touches DB, MCP, frontend, and flows. Risk: breaking existing 3-state assumptions in contracts.

**TDE-250** — Add built-in time tracking ⏳
Difficulty: LOW-MODERATE. AI angle: agents auto-log time on tasks they complete.

---

*Update this entry whenever a task ships or its scope changes. Will be replaced by dynamic KB once TDE-184 is built.*
