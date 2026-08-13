import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function useToggleInProgressWithWarning(originalToggleInProgress) {
  const [dependencyWarning, setDependencyWarning] = useState(null)
  const [pendingTask, setPendingTask] = useState(null)

  async function toggleInProgressWithWarning(task) {
    const nowIP = task.status !== 'in_progress'

    // Check for input dependency when starting work
    if (nowIP && task.input) {
      const sourceTaskId = task.input.source_task_id
      if (sourceTaskId) {
        const { data: sourceTask } = await supabase.from('tasks').select('text, status').eq('id', sourceTaskId).maybeSingle()
        if (sourceTask && sourceTask.status !== 'done') {
          setDependencyWarning({ sourceTaskName: sourceTask.text })
          setPendingTask(task)
          return
        }
      }
    }

    // No dependency warning, proceed normally
    await originalToggleInProgress(task)
  }

  async function handleProceed() {
    if (pendingTask) {
      setDependencyWarning(null)
      setPendingTask(null)
      await originalToggleInProgress(pendingTask)
    }
  }

  function handleCancel() {
    setDependencyWarning(null)
    setPendingTask(null)
  }

  return {
    toggleInProgressWithWarning,
    dependencyWarning,
    handleProceed,
    handleCancel,
  }
}
