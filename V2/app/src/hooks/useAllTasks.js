import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useTaskStore } from '../store/useTaskStore'

const TASK_FIELDS = 'id, project_id, section_id, text, status, priority, due_date, sort_order, pinned, skip_count, completed_at, created_at, focus_date, short_id'
const PROJECT_FIELDS = 'id, name, slug, prefix, context'

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}

export function useAllTasks() {
  const [tasks, setTasks] = useState(() => readLocal('tasker-today-tasks') || [])
  const [projects, setProjects] = useState(() => readLocal('tasker-today-projects') || [])
  const [loading, setLoading] = useState(() => (readLocal('tasker-today-tasks') || []).length === 0)
  const setStoreTasks  = useTaskStore(s => s.setTasks)
  const addStoreTask   = useTaskStore(s => s.addTask)
  const removeStoreTask = useTaskStore(s => s.removeTask)
  const syncStore      = useTaskStore(s => s.updateTask)

  useEffect(() => {
    async function fetchAll() {
      const [{ data: projs }, { data: tsks }] = await Promise.all([
        supabase.from('projects').select(PROJECT_FIELDS).order('created_at'),
        supabase.from('tasks').select(TASK_FIELDS).order('sort_order'),
      ])
      if (projs) {
        setProjects(projs)
        try { localStorage.setItem('tasker-today-projects', JSON.stringify(projs)) } catch {}
      }
      if (tsks) {
        setTasks(tsks)
        setStoreTasks(tsks)
        try { localStorage.setItem('tasker-today-tasks', JSON.stringify(tsks)) } catch {}
      }
      setLoading(false)
    }

    fetchAll()

    const sub = supabase
      .channel('focus-all-tasks')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tasks' }, ({ new: t }) => {
        setTasks(prev => [...prev, t])
        addStoreTask(t)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, ({ new: t }) => {
        setTasks(prev => prev.map(x => x.id === t.id ? { ...x, ...t } : x))
        syncStore(t.id, t)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, ({ old: t }) => {
        setTasks(prev => prev.filter(x => x.id !== t.id))
        removeStoreTask(t.id)
      })
      .subscribe()

    return () => sub.unsubscribe()
  }, [])

  const projectMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects])

  const enriched = useMemo(() => tasks.map(t => ({
    ...t,
    project: projectMap[t.project_id],
  })), [tasks, projectMap])

  async function toggleDone(task) {
    const nowDone = task.status !== 'done'
    const updates = {
      status: nowDone ? 'done' : 'pending',
      completed_at: nowDone ? new Date().toISOString() : null,
    }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  async function toggleInProgress(task) {
    const nowIP = task.status !== 'in_progress'
    const updates = { status: nowIP ? 'in_progress' : 'pending' }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  async function setFocusDate(task, date) {
    const updates = { focus_date: date }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  async function setPinned(task) {
    const updates = { pinned: !task.pinned }
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t))
    syncStore(task.id, updates)
    await supabase.from('tasks').update(updates).eq('id', task.id)
  }

  return { tasks: enriched, projects, toggleDone, toggleInProgress, setFocusDate, setPinned, loading }
}
