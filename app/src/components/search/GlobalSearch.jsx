import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Search, CornerDownLeft } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const STATUS_DOT = { in_progress: 'bg-accent', done: 'bg-mute-2', pending: 'bg-line' }

// Global task search (⌘/Ctrl-K or the Search rail button). Matches by title or short ID
// (e.g. "TDE-52", "tde52", or just "52") across every project; selecting a result opens
// that task on its project board via /dashboard/:slug?task=:id.
export default function GlobalSearch({ open, onClose }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState([])
  const [projects, setProjects] = useState([])
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)

  // Fetch lightweight task + project data each time the palette opens (cheap, keeps it fresh).
  useEffect(() => {
    if (!open) { setQuery(''); setActive(0); return }
    inputRef.current?.focus()
    let cancelled = false
    Promise.all([
      supabase.from('projects').select('id, name, slug, prefix'),
      supabase.from('tasks').select('id, text, status, short_id, project_id'),
    ]).then(([{ data: projs }, { data: tsks }]) => {
      if (cancelled) return
      if (projs) setProjects(projs)
      if (tsks) setTasks(tsks)
    })
    return () => { cancelled = true }
  }, [open])

  const projMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const qNorm = q.replace(/[\s-]/g, '')
    return tasks
      .map(t => {
        const proj = projMap[t.project_id]
        const ref = proj?.prefix != null && t.short_id != null ? `${proj.prefix}-${t.short_id}` : ''
        const refNorm = ref.toLowerCase().replace(/[\s-]/g, '')
        const titleMatch = t.text?.toLowerCase().includes(q)
        const refMatch = refNorm && refNorm.includes(qNorm)
        if (!titleMatch && !refMatch) return null
        // Rank: exact short-ID first, then short-ID prefix, then title.
        const score = refMatch ? (refNorm === qNorm ? 0 : 1) : 2
        return { t, proj, ref, score }
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || (a.t.status === 'done') - (b.t.status === 'done'))
      .slice(0, 25)
  }, [query, tasks, projMap])

  useEffect(() => { setActive(0) }, [query])

  const choose = useCallback((r) => {
    if (!r?.proj?.slug) return
    navigate(`/dashboard/${r.proj.slug}?task=${r.t.id}`)
    onClose()
  }, [navigate, onClose])

  function onKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]) }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[12vh] px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-[560px] rounded-2xl border border-line bg-paper shadow-xl overflow-hidden flex flex-col">
        <div className="flex items-center gap-2.5 px-4 border-b border-line-2">
          <Search className="h-4 w-4 shrink-0 text-mute-2" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tasks by title or ID (e.g. TDE-52)…"
            className="flex-1 bg-transparent py-3.5 text-[14px] text-ink outline-none placeholder:text-mute-2"
          />
          <kbd className="shrink-0 text-[10px] font-mono text-mute-2 border border-line rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {query.trim() === '' ? (
            <p className="px-4 py-6 text-center text-[12px] text-mute-2">Type a task title or short ID to search across all projects.</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-mute-2">No tasks match “{query}”.</p>
          ) : (
            results.map((r, i) => (
              <button
                key={r.t.id}
                onClick={() => choose(r)}
                onMouseEnter={() => setActive(i)}
                className={clsx('w-full flex items-center gap-3 px-4 py-2 text-left transition-colors', i === active ? 'bg-surf-2' : 'hover:bg-surf-2/60')}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[r.t.status] || STATUS_DOT.pending)} />
                <span className={clsx('flex-1 min-w-0 truncate text-[13px]', r.t.status === 'done' ? 'text-mute-2 line-through' : 'text-ink')}>
                  {r.t.text || '(untitled)'}
                </span>
                {r.ref && <span className="shrink-0 font-mono text-[10px] text-mute-2">{r.ref}</span>}
                <span className="shrink-0 text-[10px] text-mute-2 max-w-[120px] truncate">{r.proj?.name ?? '—'}</span>
                {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-mute-2" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
