import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useTaskStore } from '../../store/useTaskStore'

export default function CustomStatusField({ task }) {
  const [statuses, setStatuses] = useState([])
  const updateTask = useTaskStore(s => s.updateTask)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('project_statuses')
        .select('id, name, color, base_status')
        .eq('user_id', user.id)
        .is('project_id', null)
        .order('sort_order')
      setStatuses(data || [])
    }
    load()
  }, [])

  if (statuses.length === 0) return null

  const activeIds = new Set((task.task_statuses || []).map(ts => ts.status_id))

  async function toggle(s) {
    const isActive = activeIds.has(s.id)
    if (isActive) {
      const newTaskStatuses = (task.task_statuses || []).filter(ts => ts.status_id !== s.id)
      updateTask(task.id, { task_statuses: newTaskStatuses })
      await supabase.from('task_statuses').delete().eq('task_id', task.id).eq('status_id', s.id)
    } else {
      const newEntry = { status_id: s.id, status: s }
      const newTaskStatuses = [...(task.task_statuses || []), newEntry]
      updateTask(task.id, { task_statuses: newTaskStatuses })
      await supabase.from('task_statuses').insert({ task_id: task.id, status_id: s.id })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">Labels</div>
      <div className="flex flex-wrap gap-1.5">
        {statuses.map(s => {
          const active = activeIds.has(s.id)
          return (
            <button
              key={s.id}
              onClick={() => toggle(s)}
              className="px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors"
              style={active
                ? { backgroundColor: s.color, borderColor: s.color, color: '#fff' }
                : { borderColor: s.color + '55', color: s.color }
              }
            >
              {s.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
