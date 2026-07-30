import { useState, useRef } from 'react'
import { useKnowledgeBase } from '../../hooks/useKnowledgeBase'
import KbHealthPanel, { countStale } from './KbHealthPanel'

export default function KnowledgeBaseModal({ projectId, onClose }) {
  const { entries, createEntry, updateEntry, deleteEntry, archiveEntry, reviewEntry } = useKnowledgeBase(projectId)
  const [editing, setEditing] = useState(null) // null = list, { id, title, content } = editor
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [showHealth, setShowHealth] = useState(false)
  const fileInputRef = useRef(null)

  const activeEntries = entries.filter(e => !e.archived_at)
  const visibleEntries = sourceFilter === 'archived'
    ? entries.filter(e => e.archived_at)
    : activeEntries.filter(e => sourceFilter === 'all' || (e.source ?? 'user') === sourceFilter)
  const staleCount = countStale(activeEntries)

  function openNew() {
    setEditing({ id: null, title: '', content: '' })
    setConfirmDelete(false)
  }

  function openEntry(entry) {
    setEditing({ id: entry.id, title: entry.title, content: entry.content })
    setConfirmDelete(false)
  }

  function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target.result
      const title = file.name.replace(/\.(md|txt)$/i, '')
      setEditing({ id: null, title, content })
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  async function handleSave() {
    if (!editing.title.trim()) return
    setSaving(true)
    if (editing.id) {
      await updateEntry(editing.id, { title: editing.title.trim(), content: editing.content })
    } else {
      await createEntry(editing.title.trim(), editing.content)
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
          {editing || showHealth ? (
            <button
              onClick={() => { setEditing(null); setShowHealth(false); setConfirmDelete(false) }}
              className="font-mono text-[11px] tracking-widest uppercase text-mute hover:text-ink transition-colors"
            >
              ← Back
            </button>
          ) : (
            <h2 className="text-[15px] font-semibold text-ink">Knowledge Base</h2>
          )}
          <div className="flex items-center gap-2">
            {!editing && !showHealth && (
              <>
                <button
                  onClick={() => setShowHealth(true)}
                  className={`btn btn-sm ${staleCount ? 'border-amber-400 text-amber-600' : ''}`}
                >
                  ♥ Health{staleCount ? ` · ${staleCount}` : ''}
                </button>
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

        {/* Source filter tabs — only shown on list view */}
        {!editing && !showHealth && (
          <div className="flex items-center gap-1 px-5 py-2 border-b border-line-2 shrink-0">
            {['all', 'user', 'agent', 'archived'].map(f => (
              <button
                key={f}
                onClick={() => setSourceFilter(f)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono tracking-wide transition-colors ${
                  sourceFilter === f
                    ? 'bg-ink text-paper'
                    : 'text-mute hover:text-ink hover:bg-surf-2'
                }`}
              >
                {f === 'all' ? 'All' : f === 'user' ? 'Mine' : f === 'agent' ? 'AI' : 'Archived'}
              </button>
            ))}
            <span className="ml-auto font-mono text-[10px] text-mute-2">{visibleEntries.length} entr{visibleEntries.length === 1 ? 'y' : 'ies'}</span>
          </div>
        )}

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
            <textarea
              value={editing.content}
              onChange={e => setEditing(prev => ({ ...prev, content: e.target.value }))}
              placeholder="Write in markdown…"
              rows={16}
              className="w-full flex-1 rounded-lg border border-line bg-surf-2 px-3 py-2 text-[13px] font-mono text-ink placeholder:text-mute-2 outline-none focus:border-ink transition-colors resize-none leading-relaxed"
            />
          </div>
        ) : showHealth ? (
          <KbHealthPanel entries={activeEntries} archiveEntry={archiveEntry} reviewEntry={reviewEntry} />
        ) : (
          <div className="flex-1 overflow-y-auto">
            {visibleEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
                <div className="w-10 h-10 rounded-xl border border-dashed border-line flex items-center justify-center text-mute-2 text-lg">
                  ✦
                </div>
                <p className="text-[13px] text-mute leading-relaxed">
                  {entries.length === 0
                    ? <>No entries yet.<br />Create one or upload a <span className="font-mono">.md</span> / <span className="font-mono">.txt</span> file.</>
                    : sourceFilter === 'archived' ? 'Nothing archived.' : 'No entries for this filter.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line-2">
                {visibleEntries.map(entry => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 hover:bg-surf-2 transition-colors">
                    <button
                      onClick={() => openEntry(entry)}
                      className="flex-1 min-w-0 flex items-center justify-between px-5 py-3.5 text-left gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-mute-2 text-[12px] shrink-0">✦</span>
                        <span className={`text-[14px] truncate ${entry.archived_at ? 'text-mute-2 line-through' : 'text-ink'}`}>{entry.title}</span>
                        {(entry.source ?? 'user') === 'agent' && (
                          <span className="shrink-0 font-mono text-[9px] tracking-wide px-1.5 py-0.5 rounded border border-line text-mute-2">AI</span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-mute-2 shrink-0">
                        {new Date(entry.updated_at).toLocaleDateString()}
                      </span>
                    </button>
                    {entry.archived_at && (
                      <button onClick={() => archiveEntry(entry.id, true)} className="btn btn-sm shrink-0 mr-3">
                        Restore
                      </button>
                    )}
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
