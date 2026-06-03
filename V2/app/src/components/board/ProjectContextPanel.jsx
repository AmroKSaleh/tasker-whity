import { useState, useEffect } from 'react'
import ContextPoints from '../projects/ContextPoints'
import { updateProject } from '../../hooks/useProjects'

export default function ProjectContextPanel({ project, onClose, onContextUpdate }) {
  const [points, setPoints] = useState(project.context ?? {})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    try {
      await updateProject(project.id, { context: points })
      onContextUpdate?.(points)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = JSON.stringify(points) !== JSON.stringify(project.context ?? {})

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-lg shadow-xl flex flex-col max-h-[88vh]">

        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-line-2 shrink-0">
          <div>
            <p className="text-[15px] font-semibold text-ink">Project Context</p>
            <p className="text-[11px] text-mute mt-0.5">{project.name}</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink transition-colors text-lg leading-none">×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {Object.keys(points).length === 0 && !project.context ? (
            <p className="text-[13px] text-mute-2 text-center py-6 leading-relaxed">
              No context yet. Fill in the fields below to give the AI a foundation to work from.
            </p>
          ) : null}
          <ContextPoints points={points} onChange={setPoints} />
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40 transition-opacity"
          >
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
