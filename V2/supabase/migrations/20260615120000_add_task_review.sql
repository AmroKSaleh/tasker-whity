-- TDE-264 (TDE-261 task-level output judge): per-task review state.
-- review_enabled: opt-in flag (default OFF — no token tax on unflagged tasks).
-- review_bar: the frozen bar snapshot assembled at enable-time (jsonb { rules: [...] }).
-- review_verdict: the latest judge verdict (jsonb: overall pass/fail + per-rule + critique).
alter table tasks
  add column if not exists review_enabled boolean not null default false,
  add column if not exists review_bar      jsonb   default null,
  add column if not exists review_verdict  jsonb   default null;
