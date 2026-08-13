import { supabase } from './supabase'
import { useEnvironmentStore } from '../store/useEnvironmentStore'
import { useProjectStore } from '../store/useProjectStore'

// Web-side Organization management (TDE-360). Orgs are the shared tenancy layer; the creator is
// the owner (organizations.owner_user_id), which the DB access helpers treat as full admin.

// An org whose name is blank has no useful identity in a list, so give it a visible stand-in
// rather than rendering an empty heading nobody can click or reason about.
export function orgLabel(org) {
  return org?.name?.trim() || 'n/a'
}

// The label for environments with org_id = null. This is NOT an organization — no such row
// exists — it is the absence of one. It used to read "Personal", which was indistinguishable
// from a real org and collided outright once a user named an actual org "Personal".
export const NO_ORG_LABEL = 'No organization'

async function refreshOrganizations() {
  const { data } = await supabase.from('organizations').select('id, name, owner_user_id').eq('is_deleted', false).order('created_at')
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
// caller move them out first — the same shape as the section-delete guard.
export async function deleteOrganization(id) {
  const { data: envs, error: envErr } = await supabase
    .from('environments').select('id, name').eq('org_id', id).eq('is_deleted', false)
  if (envErr) throw new Error(envErr.message)
  if (envs?.length) {
    const names = envs.map(e => e.name).join(', ')
    throw new Error(
      `This organization still owns ${envs.length} environment${envs.length === 1 ? '' : 's'} (${names}). ` +
      `Move them to "${NO_ORG_LABEL}" or another organization on the Environments page first — deleting would orphan their projects.`
    )
  }
  const { error } = await supabase.from('organizations').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
  await refreshOrganizations()
}

// What a cascade delete would take with it, counted BEFORE anything is destroyed so the
// confirmation can name real numbers rather than saying "and its contents".
export async function organizationContents(orgId) {
  const { data: envs } = await supabase.from('environments').select('id, name').eq('org_id', orgId).eq('is_deleted', false)
  const envIds = (envs ?? []).map(e => e.id)
  if (!envIds.length) return { envs: [], projects: [] }
  const { data: projects } = await supabase.from('projects')
    .select('id, name').in('environment_id', envIds).eq('is_deleted', false)
  return { envs: envs ?? [], projects: projects ?? [] }
}

// Delete an organization AND everything under it — all SOFT (TDE-885), sharing one cascade token
// so a restore revives exactly what this delete took and nothing binned earlier. Nothing is
// nulled, so environments.org_id and projects.environment_id keep pointing here and the whole
// structure survives intact. environment_grants survive too, where a hard delete cascaded them.
// This is the deliberate second choice — deleteOrganization above stays the default and refuses.
export async function deleteOrganizationWithContents(orgId) {
  const { envs, projects } = await organizationContents(orgId)
  const cascadeId = crypto.randomUUID()
  const stamp = { is_deleted: true, deleted_at: new Date().toISOString(), deleted_cascade_id: cascadeId }

  if (projects.length) {
    const { error } = await supabase.from('projects').update(stamp).in('id', projects.map(p => p.id))
    if (error) throw new Error(error.message)
  }
  if (envs.length) {
    const { error } = await supabase.from('environments').update(stamp).in('id', envs.map(e => e.id))
    if (error) throw new Error(error.message)
  }
  const { error } = await supabase.from('organizations').update(stamp).eq('id', orgId)
  if (error) throw new Error(error.message)

  const projStore = useProjectStore.getState()
  projects.forEach(p => projStore.removeProject?.(p.id))

  const envStore = useEnvironmentStore.getState()
  if (envs.some(e => e.id === envStore.activeEnvironmentId)) envStore.setActiveEnvironmentId(null)
  envStore.setEnvironments(envStore.environments.filter(e => e.org_id !== orgId))

  await refreshOrganizations()
  return { envs: envs.length, projects: projects.length }
}

// Restore an organization and everything its delete took, in dependency order.
export async function restoreOrganization(orgId) {
  const { data: org } = await supabase.from('organizations')
    .select('id, deleted_cascade_id').eq('id', orgId).maybeSingle()
  if (!org) throw new Error('Organization not found.')
  const revive = { is_deleted: false, deleted_at: null, deleted_cascade_id: null }

  await supabase.from('organizations').update(revive).eq('id', orgId)
  if (org.deleted_cascade_id) {
    await supabase.from('environments').update(revive).eq('deleted_cascade_id', org.deleted_cascade_id)
    await supabase.from('projects').update(revive).eq('deleted_cascade_id', org.deleted_cascade_id)
  }
  await refreshOrganizations()
}
