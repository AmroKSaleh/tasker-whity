-- Environment badge color (TDE-358): let the user pick a color per Environment, shown on the
-- Today per-item badge (TDE-357) and the switcher. Nullable — when null the UI falls back to a
-- color deterministically derived from the environment id (envColorFor), so existing
-- Environments keep their current look until the user explicitly picks one. No backfill needed.
alter table environments
  add column if not exists color text;
