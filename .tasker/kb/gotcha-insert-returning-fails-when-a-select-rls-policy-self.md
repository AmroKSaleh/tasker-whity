# Gotcha: INSERT…RETURNING fails when a SELECT RLS policy self-references the table via a STABLE fn

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Bug (TDE-360, 2026-07-05): "Create Organization" failed silently. The org INSERT succeeded, but the client's `.insert().select()` (INSERT … RETURNING) was rejected with "new row violates row-level security policy for organizations".

Root cause: the organizations SELECT policy was `is_org_member(id)` — a STABLE SECURITY DEFINER function that looks the org up IN the organizations table. During INSERT … RETURNING, RLS applies the SELECT policy to the returned row, but the STABLE function evaluates against the statement's pre-insert snapshot and CANNOT see the row the same statement just inserted → returns false → row rejected.

Fix (migration 20260705130000): make the SELECT policy check the new row's own column directly first — `owner_user_id = auth.uid() OR is_org_member(id)`. A column-level check on the NEW row needs no table lookup, so the creator can always read back their insert. Verified via role-impersonation (`set local role authenticated` + `set local request.jwt.claims`) that insert+returning now works.

LESSON: any RLS SELECT policy used on a table that receives `.insert().select()` must be satisfiable from the NEW ROW's own columns — do NOT rely solely on a function that re-queries the same table for the just-inserted id. Environments/projects avoided this because their policy is `user_id = auth.uid() OR can_access_*` (direct column first). Debugging technique that nailed it: reproduce under the authenticated role with `set local role authenticated; set local "request.jwt.claims"='{"sub":"<uid>","role":"authenticated"}';` then try insert with vs without RETURNING.
