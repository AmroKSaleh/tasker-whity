# Migrations: a bare UPDATE on tasks silently wipes updated_at — wrap maintenance writes in suppress_touch

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Learned the expensive way on 2026-08-06, during TDE-875.

**The rule.** Any `UPDATE` against `tasks` that is MAINTENANCE rather than a real edit — a backfill, a repair, a column migration — must open with:

```sql
select set_config('tasker.suppress_touch', 'on', true);
```

Without it, `touch_tasks_updated_at` fires BEFORE UPDATE and stamps `now()` onto `updated_at` for every row touched, because the trigger's condition is `new.updated_at is not distinct from old.updated_at` and a maintenance UPDATE never sets that column. A backfill over the whole table therefore reports every task as "edited just now."

**What it cost.** Two TDE-875 migrations each ran a bare `update tasks set …`. The first touched every row. Result: `updated_at` — a field users read as "Last edited" in `get_task` and sort by via `list_tasks(sort: recently_updated)` — was destroyed database-wide in one command.

The irony worth remembering: `20260730120000` exists *specifically* to stop this, and its own comment reads *"A survey of N tasks restamped all N as edited-just-now."* It added `tasker.suppress_touch` for the read path (get_task's autostart). The lesson had been learned and written down; it just wasn't generalised from reads to writes. **When a guard exists for one caller, ask what other callers have the same shape before assuming you aren't one of them.**

**Recovery, and why it worked — a pattern worth reusing.** The first migration happened to compute `detail_updated_at = greatest(updated_at, created_at)`. A SET expression reads pre-UPDATE values, so it captured the true `updated_at` a moment before the trigger overwrote it, and the second migration didn't disturb it. Repair in `20260806143000` restored `updated_at = detail_updated_at` for every row with a real body, verified against timestamps captured earlier in the same session (TDE-873 → 2026-08-06 10:59, TDE-381 → 2026-08-04 22:27, TDE-810 → 2026-07-27 18:19 — all exact).

Two things this depended on, neither of them planned: the destroyed value had been incidentally copied elsewhere first, and the recovery ran before any task's next body edit overwrote the copy. **Do not count on either next time — a destructive migration on a read surface is normally unrecoverable.**

Not recovered: tasks with an empty `detail`, where the same expression stored `created_at` rather than the lost timestamp. Those keep the wrong stamp; they were deliberately not given a second invented value.

**Also true of the repair itself:** setting `updated_at` explicitly already defeats the trigger, since `new` then differs from `old`. The repair still sets `suppress_touch` — relying on values happening to differ is the reasoning that caused the incident, and the flag states intent instead of depending on a coincidence.

