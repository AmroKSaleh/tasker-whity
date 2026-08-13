# Phases: condition-bounded stages — model, UI rules, and the bulk-write path (TDE-804)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## The model

A **phase** is a project stage bounded by an **exit condition**, not a date. `due_date` is nullable decoration. That single property is what makes it a distinct primitive rather than a sprint: a sprint/cycle ends when the calendar says so and repeats uniformly; a phase ends when a condition is met, doesn't repeat, and each one has a different goal. Cycles (TDE-785) are NOT a substitute — different question, and that task should close as already-covered per its own next step.

`exit_condition` is the honesty guardrail, and both the MCP and the modal nag when it's missing. Reason: phases motivate legitimately when they **reduce committed scope** and deceptively when they merely **re-slice the same scope**. Writing "ends when X" forces a statement of what's actually required. Without it you get three buckets and an even distribution that changes nothing but the readout.

Schema: `phases` (name, sort_order, exit_condition, nullable due_date, forward-compat slug) + `tasks.phase_id` (nullable, ON DELETE SET NULL) + `projects.active_phase_id`. The active pointer is a **column on the project, not an `is_active` boolean on phases** — one column can't represent "two phases active", where a boolean needs a partial unique index for the same invariant. Mirrors `user_settings.active_environment_id`.

## Unphased is a permanent state, not a triage queue

`phase_id` is nullable with **no auto-stamping and no backfill**. A wrongly-stamped task lies; an unstamped one honestly admits it's unsorted — and plenty of work legitimately belongs to no stage (idea inventories, evergreen items). An earlier default-inherit design was rejected for this reason.

The consequence that *must* be handled: phase views hide unphased tasks entirely, so without countermeasures an unphased launch-blocker becomes invisible on every surface. Three places prevent that:
- the whole-project bar carries an explicit **unphased segment** (never a silent residual — omitting it recreates the TDE-806 two-denominators bug exactly);
- cards show an UNPHASED marker on the whole-project view of a phased project;
- `get_ready_work` keeps unphased tasks **regardless of phase scope**, ranked last.

## The get_ready_work empty-queue trap (nearly shipped)

`get_ready_work` returns early with "Nothing to do" on an empty queue. Adding phase scoping made that fire when *the scope* emptied it — reporting no work while handed-over tasks sat in another phase. The early-return path now names the phase and the hidden count. **Any future filter added to that tool needs the same treatment**; the partition is done in JS rather than SQL precisely so the response can report what it withheld.

## UI rules

- **Phase scoping rides the `boardTasks` memo in ProjectBoard**, the same choke point as the flow filter. Columns, Pulse %, filter pill counts, section x/y and the Now Band all re-scope together. Do not add a second filtering site — divergent denominators is what TDE-806 was.
- **Navigation is the disclosure mechanism.** Entering a phase *is* the split; there is no click-to-expand bar state. A `viewingPhaseId` of `'unphased'` is a valid view but not a phase.
- **Tints are hue shifts at constant luminance** (`--phase-tint-1..5`, both themes). Every text colour is contrast-tuned against paper's luminance (TDE-353), so shifting *lightness* would silently break legibility. Five max, then the badge carries identity. No whole-project recolour — that collides with Environment colour. The unphased view gets no tint (a wash implies a stage).
- PhaseBar **replaces** the 36px header readout when phases exist rather than sitting beside it. A project with zero phases renders identically to before — the feature is opt-in per project.

## Gotcha: bulk data writes from the CLI

`supabase/.temp/pooler-url` contains a username but **no password**, so a direct `pg`/psql connection fails with `SASL: client password must be a string`. The working path is **`npx supabase db query --linked`** (Management API, no local DB password). Use `--file <path>` rather than an inline string — a PowerShell here-string arrives mangled and errors as `syntax error at end of input`.

For per-row randomness in one statement, use a **correlated** subquery — referencing the outer row is what forces re-evaluation per row:
```sql
update tasks t set phase_id =
  (select id from phases where project_id = t.project_id order by random() limit 1)
where t.project_id = $1 and t.flow_id is null;
```
An uncorrelated subquery picks once and assigns every row the same value.

