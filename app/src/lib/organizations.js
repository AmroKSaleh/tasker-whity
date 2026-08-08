import { supabase } from './supabase'
import { useEnvironmentStore } from '../store/useEnvironmentStore'

// Web-side Organization management (TDE-360). Orgs are the shared tenancy layer; the creator is
// the owner (organizations.owner_user_id), which the DB access helpers treat as full admin.

// An org whose name is blank has no useful identity in a list, so give it a visible stand-in
// rather than rendering an empty heading nobody can click or reason about.
export function orgLabel(org) {
  return org?.name?.trim() || 'n/a'
}

async function refreshOrganizations() {
  const { data } = await supabase.from('organizations').select('id, name, owner_user_id').order('created_at')
  useEnvironmentStore.getState().setOrganizations(data ?? [])
}

export async function createOrganization(name) {
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await supabase.from('organizations')
    .insert({ name: name.trim(), owner_user_id: user.id })
    .select().single()
  if (error) throw new Error(error.message)
  await refreshOrganizations()
  return data
}

export async function renameOrganization(id, name) {
  await supabase.from('organizations').update({ name: name.trim() }).eq('id', id)
  await refreshOrganizations()
}

// Deletion is guarded rather than cascading: an org owns environments, which own projects, so a
// cascade would silently destroy real work. Refuse while any environment remains and make the
// caller move them to Personal first — the same shape as the section-delete guard.
export async function deleteOrganization(id) {
  const { data: envs, error: envErr } = await supabase
    .from('environments').select('id, name').eq('org_id', id)
  if (envErr) throw new Error(envErr.message)
  if (envs?.length) {
    const names = envs.map(e => e.name).join(', ')
    throw new Error(
      `This organization still owns ${envs.length} environment${envs.length === 1 ? '' : 's'} (${names}). ` +
      `Move them to Personal or another organization on the Environments page first — deleting would orphan their projects.`
    )
  }
  const { error } = await supabase.from('organizations').delete().eq('id', id)
  if (error) throw new Error(error.message)
  await refreshOrganizations()
}
