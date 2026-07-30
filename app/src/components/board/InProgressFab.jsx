import { useState, useEffect } from 'react'
import { Play } from 'lucide-react'
import InProgressSheet from './InProgressSheet'

export default function InProgressFab({ count = 0, tasks = [], onToggleDone, onToggleInProgress }) {
  const [open, setOpen] = useState(false)
  const [keyboardUp, setKeyboardUp] = useState(false)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const check = () => setKeyboardUp(vv.height < window.innerHeight * 0.75)
    vv.addEventListener('resize', check)
    return () => vv.removeEventListener('resize', check)
  }, [])

  if (keyboardUp) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed z-30 flex items-center gap-1.5 rounded-full bg-ink text-paper px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-[0.06em] shadow-fab"
        style={{
          right: '14px',
          bottom: 'max(72px, calc(env(safe-area-inset-bottom) + 72px))',
        }}
      >
        <Play className="h-3 w-3" />
        In progress
        {count > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <InProgressSheet
          tasks={tasks}
          onClose={() => setOpen(false)}
          onToggleDone={onToggleDone}
          onToggleInProgress={onToggleInProgress}
        />
      )}
    </>
  )
}
