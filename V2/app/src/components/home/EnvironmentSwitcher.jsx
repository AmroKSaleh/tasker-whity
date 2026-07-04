import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { envColor } from '../../lib/envColor'

// Dropdown to switch the active Environment. Exclusive switching: picking one filters the
// project grid to that Environment. Hidden until at least one Environment exists.
export default function EnvironmentSwitcher({ environments, activeEnvironmentId, onSelect }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  if (!environments.length) return null
  const active = environments.find(e => e.id === activeEnvironmentId) ?? environments[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-line bg-paper text-[13px] text-ink hover:bg-surf-2 transition-colors"
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: envColor(active) }} />
        <span className="font-semibold">{active?.name ?? 'None'}</span>
        <span className="text-mute-2 text-[10px]">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 min-w-[180px] bg-paper border border-line rounded-lg shadow-card z-50 py-1">
          {environments.map(e => (
            <button
              key={e.id}
              onClick={() => { onSelect(e.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-[13px] hover:bg-surf-2 transition-colors flex items-center gap-2 ${
                e.id === active?.id ? 'text-ink font-semibold' : 'text-ink-2'
              }`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: envColor(e) }} />
              <span className="truncate flex-1">{e.name}</span>
              {e.id === active?.id && <span className="text-accent text-[11px]">✓</span>}
            </button>
          ))}
          <div className="border-t border-line-2 mt-1 pt-1">
            <button
              onClick={() => { setOpen(false); navigate('/environments') }}
              className="w-full text-left px-3 py-2 text-[12px] text-mute hover:bg-surf-2 hover:text-ink transition-colors flex items-center gap-2"
            >
              <span className="text-[11px]">⚙</span>
              <span>Manage environments…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
