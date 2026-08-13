-- Org RLS policies (TDE-359 Step 2b). Rewrites existing owner-only policies to "owner OR
-- org-granted", and adds policies to the 3 new org tables. SAFE TO APPLY NOW: there is no org
-- data in prod, so for every existing (personal) user the `user_id = auth.uid()` branch is
-- unchanged and the `can_access_*` branch returns false — access is provably identical until
-- real org data exists. can_access_* are proven correct (12/12 truth-table test, 2026-07-05).
-- v1 SIMPLIFICATION: any environment_grant = full read+write to that env's data. The grant.role
-- (viewer/editor/admin) is stored but NOT yet enforced at write-level — a later refinement.

-- ── extra SECURITY DEFINER helpers (RLS-free lookups used inside policies) ──
create or replace function env_org(p_env uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from environments where id = p_env;
$$;

create or replace function can_access_task(p_task uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tasks t where t.id = p_task
      and (t.user_id = p_uid or can_access_project(t.project_id, p_uid))
  );
$$;
create or replace function can_access_task(p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_access_task(p_task, auth.uid());
$$;

-- ── new tables: organizations / organization_members / environment_grants ──
drop policy if exists "org select" on organizations;
create policy "org select" on organizations for select using (is_org_member(id));
drop policy if exists "org insert" on organizations;
create policy "org insert" on organizations for insert with check (owner_user_id = auth.uid());
drop policy if exists "org update" on organizations;
create policy "org update" on organizations for update using (is_org_admin(id)) with check (is_org_admin(id));
drop policy if exists "org delete" on organizations;
create policy "org delete" on organizations for delete using (owner_user_id = auth.uid());

drop policy if exists "members select" on organization_members;
create policy "members select" on organization_members for select using (is_org_member(org_id));
drop policy if exists "members insert" on organization_members;
create policy "members insert" on organization_members for insert with check (is_org_admin(org_id));
drop policy if exists "members update" on organization_members;
create policy "members update" on organization_members for update using (is_org_admin(org_id)) with check (is_org_admin(org_id));
drop policy if exists "members delete" on organization_members;
create policy "members delete" on organization_members for delete using (is_org_admin(org_id));

drop policy if exists "grants select" on environment_grants;
create policy "grants select" on environment_grants for select
  using (user_id = auth.uid() or is_org_admin(env_org(environment_id)));
drop policy if exists "grants insert" on environment_grants;
create policy "grants insert" on environment_grants for insert with check (is_org_admin(env_org(environment_id)));
drop policy if exists "grants update" on environment_grants;
create policy "grants update" on environment_grants for update using (is_org_admin(env_org(environment_id)));
drop policy if exists "grants delete" on environment_grants;
create policy "grants delete" on environment_grants for delete using (is_org_admin(env_org(environment_id)));

-- ── rewrite existing owner-only policies → owner OR org-granted ──
drop policy if exists "environments own all" on environments;
create policy "environments access" on environments for all
  using (user_id = auth.uid() or can_access_environment(id))
  with check (user_id = auth.uid() or can_access_environment(id));

drop policy if exists "users_own_projects" on projects;
create policy "projects access" on projects for all
  using (user_id = auth.uid() or can_access_project(id))
  with check (user_id = auth.uid() or can_access_project(id));

drop policy if exists "users_own_sections" on sections;
create policy "sections access" on sections for all
  using (can_access_project(project_id)) with check (can_access_project(project_id));

drop policy if exists "users_own_groups" on groups;
create policy "groups access" on groups for all
  using (can_access_project(project_id)) with check (can_access_project(project_id));

drop policy if exists "users_own_tasks" on tasks;
create policy "tasks access" on tasks for all
  using (user_id = auth.uid() or can_access_project(project_id))
  with check (user_id = auth.uid() or can_access_project(project_id));

drop policy if exists "users_own_discussions" on task_discussions;
create policy "discussions access" on task_discussions for all
  using (user_id = auth.uid() or can_access_task(task_id))
  with check (user_id = auth.uid() or can_access_task(task_id));

drop policy if exists "Users manage own task statuses" on task_statuses;
create policy "task_statuses access" on task_statuses for all
  using (can_access_task(task_id)) with check (can_access_task(task_id));

drop policy if exists "Users can manage their own KB entries" on project_knowledge;
create policy "project_knowledge access" on project_knowledge for all
  using (user_id = auth.uid() or can_access_project(project_id))
  with check (user_id = auth.uid() or can_access_project(project_id));

drop policy if exists "Users manage own project statuses" on project_statuses;
create policy "project_statuses access" on project_statuses for all
  using (user_id = auth.uid() or can_access_project(project_id))
  with check (user_id = auth.uid() or can_access_project(project_id));

drop policy if exists "own project_instructions" on project_instructions;
create policy "project_instructions access" on project_instructions for all
  using (user_id = auth.uid() or can_access_project(project_id))
  with check (user_id = auth.uid() or can_access_project(project_id));
