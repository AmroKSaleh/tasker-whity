# {architecture} Task short-ID collision fix — advisory lock in trigger

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Problem
`assign_task_short_id()` trigger used a plain `SELECT MAX(short_id)` with no locking. Two concurrent sessions both read the same MAX and both inserted with the same next number — silent data corruption. Confirmed by a live collision report (WC-233 taken by two sessions simultaneously).

## Fix (migration 20260624140000_atomic_task_short_id.sql)
Added `pg_advisory_xact_lock(hashtext(NEW.project_id::text))` inside the trigger before the MAX query. The lock is exclusive and transaction-scoped, so concurrent inserts for the same project queue up. Different projects don't block each other.

## Why no unique index
A unique index on (project_id, short_id) was attempted but blocked by existing duplicate rows from past collisions. The advisory lock prevents future collisions. The unique index can be added later after deduplicating historical data.

## Flow short_ids
Flow short_ids (PREFIX-FN format) are assigned in application code (MCP), not via a DB trigger. There is already a unique index on (user_id, short_id) for flows — concurrent flow creation fails with a unique constraint violation rather than silently colliding. No additional fix needed for flows.
