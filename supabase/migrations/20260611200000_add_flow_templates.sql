-- Flow Templates (TDE-152): reusable scaffold structures for flows.
-- A template is a named sequence of task scaffolds with contracts.
-- When instantiated, scaffold placeholders ({{key}}) are filled from context.

create table if not exists flow_templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists flow_template_steps (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references flow_templates(id) on delete cascade,
  step_order      integer not null,
  title           text not null,
  detail_scaffold text,
  input_contract  jsonb,   -- { rules: [...] } — acceptance criteria for this step's input
  output_contract jsonb,   -- { rules: [...] } — definition of done for this step's output
  created_at      timestamptz not null default now()
);

create index if not exists flow_templates_user_id_idx on flow_templates(user_id);
create index if not exists flow_template_steps_template_id_idx on flow_template_steps(template_id);

-- RLS
alter table flow_templates enable row level security;
alter table flow_template_steps enable row level security;

create policy "Users manage their own flow_templates"
  on flow_templates for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users manage their own flow_template_steps"
  on flow_template_steps for all
  using (
    template_id in (select id from flow_templates where user_id = auth.uid())
  )
  with check (
    template_id in (select id from flow_templates where user_id = auth.uid())
  );
