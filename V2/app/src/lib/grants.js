import { supabase } from './supabase'

// Per-environment access grants for org members (TDE-359/361 follow-up). RLS on
// environment_grants already restricts writes to org admins (is_org_admin(env_org(...))), so the
// client can hit the table directly — no RPC needed here (unlike organization_members, which is
// deny-all and requires the accept_org_invitation RPC).
//
// v1 simplification (locked in the org-layer design): any grant = full read+write to that
// environment's data. role is stored for future refinement but not write-enforced yet, so this
// UI always writes role: 'editor' and treats a grant as a plain boolean toggle.

export async function listGrantsForEnvIds(envIds) {
  if (!envIds.length) return []
  const { data, error } = await supabase.from('environment_grants')
    .select('environment_id, user_id, role')
    .in('environment_id', envIds)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function grantEnvironmentAccess(environmentId, userId) {
  const { error } = await supabase.from('environment_grants')
    .upsert({ environment_id: environmentId, user_id: userId, role: 'editor' }, { onConflict: 'environment_id,user_id' })
  if (error) throw new Error(error.message)
}

export async function revokeEnvironmentAccess(environmentId, userId) {
  const { error } = await supabase.from('environment_grants')
    .delete().eq('environment_id', environmentId).eq('user_id', userId)
  if (error) throw new Error(error.message)
}
