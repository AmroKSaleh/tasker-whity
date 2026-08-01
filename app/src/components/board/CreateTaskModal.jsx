import { useState } from 'react'
import { useAvailableTags } from '../../hooks/useAvailableTags'

// Global-ish "quick add" for the project board header (TDE-369): defaults to the project's
// Backlog section so the task always lands somewhere visible on the board, but lets the user
// pick a different section right in the creator instead of hunting for that section's own
// inline "+ Add task" control.
export default function CreateTaskModal({ sections, onCreate, onCreateSection, onClose }) {
  const backlog = sections.find(s => s.name === 'Backlog')
  const [text, setText] = useState('')
  const [sectionId, setSectionId] = useState(backlog?.id ?? '')
  const [saving, setSaving] = useState(false)
  
  const projectId = sections[0]?.project_id
  const availableTags = useAvailableTags(projectId)
  const [selectedTags, setSelectedTags] = useState([])

  function toggleTag(tag) {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }

  async function handleSave(e) {
    e.preventDefault()
    const v = text.trim()
    if (!v || saving) return
    setSaving(true)
    // No Backlog section on this project yet (older project, or it was renamed/deleted) —
    // create it on the fly rather than blocking task creation on it.
    const targetId = sectionId || (await onCreateSection('Backlog'))?.id
    if (targetId) await onCreate(targetId, v, null, { tags: selectedTags })
    setSaving(false)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="bg-paper rounded-2xl p-6 w-full max-w-[440px] mx-4 shadow-xl flex flex-col gap-4">
        <p className="text-[15px] font-semibold text-ink">Create Task</p>

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
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Section</label>
            <select
              value={sectionId}
              onChange={e => setSectionId(e.target.value)}
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
            >
              {!backlog && <option value="">Backlog (will be created)</option>}
              {sections.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.id === backlog?.id ? ' (default)' : ''}</option>
              ))}
            </select>
          </div>

          {availableTags.length > 0 && (
            <div>
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Tags (from IS)</label>
              <div className="flex gap-1 flex-wrap">
                {availableTags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`px-2.5 py-1 rounded-pill text-[12px] font-mono border transition-all ${
                      selectedTags.includes(tag)
                        ? 'bg-ink text-paper border-transparent'
                        : 'border-line text-mute hover:bg-surf-2'
                    }`}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!text.trim() || saving}
              className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40">
              {saving ? 'Adding…' : 'Add Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
