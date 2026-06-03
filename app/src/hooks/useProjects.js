import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useProjectStore } from '../store/useProjectStore'

export async function updateProject(id, description) {
  useProjectStore.getState().updateProject(id, { description })
  await supabase.from('projects').update({ description }).eq('id', id)
}

// Standalone — safe to call outside React (no hook subscription)
export async function createProject(name) {
  const { projects, addProject } = useProjectStore.getState()
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const { data: { user } } = await supabase.auth.getUser()
  const { data: proj } = await supabase.from('projects').insert({
    name: slug,
    description: name,
    position: projects.length,
    user_id: user.id,
  }).select().single()
  if (proj) addProject(proj)
  return proj
}

export async function deleteProject(id) {
  const { data: secs } = await supabase.from('sections').select('id').eq('project_id', id)
  const sectionIds = (secs || []).map(s => s.id)
  await supabase.from('tasks').delete().eq('project_id', id)
  if (sectionIds.length) {
    await supabase.from('groups').delete().in('section_id', sectionIds)
  }
  await supabase.from('sections').delete().eq('project_id', id)
  await supabase.from('projects').delete().eq('id', id)
  useProjectStore.getState().removeProject(id)
}

// Hook — call once at the top of the tree (DashboardPage); everywhere else read the store directly
export function useProjects() {
  const { projects, setProjects } = useProjectStore()

  useEffect(() => {
    async function fetchProjects() {
      const { data } = await supabase.from('projects').select('*').order('position')
      if (data) setProjects(data)
    }

    fetchProjects()

    const sub = supabase
      .channel('projects-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, fetchProjects)
      .subscribe()

    return () => sub.unsubscribe()
  }, [])

  return projects
}
