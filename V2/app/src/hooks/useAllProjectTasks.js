import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const CACHE_KEY = 'tasker-all-project-tasks'

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') || {} } catch { return {} }
}

export function useAllProjectTasks() {
  const [tasksByProject, setTasksByProject] = useState(readCache)
  const [loading, setLoading] = useState(() => Object.keys(readCache()).length === 0)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      const { data } = await supabase
        .from('tasks')
        .select('id, project_id, text, status, priority, due_date, created_at, pinned, skip_count')
        .eq('user_id', user.id)
      if (data) {
        const grouped = {}
        for (const task of data) {
          if (!grouped[task.project_id]) grouped[task.project_id] = []
          grouped[task.project_id].push(task)
        }
        setTasksByProject(grouped)
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(grouped)) } catch {}
      }
      setLoading(false)
    }
    load()
  }, [])

  return { tasksByProject, loading }
}
