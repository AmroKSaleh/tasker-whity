# Database: suppressing the tasks.updated_at touch — why passing the old value back does not work

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

The `touch_tasks_updated_at` trigger (added 20260714213000 for Local Mode LWW) decides whether to stamp `now()` with:

```sql
if new.updated_at is not distinct from old.updated_at then
  new.updated_at := now();
end if;
```

**The gotcha:** the intent was "only stamp when the writer did not set updated_at itself", but the test cannot distinguish *unset* from *set to the same value*. Re-sending the identical old timestamp is `not distinct`, so it gets stamped anyway. Any code that tries to preserve updated_at by reading it and writing it back will silently fail.

**The fix (20260730120000):** a transaction-local GUC. The trigger early-returns when `current_setting('tasker.suppress_touch', true) = 'on'`, and `autostart_task(p_task_id, p_user_id)` calls `set_config('tasker.suppress_touch','on',true)` before its UPDATE. `is_local = true` scopes the flag to the transaction, so it cannot leak across pooled connections. Reuse this pattern for any future write that changes a task without being an edit.

**Why it mattered:** `get_task` auto-flips a pending task to in_progress, which is an UPDATE, which stamped updated_at. Reading a task overwrote its own last-edit time; surveying N tasks restamped all N as edited-just-now. `updated_at` was invisible outside sync code, so this went unnoticed until it was surfaced as "Last edited" in get_task / list_tasks.

**How to verify a preservation fix without waiting a day:** date-granularity display cannot prove anything within one day. Create two throwaway tasks A then B, sort by `updated_at desc` (B above A), read A, and re-sort — if A jumps above B the write still bumped it. Ordering is timestamp-precise even when the rendered dates are identical.

**Related:** the flip is still auditable — `recordLifecycleChange` records it (TDE-819). Suppressing the touch removes only the claim that the task's *content* changed.

