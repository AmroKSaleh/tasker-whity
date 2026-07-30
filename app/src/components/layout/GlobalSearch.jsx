import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const PRIORITY_COLORS = { rush: '#C0432D', high: '#D97757', medium: '#8C8055', low: '#6B6867' }

export default function GlobalSearch({ onClose }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const navigate    = useNavigate()
  const inputRef    = useRef(null)
  const debounceRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    const q = query.trim()
    if (!q) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('tasks')
          .select('id, text, detail, priority, status, project_id, section_id, projects(name, slug), sections(name)')
          .neq('status', 'done')
          .or(`text.ilike.%${q}%,detail.ilike.%${q}%`)
          .order('created_at', { ascending: false })
          .limit(20)
        setResults(data ?? [])
      } finally {
        setLoading(false)
      }
    }, 280)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  function handleSelect(result) {
    navigate(`/dashboard/${result.projects?.slug}?task=${result.id}`)
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-ink/30 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4 pointer-events-none">
        <div className="w-full max-w-lg bg-paper rounded-2xl shadow-xl overflow-hidden pointer-events-auto">

          {/* Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-line-2">
            <Search className="h-4 w-4 text-mute shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search tasks across all projects…"
              className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-mute-2 outline-none"
            />
            {loading && (
              <span className="font-mono text-[11px] text-mute animate-pulse shrink-0">···</span>
            )}
          </div>

          {/* Results */}
          {results.length > 0 && (
            <div className="max-h-[400px] overflow-y-auto py-1.5">
              {results.map(r => (
                <button
                  key={r.id}
                  onClick={() => handleSelect(r)}
                  className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-surf-2 transition-colors text-left"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-ink font-medium truncate">{r.text}</p>
                    <p className="text-[11px] text-mute mt-0.5 truncate">
                      {r.projects?.name}
                      {r.sections?.name ? ` · ${r.sections.name}` : ''}
                    </p>
                  </div>
                  {r.priority && (
                    <span
                      className="shrink-0 font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded mt-0.5"
                      style={{ color: PRIORITY_COLORS[r.priority], background: `${PRIORITY_COLORS[r.priority]}18` }}
                    >
                      {r.priority}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {query.trim() && !loading && results.length === 0 && (
            <div className="px-4 py-7 text-center">
              <p className="text-[13px] text-mute">No tasks found for "{query.trim()}"</p>
            </div>
          )}

          {!query.trim() && (
            <div className="px-4 py-5 text-center">
              <p className="text-[12px] text-mute-2">Type to search tasks across all projects</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
