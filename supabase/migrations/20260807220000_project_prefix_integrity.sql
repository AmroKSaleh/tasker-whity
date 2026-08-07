-- TDE-822: projects.prefix had NO integrity guarantees at all — declared `text DEFAULT ''`
-- with no NOT NULL and no UNIQUE. Uniqueness was a one-time backfill plus luck, and at least
-- two creation paths could produce a prefix-less project (rest-api POST /projects set no
-- prefix; deriveProjectPrefix could return null and the insert spread it away).
--
-- Raising the length cap without fixing that would make collisions MORE likely, so both land
-- together. Order matters: normalize, repair, dedupe, THEN constrain.
--
-- New rule: 2-6 uppercase alphanumerics, unique per user (case-insensitively).

-- ── 1. Normalize case and whitespace ────────────────────────────────────────
UPDATE projects
SET prefix = UPPER(TRIM(prefix))
WHERE prefix IS NOT NULL AND prefix <> UPPER(TRIM(prefix));

-- ── 2. Named repair: the Abaq Website project has been prefix-less since creation, so its
--      22 tasks cannot be addressed as ABQ-n. Its own name states the intended prefix.
UPDATE projects
SET prefix = 'ABQ'
WHERE id = '7554862a-d5e1-43b8-aa23-fa74a6d388ca'
  AND (prefix IS NULL OR TRIM(prefix) = '');

-- ── 3. Repair every remaining row that cannot satisfy the new rule, and de-duplicate.
--      Covers empty, NULL, malformed (punctuation/length) AND duplicates. Soft-deleted
--      projects are included deliberately: they still occupy the unique index, and excluding
--      them would let a restore collide later.
DO $$
DECLARE
  r      RECORD;
  base   text;
  cand   text;
  n      int;
BEGIN
  FOR r IN
    SELECT p.id, p.name, p.user_id, p.prefix
    FROM projects p
    WHERE p.prefix IS NULL
       OR p.prefix !~ '^[A-Z0-9]{2,6}$'
       OR EXISTS (
            SELECT 1 FROM projects q
            WHERE q.user_id = p.user_id
              AND LOWER(q.prefix) = LOWER(p.prefix)
              AND q.id <> p.id
              AND (q.created_at < p.created_at OR (q.created_at = p.created_at AND q.id < p.id))
          )
    ORDER BY p.created_at, p.id
  LOOP
    -- Derive a base from the name: initials when multi-word, else the leading characters.
    SELECT UPPER(regexp_replace(COALESCE(r.name, ''), '[^A-Za-z0-9]', '', 'g')) INTO base;
    IF base IS NULL OR LENGTH(base) < 2 THEN
      base := 'PRJ';
    END IF;
    base := LEFT(base, 4);

    cand := base;
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM projects q
      WHERE q.user_id = r.user_id AND LOWER(q.prefix) = LOWER(cand) AND q.id <> r.id
    ) LOOP
      cand := LEFT(base, GREATEST(1, 6 - LENGTH(n::text))) || n::text;
      n := n + 1;
      IF n > 9999 THEN
        RAISE EXCEPTION 'Could not derive a unique prefix for project %', r.id;
      END IF;
    END LOOP;

    UPDATE projects SET prefix = cand WHERE id = r.id;
  END LOOP;
END $$;

-- ── 4. Constrain. Nothing can be born prefix-less or collide from here on.
ALTER TABLE projects ALTER COLUMN prefix DROP DEFAULT;
ALTER TABLE projects ALTER COLUMN prefix SET NOT NULL;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_prefix_format;
ALTER TABLE projects ADD CONSTRAINT projects_prefix_format
  CHECK (prefix ~ '^[A-Z0-9]{2,6}$');

DROP INDEX IF EXISTS projects_user_prefix_unique;
CREATE UNIQUE INDEX projects_user_prefix_unique
  ON projects (user_id, LOWER(prefix));
