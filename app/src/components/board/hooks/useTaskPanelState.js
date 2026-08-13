import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export function useTaskPanelState() {
  const [params, setParams] = useSearchParams()
  const selectedTaskId = params.get('task')

  const openTask = useCallback((id) => {
    const next = new URLSearchParams(params)
    next.set('task', id)
    setParams(next, { replace: false })
  }, [params, setParams])

  const closeTask = useCallback(() => {
    const next = new URLSearchParams(params)
    next.delete('task')
    setParams(next, { replace: false })
  }, [params, setParams])

  return { selectedTaskId, openTask, closeTask }
}
