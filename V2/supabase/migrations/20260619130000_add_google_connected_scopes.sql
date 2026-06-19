-- Per-service Google connection independence.
-- google_scopes = the raw grant Google returns (one shared grant per app, may
-- accumulate via incremental auth). google_connected_scopes = the scopes the USER
-- explicitly connected — this drives the per-service UI + per-service disconnect,
-- so connecting/disconnecting Gmail doesn't visibly touch Drive/Tasks.
alter table user_settings
  add column if not exists google_connected_scopes text default null;
