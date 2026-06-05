-- Enable Supabase Realtime on the tables the web app already subscribes to
-- (useTasks / useProjects / useAllTasks), so MCP/other-device changes appear
-- live without a page refresh. The frontend was listening on a channel the
-- server never broadcast on because these tables weren't in the realtime
-- publication. Idempotent so it's safe to re-run.

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'sections', 'groups', 'projects']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Full row image so UPDATE/DELETE events carry enough data for RLS-filtered realtime.
alter table public.tasks    replica identity full;
alter table public.sections replica identity full;
alter table public.groups   replica identity full;
alter table public.projects replica identity full;
