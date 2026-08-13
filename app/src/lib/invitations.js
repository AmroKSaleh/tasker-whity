import { supabase } from './supabase'

// Web-side org member management (TDE-361). Invitations are copy-link for v1: creating one returns
// a token; the admin shares the /invite/<token> URL however they want. Membership is created only
// when the invitee accepts (via the accept_org_invitation RPC, server-side). Emails come back from
// list_org_members (a SECURITY DEFINER RPC) since clients can't read auth.users directly.

export function inviteUrl(token) {
  return `${window.location.origin}/invite/${token}`
}

export async function createInvitation(orgId, email, role = 'member') {
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await supabase.from('organization_invitations')
    .insert({ org_id: orgId, email: email.trim().toLowerCase(), role, invited_by: user.id })
    .select('id, email, role, token, status, created_at')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listInvitations(orgId) {
  const { data } = await supabase.from('organization_invitations')
    .select('id, email, role, token, status, created_at, expires_at')
    .eq('org_id', orgId).eq('status', 'pending')
    .order('created_at', { ascending: false })
  return data ?? []
}

export async function revokeInvitation(id) {
  const { error } = await supabase.from('organization_invitations').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function listOrgMembers(orgId) {
  const { data, error } = await supabase.rpc('list_org_members', { p_org: orgId })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function removeMember(orgId, userId) {
  const { error } = await supabase.from('organization_members')
    .delete().eq('org_id', orgId).eq('user_id', userId)
  if (error) throw new Error(error.message)
}

// Returns the org_id on success. Requires an authenticated session (auth.uid() inside the RPC).
export async function acceptInvitation(token) {
  const { data, error } = await supabase.rpc('accept_org_invitation', { p_token: token })
  if (error) throw new Error(error.message)
  return data
}

export async function previewInvitation(token) {
  const { data, error } = await supabase.rpc('preview_org_invitation', { p_token: token })
  if (error) throw new Error(error.message)
  return data?.[0] ?? null
}
