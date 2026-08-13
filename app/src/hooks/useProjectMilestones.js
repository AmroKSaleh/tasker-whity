import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useProjectMilestones(taskIds) {
  const [progress, setProgress] = useState({})

  const key = taskIds?.join(',') ?? ''

  useEffect(() => {
    if (!taskIds?.length) return
    load()
  }, [key])

  async function load() {
    const { data } = await supabase
      .from('task_discussions')
      .select('task_id, steps, checked_steps')
      .in('task_id', taskIds)
    if (!data) return
    const map = {}
    for (const row of data) {
      const total = row.steps?.length ?? 0
      const done = (row.checked_steps ?? []).filter(Boolean).length
      map[row.task_id] = total > 0 ? Math.round((done / total) * 100) : 0
    }
    setProgress(map)
  }

  function refreshOne(taskId, steps, checkedSteps) {
    const total = steps?.length ?? 0
    const done = (checkedSteps ?? []).filter(Boolean).length
    setProgress(prev => ({
      ...prev,
      [taskId]: total > 0 ? Math.round((done / total) * 100) : 0,
    }))
  }

  return { progress, refreshOne }
}
