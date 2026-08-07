import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useProjectStore } from '../store/useProjectStore'
import { useEnvironmentStore } from '../store/useEnvironmentStore'

// TDE-822: 2-6 uppercase alphanumerics, unique per user — enforced in the DB by a CHECK plus a
// unique index on (user_id, lower(prefix)). Was capped at 3 here while the MCP allowed 5.
export const PREFIX_MAX = 6

export function derivePrefix(name) {
  const words = name.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length) return 'NEW'
  const initials = words.map(w => w[0])
  const result = initials.length >= 3
    ? initials.slice(0, PREFIX_MAX).join('')
    : (initials.join('') + words[0]).slice(0, PREFIX_MAX)
  return (result + 'XXX').slice(0, Math.max(3, Math.min(PREFIX_MAX, result.length || 3)))
}

export async function createProject(displayName, customPrefix, opts = {}) {
  const { addProject } = useProjectStore.getState()
  const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'project'
  const prefix = customPrefix ? customPrefix.toUpperCase().slice(0, PREFIX_MAX) : derivePrefix(displayName)
  const { data: { user } } = await supabase.auth.getUser()
  const environment_id = useEnvironmentStore.getState().activeEnvironmentId

  // Surface a duplicate prefix as a clear error. Without this the insert fails on the unique
  // index and the UI showed a generic "Failed to create project".
  const { data: clash } = await supabase.from('projects')
    .select('id, name').eq('user_id', user.id).ilike('prefix', prefix).maybeSingle()
  if (clash) throw new Error(`Prefix "${prefix}" is already used by "${clash.name}". Pick another.`)

  const { data: proj, error } = await supabase.from('projects').insert({
    name: displayName,
    slug,
    description: displayName,
    user_id: user.id,
    prefix,
    environment_id,
    local_mode: !!opts.localMode,
  }).select().single()
  if (error) throw new Error(error.message.includes('projects_user_prefix_unique')
    ? `Prefix "${prefix}" is already taken. Pick another.`
    : error.message)
  if (proj) {
    addProject(proj)
    await supabase.from('sections').insert({ project_id: proj.id, name: 'Backlog', sort_order: 0 })
  }
  return proj
}

export async function reorderProjects(orderedProjects) {
  useProjectStore.getState().reorderProjectsInStore(orderedProjects)
  await Promise.all(orderedProjects.map((p, i) =>
    supabase.from('projects').update({ sort_order: i }).eq('id', p.id)
  ))
}

export async function updateProject(id, updates) {
  useProjectStore.getState().updateProject(id, updates)
  await supabase.from('projects').update(updates).eq('id', id)
}

export async function deleteProject(id) {
  await supabase.from('projects').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id)
  useProjectStore.getState().removeProject(id)
}

export async function hardDeleteProject(id) {
  const { data: secs } = await supabase.from('sections').select('id').eq('project_id', id)
  const sectionIds = (secs || []).map(s => s.id)
  if (sectionIds.length) {
    await supabase.from('groups').delete().in('section_id', sectionIds)
  }
  const { data: taskRows } = await supabase.from('tasks').select('id').eq('project_id', id)
  const taskIds = (taskRows || []).map(t => t.id)
  if (taskIds.length) {
    await supabase.from('task_discussions').delete().in('task_id', taskIds)
  }
  await supabase.from('tasks').delete().eq('project_id', id)
  await supabase.from('sections').delete().eq('project_id', id)
  await supabase.from('projects').delete().eq('id', id)
  useProjectStore.getState().removeProject(id)
}

export async function restoreProject(id) {
  await supabase.from('projects').update({ is_deleted: false, deleted_at: null }).eq('id', id)
}

export function useProjects() {
  const { projects, setProjects } = useProjectStore()
  const [isLoading, setIsLoading] = useState(projects.length === 0)

  useEffect(() => {
    async function fetchProjects() {
      const { data } = await supabase.from('projects').select('id, name, slug, sort_order, created_at, context, description, prefix, environment_id').is('is_deleted', false).order('sort_order').order('created_at')
      if (data) setProjects(data)
      setIsLoading(false)
    }

    fetchProjects()

    const sub = supabase
      .channel('projects-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, fetchProjects)
      .subscribe()

    return () => sub.unsubscribe()
  }, [])

  return { projects, isLoading }
}
