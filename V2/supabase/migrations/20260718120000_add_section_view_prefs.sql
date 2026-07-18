-- Per-section view preferences (TDE-403): each section remembers its own sort mode,
-- direction, and status filter, persisted so they follow the project across devices.
-- Shape: { "sort": "manual|priority|due|created|status", "dir": "asc|desc", "status": "pending|all" }
-- Nullable with no default — a null (or missing key) means "inherit the current default"
-- (manual sort_order, pending-only), so every existing section keeps today's behavior until
-- the user changes it. The UI fills in defaults on read; we do not backfill.
alter table sections
  add column if not exists view_prefs jsonb;
