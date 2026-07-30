import { useState, useEffect } from 'react'
import { updateTaskFields } from '../../hooks/useTasks'
import { supabase } from '../../lib/supabase'

const PRIORITIES = [
  { value: null,     label: 'None' },
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'rush',   label: 'Rush' },
]

export default function EditTaskModal({ task, onClose }) {
  const [text, setText] = useState(task.text ?? '')
  const [detail, setDetail] = useState(task.detail ?? '')
  const [priority, setPriority] = useState(task.priority ?? null)
  const [dueDate, setDueDate] = useState(task.due_date ?? '')
  const [saving, setSaving] = useState(false)
  const [statuses, setStatuses] = useState([])
  const [customStatusId, setCustomStatusId] = useState(task.custom_status_id ?? null)

  useEffect(() => {
    if (!task.project_id) return
    supabase
      .from('project_statuses')
      .select('id, name, color, base_status')
      .eq('project_id', task.project_id)
      .order('sort_order')
      .then(({ data }) => setStatuses(data || []))
  }, [task.project_id])

  async function handleSave(e) {
    e.preventDefault()
    if (!text.trim()) return
    setSaving(true)
    const selectedStatus = statuses.find(s => s.id === customStatusId)
    await updateTaskFields(task.id, {
      text: text.trim(),
      detail: detail.trim() || null,
      priority: priority || null,
      due_date: dueDate || null,
      custom_status_id: customStatusId || null,
      ...(selectedStatus && { status: selectedStatus.base_status }),
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="bg-paper rounded-2xl p-6 w-full max-w-[480px] mx-4 shadow-xl flex flex-col gap-4">
        <p className="text-[15px] font-semibold text-ink">Edit Task</p>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          {/* Text */}
          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Task</label>
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
            />
          </div>

          {/* Detail */}
          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Notes</label>
            <textarea
              value={detail}
              onChange={e => setDetail(e.target.value)}
              rows={3}
              placeholder="Additional context…"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors resize-none placeholder:text-mute-2"
            />
          </div>

          {/* Priority + Due date row */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Priority</label>
              <div className="flex gap-1 flex-wrap">
                {PRIORITIES.map(p => (
                  <button
                    key={String(p.value)}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={`px-3 py-1 rounded-pill text-[12px] border transition-all ${
                      priority === p.value
                        ? 'bg-ink text-paper border-transparent'
                        : 'border-line text-mute hover:bg-surf-2'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-40">
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Due date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
              />
            </div>
          </div>

          {/* Custom status */}
          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Status</label>
            {statuses.length === 0 ? (
              <p className="text-[12px] text-mute-2">
                No custom statuses yet.{' '}
                <a href="/settings" className="text-accent underline underline-offset-2 hover:opacity-75 transition-opacity">
                  Add them in Settings →
                </a>
              </p>
            ) : (
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setCustomStatusId(null)}
                  className={`px-3 py-1 rounded-pill text-[12px] border transition-all ${
                    customStatusId === null
                      ? 'bg-ink text-paper border-transparent'
                      : 'border-line text-mute hover:bg-surf-2'
                  }`}
                >
                  Default
                </button>
                {statuses.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setCustomStatusId(s.id)}
                    className="px-3 py-1 rounded-pill text-[12px] border transition-all"
                    style={customStatusId === s.id
                      ? { backgroundColor: s.color, borderColor: s.color, color: '#fff' }
                      : { borderColor: s.color + '66', color: s.color }
                    }
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!text.trim() || saving}
              className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
