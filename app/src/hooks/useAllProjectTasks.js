import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// v2 key: pre-fix caches held flow steps, which would keep serving stale counts (TDE-806).
const CACHE_KEY = 'tasker-all-project-tasks-v2'

function readCache() {
  // The v1 blob can be megabytes and setItem already fails on quota — drop it rather than orphan it.
  try { localStorage.removeItem('tasker-all-project-tasks') } catch {}
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') || {} } catch { return {} }
}

// Flow steps are excluded (flow_id null): per TDE-320 a step is not a board task and leaves
// the project denominator entirely, so the /projects card counts must match ProjectBoard's.
export function useAllProjectTasks() {
  const [tasksByProject, setTasksByProject] = useState(readCache)
  const [loading, setLoading] = useState(() => Object.keys(readCache()).length === 0)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      const { data } = await supabase
        .from('tasks')
        .select('id, project_id, text, status, priority, due_date, created_at, pinned, skip_count, flow_id')
        .eq('user_id', user.id)
        .is('flow_id', null)
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
