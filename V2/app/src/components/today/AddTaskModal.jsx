import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useProjectStore } from '../../store/useProjectStore'
import { getOrCreateBacklogSectionId } from '../../hooks/useTasks'

const PRIORITIES = [
  { value: null,     label: 'None' },
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'rush',   label: 'Rush' },
]

export default function AddTaskModal({ initialDueDate = '', onClose }) {
  const { projects } = useProjectStore()
  const [text, setText] = useState('')
  const [detail, setDetail] = useState('')
  const [priority, setPriority] = useState(null)
  const [dueDate, setDueDate] = useState(initialDueDate)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave(e) {
    e.preventDefault()
    if (!text.trim() || !projectId) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const sectionId = await getOrCreateBacklogSectionId(projectId)
    const { count } = await supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('section_id', sectionId)
    await supabase.from('tasks').insert({
      project_id: projectId,
      section_id: sectionId,
      user_id: user.id,
      text: text.trim(),
      detail: detail.trim() || null,
      priority: priority || null,
      due_date: dueDate || null,
      status: 'pending',
      sort_order: count ?? 0,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="bg-paper rounded-2xl p-6 w-full max-w-[480px] mx-4 shadow-xl flex flex-col gap-4">
        <p className="text-[15px] font-semibold text-ink">Add Task</p>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Task</label>
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              placeholder="What needs doing?"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Project</label>
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Notes</label>
            <textarea
              value={detail}
              onChange={e => setDetail(e.target.value)}
              rows={2}
              placeholder="Additional context…"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors resize-none placeholder:text-mute-2"
            />
          </div>

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

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!text.trim() || !projectId || saving}
              className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40">
              {saving ? 'Saving…' : 'Add Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}