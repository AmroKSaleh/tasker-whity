import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useTaskStore } from '../store/useTaskStore'

export function useAllTasks() {
  const [tasks, setTasks] = useState([])
  const [projects, setProjects] = useState([])
  const { updateTask: syncStore } = useTaskStore()

  useEffect(() => {
    async function fetchAll() {
      const [{ data: projs }, { data: tsks }] = await Promise.all([
        supabase.from('projects').select('*').order('position'),
        supabase.from('tasks').select('*').order('position'),
      ])
      if (projs) setProjects(projs)
      if (tsks) setTasks(tsks)
    }

    fetchAll()

    const sub = supabase
      .channel('focus-all-tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, fetchAll)
      .subscribe()

    return () => sub.unsubscribe()
  }, [])

  const enriched = tasks.map(t => ({
    ...t,
    project: projects.find(p => p.id === t.project_id),
  }))

  async function toggleDone(task) {
    const nowDone = !task.done
    const updates = {
      done: nowDone,
      in_progress: nowDone ? false : task.in_progress,
      completed_at: nowDone ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  async function toggleInProgress(task) {
    const nowIP = !task.in_progress
    const updates = { in_progress: nowIP, updated_at: new Date().toISOString() }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  return { tasks: enriched, toggleDone, toggleInProgress }
}
