-- Org access-check helpers (TDE-359 Step 2a). ADDITIVE: new functions only, no policy changes.
-- SECURITY DEFINER so they read the membership/grant tables WITHOUT triggering RLS — this both
-- avoids infinite recursion when they're used inside RLS policies, and lets them see the rows
-- they need to judge access. Each has an explicit-uid variant (unit-testable) + an auth.uid()
-- wrapper (used by policies + the app).
-- Semantics (locked TDE-302/359): personal env = owner only. Org env = org admin/owner sees all;
-- a plain member sees ONLY environments they hold an explicit grant for. Membership ≠ access.

create or replace function is_org_admin(p_org uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations o where o.id = p_org and o.owner_user_id = p_uid)
      or exists (select 1 from organization_members m
                 where m.org_id = p_org and m.user_id = p_uid and m.role = 'admin' and m.status = 'active');
$$;
create or replace function is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_org_admin(p_org, auth.uid());
$$;

create or replace function is_org_member(p_org uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations o where o.id = p_org and o.owner_user_id = p_uid)
      or exists (select 1 from organization_members m
                 where m.org_id = p_org and m.user_id = p_uid and m.status = 'active');
$$;
create or replace function is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_org_member(p_org, auth.uid());
$$;

create or replace function can_access_environment(p_env uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from environments e where e.id = p_env and (
      (e.org_id is null and e.user_id = p_uid)
      or (e.org_id is not null and (
        is_org_admin(e.org_id, p_uid)
        or exists (select 1 from environment_grants g where g.environment_id = e.id and g.user_id = p_uid)
      ))
    )
  );
$$;
create or replace function can_access_environment(p_env uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_access_environment(p_env, auth.uid());
$$;

create or replace function can_access_project(p_proj uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from projects p where p.id = p_proj and (
      p.user_id = p_uid
      or (p.environment_id is not null and can_access_environment(p.environment_id, p_uid))
    )
  );
$$;
create or replace function can_access_project(p_proj uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_access_project(p_proj, auth.uid());
$$;
