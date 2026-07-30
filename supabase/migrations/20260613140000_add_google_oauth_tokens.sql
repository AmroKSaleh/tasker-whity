-- TDE: shared Google OAuth foundation.
-- One Google connection per user, WITH a refresh token so connections persist.
-- (The existing gcal_* columns hold only a short-lived access token from the
-- browser GIS flow, which structurally can't refresh.) Scopes accumulate as the
-- user connects each service (Drive / Gmail / Tasks) via incremental consent.
alter table user_settings
  add column if not exists google_access_token  text        default null,
  add column if not exists google_refresh_token text        default null,
  add column if not exists google_token_expiry  timestamptz default null,
  add column if not exists google_scopes        text        default null;
