# Database: soft delete + unfiltered tallies — the recycle bin leaks into every count

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Soft delete + unfiltered tallies (TDE-882, 2026-08-07)

## The shape of the bug — expect it again

`delete_task` is a SOFT delete: it sets `is_deleted = true` and `deleted_at`, and **the row keeps its `section_id`, `group_id`, `phase_id` and `project_id`**. So a recycle-binned task still looks like a member of its section/group/phase to any query that does not explicitly filter it out.

`list_tasks` filtered it. Thirteen other read sites did not. That is the whole bug.

**Any new query that counts, groups, or lists tasks must filter `is_deleted`.** There is no DB-level protection and nothing will fail loudly — the number is just quietly wrong.

## What it actually broke

- Section counts on `list_sections` were inflated by however many deleted tasks the section held.
- `delete_section`'s guard counted deleted rows, so a section that was empty by every readable measure **could not be deleted** — the guard was protecting rows already in the bin.
- `list_phases` had the identical defect (dormant only because no phases existed yet).
- `findSimilarTasks` could refuse to create a new task as a duplicate **of a deleted one**.
- `rank_tasks`, `get_project`, `list_groups`, `list_projects` progress, and both section-analysis tools all surfaced or counted deleted work.

## Why nobody noticed for a week at a time

A pg_cron job purges soft-deleted rows after 7 days (migration `20260801153600_add_recycle_bin.sql`). So wrong counts **self-heal within a week** and then come back the next time something is deleted. Intermittent-and-self-correcting is why this survived.

## The NULL trap

`is_deleted` was originally `boolean DEFAULT false` with **no NOT NULL**. A NULL value slips past `.eq('is_deleted', false)` and reappears as a phantom. Migration `20260807210000_is_deleted_not_null.sql` backfills and sets NOT NULL on `tasks`, `projects` and `flows`, so either filter style is now safe. Prefer `.is('is_deleted', false)` for consistency with `list_tasks`.

## Deliberately still unfiltered — these need a decision, not a patch

- **`exportProjectBundle`** still includes deleted tasks. Genuine question: should a "full-fidelity portable bundle" carry the recycle bin? If it should not, note that import must also not resurrect them as live tasks.
- **Local Mode pull/flush task reads** (the two `local_rev` selects) have their own tombstone protocol; changing them blind risks breaking sync semantics.

## Related behaviour change

`delete_section` with `delete_tasks: true` used to run a HARD `.delete()`, bypassing the recycle bin with no undo — while the tool's own refusal message actively suggested passing that flag. It now soft-deletes, matching `delete_task`.

