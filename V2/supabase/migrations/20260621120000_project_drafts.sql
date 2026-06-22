-- Gated bootstrap interview (TDE): a project_drafts row holds the in-flight
-- Foundation while bootstrap_project → bootstrap_advance walks the agent through
-- the phases ELICITING → DRAFTING → BLESSING → BLESSED, one gated call at a time,
-- so the phases can't be skimmed/skipped. The project is created only from a
-- BLESSED draft. Managed by the MCP (service role); RLS scopes to the owner.
create table if not exists project_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  intent text,
  status text not null default 'eliciting',   -- eliciting | drafting | blessing | blessed | done
  brief jsonb,                                 -- the Foundation being assembled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table project_drafts enable row level security;
create policy "drafts own all" on project_drafts for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
