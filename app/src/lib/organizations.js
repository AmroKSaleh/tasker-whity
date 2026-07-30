import { supabase } from './supabase'
import { useEnvironmentStore } from '../store/useEnvironmentStore'

// Web-side Organization management (TDE-360). Orgs are the shared tenancy layer; the creator is
// the owner (organizations.owner_user_id), which the DB access helpers treat as full admin.
// Deletion is intentionally omitted for v1 (heavy + would orphan org projects) — add later
// behind an explicit, well-guarded flow.

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
