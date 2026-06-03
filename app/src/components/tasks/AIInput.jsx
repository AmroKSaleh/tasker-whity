import { useState, useRef, useEffect } from 'react'
import { parseTaskWithAI } from '../../lib/gemini'
import Chip from '../ui/Chip'

const PRIORITY_LABELS = { rush: 'Rush', high: 'High', medium: 'Medium', low: 'Low' }

export default function AIInput({ sectionId, groupId = null, onAdd, onCancel }) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function handleParse(e) {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const parsed = await parseTaskWithAI(trimmed)
      setPreview(parsed)
    } catch {
      setError('Could not parse task. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    await onAdd(sectionId, preview.text, groupId, {
      detail: preview.detail || null,
      priority: preview.priority || null,
      due_date: preview.due_date || null,
      tags: preview.tags?.length ? preview.tags : null,
    })
    setPreview(null)
    setInput('')
    inputRef.current?.focus()
  }

  if (preview) {
    return (
      <div className="px-5 py-3 border-t border-outline-variant bg-surface-container-low">
        <div className="bg-surface-container border border-outline-variant rounded-lg p-3 mb-3">
          <p className="text-body-medium text-on-surface font-medium mb-1">{preview.text}</p>
          {preview.detail && (
            <p className="text-body-small text-on-surface-variant mb-2">{preview.detail}</p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {preview.priority && (
              <Chip priority={preview.priority} className="text-[10px] px-2 h-5">
                {PRIORITY_LABELS[preview.priority]}
              </Chip>
            )}
            {preview.due_date && (
              <span className="text-label-small text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-pill border border-outline-variant">
                Due {preview.due_date}
              </span>
            )}
            {!preview.priority && !preview.due_date && (
              <span className="text-label-small text-on-surface-variant opacity-60">No priority or due date</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-medium"
          >
            Add task
          </button>
          <button
            onClick={() => setPreview(null)}
            className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors ml-auto"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleParse}
      className="flex items-center gap-2 px-5 py-2.5 border-t border-outline-variant"
    >
      <span className="text-primary text-sm shrink-0 select-none">✦</span>
      <input
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="Describe your task in plain English…"
        disabled={loading}
        className="flex-1 bg-transparent outline-none text-body-medium text-on-surface placeholder:text-on-surface-variant py-1 disabled:opacity-50"
      />
      {loading && (
        <span className="text-label-small text-primary shrink-0 animate-pulse">Parsing…</span>
      )}
      {!loading && input.trim() && (
        <button type="submit" className="shrink-0 text-label-small text-primary hover:opacity-70 transition-opacity">
          Parse
        </button>
      )}
      {error && (
        <span className="text-label-small text-error shrink-0">{error}</span>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 text-label-small text-on-surface-variant hover:text-on-surface transition-colors"
      >
        ↩
      </button>
    </form>
  )
}
