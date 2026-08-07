-- TDE-882: is_deleted was added as `boolean DEFAULT false` with no NOT NULL, so a NULL could
-- slip past an `.eq('is_deleted', false)` filter and reappear as a phantom row in any tally.
-- Backfill defensively first, then close the hole so both filter styles are safe.

UPDATE tasks    SET is_deleted = false WHERE is_deleted IS NULL;
UPDATE projects SET is_deleted = false WHERE is_deleted IS NULL;
UPDATE flows    SET is_deleted = false WHERE is_deleted IS NULL;

ALTER TABLE tasks    ALTER COLUMN is_deleted SET DEFAULT false;
ALTER TABLE projects ALTER COLUMN is_deleted SET DEFAULT false;
ALTER TABLE flows    ALTER COLUMN is_deleted SET DEFAULT false;

ALTER TABLE tasks    ALTER COLUMN is_deleted SET NOT NULL;
ALTER TABLE projects ALTER COLUMN is_deleted SET NOT NULL;
ALTER TABLE flows    ALTER COLUMN is_deleted SET NOT NULL;
