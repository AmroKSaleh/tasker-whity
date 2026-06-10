-- TDE-short-ids: flow short IDs (e.g. BKT-F1, or "Blog Post Flow - F3" for prefix-less projects)
-- Unique per user (global across all their flows).
-- Nullable: existing flows and emergent (unnamed) flows have no short_id.

alter table flows add column if not exists short_id text;

-- Enforce global per-user uniqueness (partial index, nulls excluded)
create unique index if not exists flows_user_short_id_idx on flows(user_id, short_id)
  where short_id is not null;
