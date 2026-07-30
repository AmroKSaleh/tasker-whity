-- Flow stop signal (TDE-384). A durable, human-set halt that agents must honor. Gates check
-- output QUALITY; this checks human INTENT ("I changed my mind mid-flow") — which today has no
-- mechanism, so an agent just barrels on. While set, the flow tools refuse to proceed and return
-- the reason; clearing it resumes exactly where things stood (guide_cursor untouched). Additive.
alter table flows add column if not exists stop_requested boolean not null default false;
alter table flows add column if not exists stop_reason text;
alter table flows add column if not exists stopped_at timestamptz;
