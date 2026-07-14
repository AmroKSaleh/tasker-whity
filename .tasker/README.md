# .tasker/ — Tasker Development (Local Mode)

This folder is the LOCAL mirror of a Tasker project. Agents: work the tasks by editing these files directly — no per-edit network calls.

- One task = one file in tasks/ (YAML frontmatter + markdown body = the task context).
- PULL before starting work: call the pull_local_project MCP tool and write every returned file verbatim.
- Create a task: new file tasks/TDE-<id>.md using ONLY ids from .sync.json lease/next_free_ids; stamp updated_at (ISO, UTC, now).
- Edit a task: change the file; ALWAYS re-stamp updated_at. Delete a task: delete the file and report its numeric id in deleted_short_ids on flush.
- FLUSH after each work unit: call flush_local_project with the files you changed + base_cursor from .sync.json; write any hub_wins contents back to disk.
- input / output / review in frontmatter are READ-ONLY carriage (contracts are hub ceremonies). Milestones are hub-only in v1 (not in these files).
- Never hand-edit .sync.json. context.md is a read-only snapshot.