-- TDE-311: show the connected account inside Settings → Connectors.
-- Store the email of the connected Google account for the shared grant (Drive/Gmail/Tasks)
-- and for the separate Calendar token. GitHub's login is fetched live from its token, so it
-- needs no column. Captured at connect time via the OAuth identity (openid/email) scope —
-- existing connections backfill on their next reconnect.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS google_email TEXT,
  ADD COLUMN IF NOT EXISTS gcal_email TEXT;
