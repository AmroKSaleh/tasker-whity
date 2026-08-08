-- TDE-885: soft-delete environments and organizations.
--
-- Why this makes "restore exactly as it was" possible at all: hard deletion destroys MEMBERSHIP,
-- not just the container. projects.environment_id is ON DELETE SET NULL, so hard-deleting an
-- environment permanently forgets which projects lived in it, and no restore can reconstruct
-- that. Soft deletion never nulls the pointer, so every FK still resolves and placement survives.
-- environment_grants likewise survive, where a hard delete would cascade them away.

ALTER TABLE environments  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE environments  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Rows removed by one cascade share a token, so a restore revives exactly what that cascade took.
-- Without it, restoring an environment would also resurrect projects the user had binned earlier
-- and separately — which is not "as they were".
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_cascade_id uuid;
ALTER TABLE environments  ADD COLUMN IF NOT EXISTS deleted_cascade_id uuid;
ALTER TABLE projects      ADD COLUMN IF NOT EXISTS deleted_cascade_id uuid;

CREATE INDEX IF NOT EXISTS environments_is_deleted_idx      ON environments(is_deleted);
CREATE INDEX IF NOT EXISTS organizations_is_deleted_idx     ON organizations(is_deleted);
CREATE INDEX IF NOT EXISTS environments_cascade_idx         ON environments(deleted_cascade_id);
CREATE INDEX IF NOT EXISTS organizations_cascade_idx        ON organizations(deleted_cascade_id);
CREATE INDEX IF NOT EXISTS projects_cascade_idx             ON projects(deleted_cascade_id);

-- RLS: the existing policies filter on ownership/membership, not on is_deleted, so a soft-deleted
-- row stays readable by its owner — which is required, otherwise the Recycle Bin could not show
-- it. Visibility is enforced in the queries, exactly as it already is for tasks and projects.

-- Replace the 7-day purge so it also clears environments and organizations.
-- ORDER IS LOAD-BEARING: purging an organization first cascades its environments away
-- (environments.org_id is ON DELETE CASCADE), which would null environment_id on any project not
-- yet purged and silently return it to the board as Unassigned. Projects first, then
-- environments, then organizations.
SELECT cron.unschedule('recycle_bin_cleanup');
SELECT cron.schedule('recycle_bin_cleanup', '0 0 * * *', $$
  DELETE FROM tasks         WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM projects      WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM flows         WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM environments  WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
  DELETE FROM organizations WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '7 days';
$$);
