import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Search, CornerDownLeft, Zap } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useTheme } from '../../hooks/useTheme'

const STATUS_DOT = { in_progress: 'bg-accent', done: 'bg-mute-2', pending: 'bg-line' }

// TDE-396 v1 — the smallest real step from "search" toward "command palette": a short,
// hand-written list of page jumps + the one non-navigation action (theme) that's genuinely
// global (no project context needed). Filtered by the same query as tasks, so typing
// "theme" or "flows" surfaces a command exactly like typing a task title surfaces a task.
// Deliberately NOT a registry/plugin system yet — add verbs here directly until the list
// earns something fancier.
function buildCommands(navigate, toggleTheme) {
  return [
    { id: 'nav-today', label: 'Go to Today', run: () => navigate('/today') },
    { id: 'nav-projects', label: 'Go to Projects', run: () => navigate('/projects') },
    { id: 'nav-flows', label: 'Go to Flows', run: () => navigate('/flows') },
    { id: 'nav-environments', label: 'Go to Environments', run: () => navigate('/environments') },
    { id: 'nav-settings', label: 'Go to Settings', run: () => navigate('/settings') },
    { id: 'theme-toggle', label: 'Toggle theme (light / dark)', run: toggleTheme },
  ]
}

// Global search + a small set of commands (⌘/Ctrl-K or the Search rail button). Tasks match
// by title or short ID (e.g. "TDE-52", "tde52", or just "52") across every project; selecting
// a task result opens it on its project board via /dashboard/:slug?task=:id. Commands run
// immediately on selection — no navigation involved beyond what the command itself does.
export default function GlobalSearch({ open, onClose }) {
  const navigate = useNavigate()
  const { resolved: resolvedTheme, setPreference: setThemePreference } = useTheme()
  const toggleTheme = useCallback(
    () => setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark'),
    [resolvedTheme, setThemePreference],
  )
  const commands = useMemo(() => buildCommands(navigate, toggleTheme), [navigate, toggleTheme])
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

  // Commands show up front, unfiltered, when the box is empty — the whole point of a v1
  // this small is that opening it once shows you everything it can do. Typing narrows them
  // by the same query as tasks, so "theme" or "flows" behaves exactly like typing a title.
  const commandResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(c => c.label.toLowerCase().includes(q))
  }, [query, commands])

  // One combined, keyboard-navigable list: commands first (there are only a handful), tasks
  // after. Each entry keeps its kind so render/choose can branch without re-deriving it.
  const combined = useMemo(() => [
    ...commandResults.map(c => ({ kind: 'command', command: c })),
    ...results.map(r => ({ kind: 'task', ...r })),
  ], [commandResults, results])

  useEffect(() => { setActive(0) }, [query])

  const choose = useCallback((entry) => {
    if (!entry) return
    if (entry.kind === 'command') { entry.command.run(); onClose(); return }
    if (!entry.proj?.slug) return
    navigate(`/dashboard/${entry.proj.slug}?task=${entry.t.id}`)
    onClose()
  }, [navigate, onClose])

  function onKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, combined.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(combined[active]) }
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
            placeholder="Search tasks, or jump somewhere — try “flows” or “theme”…"
            className="flex-1 bg-transparent py-3.5 text-[14px] text-ink outline-none placeholder:text-mute-2"
          />
          <kbd className="shrink-0 text-[10px] font-mono text-mute-2 border border-line rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {combined.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-mute-2">No tasks or commands match “{query}”.</p>
          ) : (
            combined.map((entry, i) => entry.kind === 'command' ? (
              <button
                key={entry.command.id}
                onClick={() => choose(entry)}
                onMouseEnter={() => setActive(i)}
                className={clsx('w-full flex items-center gap-3 px-4 py-2 text-left transition-colors', i === active ? 'bg-surf-2' : 'hover:bg-surf-2/60')}
              >
                <Zap className="h-3 w-3 shrink-0 text-accent" />
                <span className="flex-1 min-w-0 truncate text-[13px] text-ink">{entry.command.label}</span>
                {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-mute-2" />}
              </button>
            ) : (
              <button
                key={entry.t.id}
                onClick={() => choose(entry)}
                onMouseEnter={() => setActive(i)}
                className={clsx('w-full flex items-center gap-3 px-4 py-2 text-left transition-colors', i === active ? 'bg-surf-2' : 'hover:bg-surf-2/60')}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[entry.t.status] || STATUS_DOT.pending)} />
                <span className={clsx('flex-1 min-w-0 truncate text-[13px]', entry.t.status === 'done' ? 'text-mute-2 line-through' : 'text-ink')}>
                  {entry.t.text || '(untitled)'}
                </span>
                {entry.ref && <span className="shrink-0 font-mono text-[10px] text-mute-2">{entry.ref}</span>}
                <span className="shrink-0 text-[10px] text-mute-2 max-w-[120px] truncate">{entry.proj?.name ?? '—'}</span>
                {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-mute-2" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
