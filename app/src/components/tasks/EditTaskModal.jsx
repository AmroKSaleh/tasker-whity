import { useState } from 'react'
import { updateTaskFields } from '../../hooks/useTasks'

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

  async function handleSave(e) {
    e.preventDefault()
    if (!text.trim()) return
    setSaving(true)
    await updateTaskFields(task.id, {
      text: text.trim(),
      detail: detail.trim() || null,
      priority: priority || null,
      due_date: dueDate || null,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="bg-surface-container rounded-2xl p-6 w-full max-w-[480px] mx-4 shadow-xl flex flex-col gap-4">
        <p className="text-title-medium font-medium text-on-surface">Edit Task</p>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          {/* Text */}
          <div>
            <label className="text-label-small text-on-surface-variant mb-1 block">Task</label>
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              className="w-full bg-surface-container-high rounded-lg px-3 py-2.5 text-body-large text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors"
            />
          </div>

          {/* Detail */}
          <div>
            <label className="text-label-small text-on-surface-variant mb-1 block">Notes</label>
            <textarea
              value={detail}
              onChange={e => setDetail(e.target.value)}
              rows={3}
              placeholder="Additional context…"
              className="w-full bg-surface-container-high rounded-lg px-3 py-2.5 text-body-medium text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors resize-none"
            />
          </div>

          {/* Priority + Due date row */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-label-small text-on-surface-variant mb-1 block">Priority</label>
              <div className="flex gap-1 flex-wrap">
                {PRIORITIES.map(p => (
                  <button
                    key={String(p.value)}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={`px-3 py-1 rounded-pill text-label-medium border transition-all ${
                      priority === p.value
                        ? 'bg-secondary-container text-on-secondary-container border-transparent'
                        : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-40">
              <label className="text-label-small text-on-surface-variant mb-1 block">Due date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full bg-surface-container-high rounded-lg px-3 py-2 text-body-medium text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors"
              />
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!text.trim() || saving}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
