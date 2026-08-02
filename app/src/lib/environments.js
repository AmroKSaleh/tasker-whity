import { supabase } from './supabase'
import { useEnvironmentStore } from '../store/useEnvironmentStore'
import { useProjectStore } from '../store/useProjectStore'

// Web-side Environment management (TDE-358). Mirrors the MCP environment tools (TDE-355) but
// writes directly via supabase, the same pattern the app uses for projects. Every mutation
// refreshes the Environment store so the switcher + badges reflect changes immediately.

async function refreshEnvironments() {
  // No user_id filter: RLS returns personal + accessible org envs.
  const { data } = await supabase
    .from('environments').select('id, name, sort_order, color, org_id')
    .order('sort_order')
  useEnvironmentStore.getState().setEnvironments(data ?? [])
}

// orgId null → personal environment; set → org-owned (shared, access-controlled). The creator
// is recorded as user_id either way (satisfies the not-null column + owner-path access).
export async function createEnvironment(name, color, orgId = null) {
  const { data: { user } } = await supabase.auth.getUser()
  const envs = useEnvironmentStore.getState().environments
  const sortOrder = envs.reduce((m, e) => Math.max(m, e.sort_order ?? 0), -1) + 1
  const { data, error } = await supabase.from('environments')
    .insert({ user_id: user.id, name: name.trim(), color: color ?? null, sort_order: sortOrder, org_id: orgId })
    .select().single()
  if (error) throw new Error(error.message)
  await refreshEnvironments()
  return data
}

export async function updateEnvironment(id, updates) {
  await supabase.from('environments').update(updates).eq('id', id)
  await refreshEnvironments()
}

export async function reorderEnvironments(ordered) {
  // Persist the new order, then refetch ALL envs (personal + org) so we never clobber the store
  // with a partial list when reordering only one group.
  await Promise.all(ordered.map((e, i) => supabase.from('environments').update({ sort_order: i }).eq('id', e.id)))
  await refreshEnvironments()
}

// Never orphan projects: move them to a target Environment first (explicit → a "Default" →
// the next one), repoint the active pointer if it was this one, then delete. Refuses the last.
export async function deleteEnvironment(id, reassignToId) {
  const { environments } = useEnvironmentStore.getState()
  if (environments.length <= 1) throw new Error('Cannot delete the last Environment — every project must live in one.')
  const others = environments.filter(e => e.id !== id)
  const target = (reassignToId && others.find(e => e.id === reassignToId))
    || others.find(e => e.name === 'Default')
    || others[0]
  const { data: { user } } = await supabase.auth.getUser()

  await supabase.from('projects').update({ environment_id: target.id }).eq('environment_id', id).eq('user_id', user.id)

  if (useEnvironmentStore.getState().activeEnvironmentId === id) {
    await supabase.from('user_settings').upsert({ user_id: user.id, active_environment_id: target.id })
    useEnvironmentStore.getState().setActiveEnvironmentId(target.id)
  }

  await supabase.from('environments').delete().eq('id', id)

  const projStore = useProjectStore.getState()
  projStore.projects.forEach(p => { if (p.environment_id === id) projStore.updateProject(p.id, { environment_id: target.id }) })

  await refreshEnvironments()
  return target
}

// For org environments: delete only when empty (no "reassign to Default" fallback like personal
// envs have — an org can simply have zero environments). Caller moves projects out first.
export async function deleteEmptyEnvironment(envId) {
  const { count } = await supabase.from('projects')
    .select('id', { count: 'exact', head: true }).eq('environment_id', envId)
  if (count && count > 0) throw new Error("Move this environment's projects out before deleting it.")
  await supabase.from('environments').delete().eq('id', envId)
  await refreshEnvironments()
}

export async function moveProjectToEnvironment(projectId, environmentId) {
  useProjectStore.getState().updateProject(projectId, { environment_id: environmentId })
  await supabase.from('projects').update({ environment_id: environmentId }).eq('id', projectId)
}

// Move an environment to a different owner: an org (orgId) or back to Personal (orgId null).
// Grants are CLEARED on move (decided TDE-360) — the destination org re-grants fresh, so nobody
// from the previous owner keeps access via a stale grant. Projects follow the env automatically
// (they reference it), so they move with it.
export async function moveEnvironmentToOrg(envId, orgId) {
  await supabase.from('environment_grants').delete().eq('environment_id', envId)
  await supabase.from('environments').update({ org_id: orgId }).eq('id', envId)
  await refreshEnvironments()
}
