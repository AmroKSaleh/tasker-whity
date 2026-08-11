# .tasker/ — Tasker Development (Local Mode)

This folder is the LOCAL mirror of a Tasker project. Agents: work the tasks by editing these files directly — no per-edit network calls.

- GROUNDING (read once per session): `context.md` points at `tde-instruction-set.md` (the governing rules — FOLLOW them), `tde-foundation.md` (goal/why/scope), and indexes `kb/` (one file per KB entry; read only the few relevant to your task). These are read-only snapshots, regenerated on every pull, never synced up.
- One task = one file in tasks/ (YAML frontmatter + markdown body = the task context). Task files no longer carry the IS footer — the IS lives in its own file above.
- PULL before starting work: call pull_local_project — it returns a short-lived bundle URL + a hydrate.mjs script; write the script and run `node hydrate.mjs` to (re)write this folder. (Pass inline:true only if node is unavailable.)
- Create a task: new file tasks/TDE-<id>.md using ONLY ids from .sync.json lease/next_free_ids; stamp updated_at (ISO, UTC, now).
- Edit a task: change the file; ALWAYS re-stamp updated_at. Delete a task: delete the file and report its numeric id in deleted_short_ids on flush.
- FLUSH after each work unit: call flush_local_project with the files you changed + base_cursor from .sync.json; write any hub_wins contents back to disk and update the cursor in .sync.json.
- input / output / review in frontmatter are READ-ONLY carriage (contracts are hub ceremonies). Milestones are hub-only in v1 (not in these files). KB bodies in kb/ are READ-ONLY (author via MCP).
- Never hand-edit .sync.json. context.md and the grounding files are read-only snapshots.