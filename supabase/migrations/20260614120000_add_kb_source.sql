alter table project_knowledge
  add column if not exists source text not null default 'user'
    check (source in ('user', 'agent'));
