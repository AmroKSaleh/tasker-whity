-- Org member invitations (TDE-361, org-layer slice 2).
-- Flow: an org admin creates an invitation (email + role) → a link /invite/<token> → the invitee
-- opens it, signs in or signs up, and accepts → an organization_members row is created.
-- The invitation ROW is the pending state (keyed by email, not a user we don't have yet); the
-- membership is created only at accept time, when a real user_id exists. This one mechanism
-- serves both "already on Tasker" (signed in, accepts immediately) and "not on Tasker" (signs up,
-- then the same token accepts). Env-access grants are managed separately (later), not at invite.
--
-- Email delivery is deferred (copy-link MVP): the admin copies the link and sends it however they
-- want. Swapping in a transactional sender (Resend) later changes only the last mile, not this.

create extension if not exists pgcrypto;

create table if not exists organization_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member',                       -- 'admin' | 'member'
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'pending',                    -- 'pending' | 'accepted' | 'revoked'
  invited_by uuid not null references auth.users(id) on delete cascade,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz
);
alter table organization_invitations enable row level security;

create index if not exists org_invitations_org_idx   on organization_invitations(org_id);
create index if not exists org_invitations_token_idx on organization_invitations(token);

-- Admins manage their org's invitations. Invitees NEVER read this table directly — they go
-- through the SECURITY DEFINER preview/accept RPCs — so there is deliberately no invitee SELECT
-- policy (the token is a bearer secret, not something to expose via a table read).
create policy org_inv_select on organization_invitations
  for select using (is_org_admin(org_id));
create policy org_inv_insert on organization_invitations
  for insert with check (is_org_admin(org_id) and invited_by = auth.uid());
create policy org_inv_update on organization_invitations
  for update using (is_org_admin(org_id));
create policy org_inv_delete on organization_invitations
  for delete using (is_org_admin(org_id));

-- Admins can remove members; a member can remove themselves (leave). The owner isn't stored in
-- organization_members (tracked via organizations.owner_user_id), so they can't be removed here.
create policy org_members_delete on organization_members
  for delete using (is_org_admin(org_id) or user_id = auth.uid());

-- Preview an invitation by token WITHOUT authentication, so a logged-out invitee can see which
-- org they've been invited to before signing in. Returns only low-sensitivity display fields.
create or replace function preview_org_invitation(p_token text)
returns table (org_name text, email text, role text, status text, expired boolean)
language sql stable security definer set search_path = public as $$
  select o.name, i.email, i.role, i.status, (i.expires_at < now())
  from organization_invitations i
  join organizations o on o.id = i.org_id
  where i.token = p_token;
$$;
grant execute on function preview_org_invitation(text) to anon, authenticated;

-- Accept an invitation: validate the token, create the membership, mark the invite accepted.
-- SECURITY DEFINER so the invitee (not yet a member, so blocked by the deny-all RLS on
-- organization_members) can create their own membership row through this controlled path only.
-- Returns the org_id on success; raises a descriptive error otherwise.
create or replace function accept_org_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv organization_invitations;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select * into inv from organization_invitations where token = p_token;
  if inv.id is null then raise exception 'Invitation not found'; end if;
  if inv.status <> 'pending' then raise exception 'This invitation is no longer valid'; end if;
  if inv.expires_at < now() then raise exception 'This invitation has expired'; end if;

  insert into organization_members (org_id, user_id, role, status)
  values (inv.org_id, uid, inv.role, 'active')
  on conflict (org_id, user_id) do nothing;

  update organization_invitations
    set status = 'accepted', accepted_by = uid, accepted_at = now()
    where id = inv.id;

  return inv.org_id;
end;
$$;
grant execute on function accept_org_invitation(text) to authenticated;

-- List an org's people with their emails. Clients can't query auth.users, so this SECURITY
-- DEFINER function joins it, guarded by is_org_member (only people in the org can see the roster).
-- Includes the owner (who has no organization_members row) via a union.
create or replace function list_org_members(p_org uuid)
returns table (user_id uuid, email text, role text, status text, is_owner boolean, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  with people as (
    select owner_user_id as uid, 'admin'::text as role, 'active'::text as status,
           true as is_owner, created_at as joined_at
    from organizations where id = p_org
    union all
    select user_id, role, status, false, created_at
    from organization_members
    where org_id = p_org
      and user_id <> (select owner_user_id from organizations where id = p_org)
  )
  select p.uid, u.email::text, p.role, p.status, p.is_owner, p.joined_at
  from people p join auth.users u on u.id = p.uid
  where is_org_member(p_org)
  order by p.is_owner desc, p.joined_at;
$$;
grant execute on function list_org_members(uuid) to authenticated;
