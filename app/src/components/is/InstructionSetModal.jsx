import { useState, useRef } from 'react'
import { useInstructionSet } from '../../hooks/useInstructionSet'

export default function InstructionSetModal({ projectId, onClose }) {
  const { entries, createEntry, updateEntry, deleteEntry } = useInstructionSet(projectId)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileInputRef = useRef(null)

  function openNew() {
    setEditing({ id: null, title: '', content: '', tags: '' })
    setConfirmDelete(false)
  }

  function openEntry(entry) {
    setEditing({ id: entry.id, title: entry.title, content: entry.content, tags: entry.tags ? entry.tags.join(', ') : '' })
    setConfirmDelete(false)
  }

  function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target.result
      const title = file.name.replace(/\.(md|txt)$/i, '')
      setEditing({ id: null, title, content, tags: '' })
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  async function handleSave() {
    if (!editing.title.trim()) return
    setSaving(true)
    const parsedTags = (editing.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    if (editing.id) {
      await updateEntry(editing.id, { title: editing.title.trim(), content: editing.content, tags: parsedTags })
    } else {
      await createEntry(editing.title.trim(), editing.content, parsedTags)
    }
    setSaving(false)
    setEditing(null)
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    await deleteEntry(editing.id)
    setEditing(null)
    setConfirmDelete(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative z-10 bg-paper border border-line rounded-2xl shadow-hero w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-2 shrink-0">
          {editing ? (
            <button
              onClick={() => { setEditing(null); setConfirmDelete(false) }}
              className="font-mono text-[11px] tracking-widest uppercase text-mute hover:text-ink transition-colors"
            >
              ← Back
            </button>
          ) : (
            <h2 className="text-[15px] font-semibold text-ink">Instruction Set</h2>
          )}
          <div className="flex items-center gap-2">
            {!editing && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  className="hidden"
                  onChange={handleUpload}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="btn btn-sm"
                >
                  ↑ Upload
                </button>
                <button onClick={openNew} className="btn btn-sm">
                  + New entry
                </button>
              </>
            )}
            {editing && (
              <>
                {editing.id && (
                  <button
                    onClick={handleDelete}
                    className={`btn btn-sm ${confirmDelete ? 'border-red-400 text-red-500 hover:bg-red-50' : ''}`}
                  >
                    {confirmDelete ? 'Confirm delete' : 'Delete'}
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !editing.title.trim()}
                  className="btn-primary btn-sm disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-mute-2 hover:text-ink hover:bg-surf-2 transition-colors text-[16px]"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        {editing ? (
          <div className="flex flex-col gap-3 p-5 flex-1 overflow-y-auto">
            <input
              autoFocus
              value={editing.title}
              onChange={e => setEditing(prev => ({ ...prev, title: e.target.value }))}
              placeholder="Entry title…"
              className="w-full rounded-lg border border-line bg-surf-2 px-3 py-2 text-[14px] text-ink placeholder:text-mute-2 outline-none focus:border-ink transition-colors"
            />
            <input
              value={editing.tags || ''}
              onChange={e => setEditing(prev => ({ ...prev, tags: e.target.value }))}
              placeholder="Tags (comma separated)…"
              className="w-full rounded-lg border border-line bg-surf-2 px-3 py-2 text-[13px] text-ink placeholder:text-mute-2 outline-none focus:border-ink transition-colors"
            />
            <textarea
              value={editing.content}
              onChange={e => setEditing(prev => ({ ...prev, content: e.target.value }))}
              placeholder="Write instructions in markdown…"
              rows={16}
              className="w-full flex-1 rounded-lg border border-line bg-surf-2 px-3 py-2 text-[13px] font-mono text-ink placeholder:text-mute-2 outline-none focus:border-ink transition-colors resize-none leading-relaxed"
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
                <div className="w-10 h-10 rounded-xl border border-dashed border-line flex items-center justify-center text-mute-2 text-lg">
                  ◈
                </div>
                <p className="text-[13px] text-mute leading-relaxed">
                  No instructions yet.<br />
                  Create one or upload a <span className="font-mono">.md</span> / <span className="font-mono">.txt</span> file.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line-2">
                {entries.map(entry => (
                  <li key={entry.id}>
                    <button
                      onClick={() => openEntry(entry)}
                      className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surf-2 transition-colors text-left gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-mute-2 text-[12px] shrink-0">◈</span>
                        <span className="text-[14px] text-ink truncate">{entry.title}</span>
                        {entry.tags?.length > 0 && (
                          <div className="flex gap-1 overflow-hidden shrink-0">
                            {entry.tags.map(tag => (
                              <span key={tag} className="font-mono text-[9px] text-ink border border-line rounded px-1.5 py-0.5 whitespace-nowrap">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-mute-2 shrink-0">
                        {new Date(entry.updated_at).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
