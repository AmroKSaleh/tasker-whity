-- Bugfix (TDE-360): creating an organization failed silently. Root cause: the organizations
-- SELECT policy was `is_org_member(id)`, a STABLE function that looks the org up in the table.
-- During INSERT ... RETURNING (the client's .insert().select()), that function evaluates against
-- the pre-insert snapshot and cannot see the just-inserted row → returns false → the row is
-- rejected as "violates row-level security". Fix: check the row's own owner_user_id column
-- directly first (no table lookup), so a creator can always read back their new org. The
-- is_org_member(id) branch still covers non-owner members reading existing orgs.
drop policy if exists "org select" on organizations;
create policy "org select" on organizations for select
  using (owner_user_id = auth.uid() or is_org_member(id));
