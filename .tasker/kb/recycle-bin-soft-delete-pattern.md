# Recycle Bin (Soft Delete) Pattern

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

The app uses a Recycle Bin (soft delete) pattern for Tasks, Projects, and Flows.

1. They all have an `is_deleted` (boolean) and `deleted_at` (timestamp) column.
2. Normal UI queries and MCP `list_*` tool queries MUST append `.is('is_deleted', false)` to avoid showing deleted data.
3. To delete, do NOT use `.delete()`. You must `.update({ is_deleted: true, deleted_at: new Date().toISOString() })`.
4. A `pg_cron` job in the database runs daily to permanently delete items where `is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days'`.
