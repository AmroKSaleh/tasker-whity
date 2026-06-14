-- TDE-184 (milestone 5): unattended daily sweep that auto-archives stale AGENT
-- KB entries. User entries are NEVER touched here — they surface in KB Health for
-- manual confirm. Re-running with the same job name replaces the schedule (idempotent).
-- Runs 03:00 UTC daily. Threshold: 60 days since last touch (reviewed_at or updated_at).
select cron.schedule(
  'kb-archive-stale-agent-entries',
  '0 3 * * *',
  $$
    update project_knowledge
    set archived_at = now()
    where source = 'agent'
      and archived_at is null
      and coalesce(reviewed_at, updated_at) < now() - interval '60 days'
  $$
);
