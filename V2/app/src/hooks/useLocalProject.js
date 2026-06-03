/**
 * Fetches board data from the local Tasker server (localhost:2821/api/)
 * and populates the Zustand store — same store the board components already read.
 *
 * Also subscribes to /api/events (SSE) for live updates when .tasker/ files change.
 *
 * Only used when window.__TASKER_LOCAL__ === true (served by `npx tasker`).
 */

import { useEffect, useState } from 'react'
import { useTaskStore }        from '../store/useTaskStore'

export function useLocalProject() {
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const { setTasks, setSections, setGroups, setActiveProjectId } = useTaskStore()

  function applyData(data) {
    setSections(data.sections ?? [])
    setGroups(data.groups   ?? [])
    setTasks(data.tasks     ?? [])
    setActiveProjectId(data.project?.id ?? null)
    setProject(data.project ?? null)
  }

  useEffect(() => {
    // Initial fetch
    fetch('/api/project')
      .then(r => {
        if (!r.ok) throw new Error(`API error ${r.status}`)
        return r.json()
      })
      .then(data => {
        applyData(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })

    // Live updates via SSE — fires whenever .tasker/ files change on disk
    const es = new EventSource('/api/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        applyData(data)
      } catch { /* ignore malformed messages */ }
    }
    es.onerror = () => {
      // SSE reconnects automatically — no action needed
    }

    return () => es.close()
  }, [])

  return { project, loading, error }
}
