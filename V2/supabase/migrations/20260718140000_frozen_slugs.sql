-- TDE-713: FROZEN SLUGS for sections and groups.
--
-- Local Mode files reference sections/groups by SLUG, and slugs were computed on
-- every pull from the NAME (sync_core.ts buildSlugMap). That makes rename impossible
-- via files: rename → slug moves → task references orphan. To support rename/delete/
-- reorder through a writable structure manifest, the slug must be a STABLE, STORED id
-- that never changes when the name changes.
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE:
--   * adds a nullable `slug` column to sections and groups,
--   * backfills each with the EXACT slug the app currently computes, so every existing
--     task→section/group reference (which resolves by computed slug today) keeps
--     resolving to the same row after the switch to stored slugs.
-- No column is dropped or rewritten. Reversible by dropping the column.
--
-- CORRECTNESS: the backfill must byte-match buildSlugMap:
--   slugify(name) = lower(name), non-[a-z0-9] runs → '-', trim leading/trailing '-',
--                   empty → 'section'
--   dedup: within a project, iterate rows in sort_order (the order every read uses),
--          appending -2, -3, … on collision.

-- ── slugify, matching sync_core.ts slugify() exactly ──
CREATE OR REPLACE FUNCTION tasker_slugify(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    NULLIF(
      -- trim leading/trailing '-' from: lower, non-alnum runs → '-'
      regexp_replace(
        regexp_replace(lower(COALESCE(p_name, '')), '[^a-z0-9]+', '-', 'g'),
        '^-+|-+$', '', 'g'
      ),
      ''
    ),
    'section'
  );
$$;

ALTER TABLE sections ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE groups   ADD COLUMN IF NOT EXISTS slug text;

-- ── backfill: replicate buildSlugMap's per-project, sort_order-ordered dedup ──
DO $$
DECLARE
  v_proj record;
  v_row  record;
  v_used text[];
  v_base text;
  v_slug text;
  v_n    int;
BEGIN
  -- SECTIONS
  FOR v_proj IN SELECT DISTINCT project_id FROM sections LOOP
    v_used := ARRAY[]::text[];
    FOR v_row IN
      SELECT id, name FROM sections
      WHERE project_id = v_proj.project_id
      ORDER BY sort_order NULLS LAST, id  -- deterministic; mirrors read order (.order('sort_order'))
    LOOP
      v_base := tasker_slugify(v_row.name);
      v_slug := v_base;
      v_n := 2;
      WHILE v_slug = ANY(v_used) LOOP
        v_slug := v_base || '-' || v_n;
        v_n := v_n + 1;
      END LOOP;
      v_used := array_append(v_used, v_slug);
      UPDATE sections SET slug = v_slug WHERE id = v_row.id;
    END LOOP;
  END LOOP;

  -- GROUPS
  FOR v_proj IN SELECT DISTINCT project_id FROM groups LOOP
    v_used := ARRAY[]::text[];
    FOR v_row IN
      SELECT id, name FROM groups
      WHERE project_id = v_proj.project_id
      ORDER BY sort_order NULLS LAST, id
    LOOP
      v_base := tasker_slugify(v_row.name);
      v_slug := v_base;
      v_n := 2;
      WHILE v_slug = ANY(v_used) LOOP
        v_slug := v_base || '-' || v_n;
        v_n := v_n + 1;
      END LOOP;
      v_used := array_append(v_used, v_slug);
      UPDATE groups SET slug = v_slug WHERE id = v_row.id;
    END LOOP;
  END LOOP;
END $$;

-- New rows created without an explicit slug get one from the name as a safety net
-- (create-by-reference sets it explicitly; this covers web-app inserts). Uniqueness
-- of slug WITHIN a project is enforced application-side (the manifest apply + the
-- create-by-reference path both dedup) — no DB unique constraint, to avoid blocking
-- transient dup states mid-flush.
