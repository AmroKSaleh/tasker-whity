import { supabase } from './supabase'

const inFlight = new Set()

export async function prefetchBoard(projectId) {
  if (!projectId) return
  const key = `tasker-board-${projectId}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    const [{ data: secs }, { data: tsks }] = await Promise.all([
      supabase.from('sections').select('*').eq('project_id', projectId).order('sort_order'),
      supabase.from('tasks').select('*').eq('project_id', projectId).order('sort_order'),
    ])
    let grps = []
    if (secs?.length) {
      const { data } = await supabase
        .from('groups').select('*')
        .in('section_id', secs.map(s => s.id))
        .order('sort_order')
      grps = data || []
    }
    localStorage.setItem(key, JSON.stringify({ sections: secs || [], tasks: tsks || [], groups: grps }))
  } catch {} finally {
    inFlight.delete(key)
  }
}

export async function prefetchToday() {
  const key = 'tasker-today-tasks'
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    const [{ data: projs }, { data: tsks }] = await Promise.all([
      supabase.from('projects').select('id, name, slug, prefix').order('created_at'),
      supabase.from('tasks')
        .select('id, project_id, section_id, text, status, priority, due_date, sort_order, pinned, skip_count, completed_at, created_at, focus_date, short_id')
        .order('sort_order'),
    ])
    if (projs) localStorage.setItem('tasker-today-projects', JSON.stringify(projs))
    if (tsks) localStorage.setItem(key, JSON.stringify(tsks))
  } catch {} finally {
    inFlight.delete(key)
  }
}
