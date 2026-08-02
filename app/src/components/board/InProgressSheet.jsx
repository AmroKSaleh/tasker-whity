import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTaskStore } from '../../store/useTaskStore'
import { useSheetDrag } from './hooks/useSheetDrag'

export default function InProgressSheet({ tasks, onClose, onToggleDone, onToggleInProgress }) {
  const { handlers, style } = useSheetDrag(onClose)
  const sections = useTaskStore(s => s.sections)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const tasksWithNames = tasks.map(t => ({
    ...t,
    sectionName: sections.find(s => s.id === t.section_id)?.name || '',
  }))
  const [featured, ...others] = tasksWithNames

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/30 animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-label="In progress"
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-sheet bg-paper shadow-sheet animate-sheet-up"
        style={{ height: '65vh', paddingBottom: 'max(22px, env(safe-area-inset-bottom))', ...style }}
      >
        <div className="touch-none pt-2 pb-1 flex justify-center" {...handlers}>
          <div className="h-1 w-9 rounded-sm bg-line" />
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6 pt-2">
          <div className="flex items-center justify-between">
            <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.1em] text-mute">
              In progress <span className="text-ink-2">· {tasks.length}</span>
            </h3>
            <button className="icon-btn" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {tasks.length === 0 && (
            <p className="py-6 text-center text-xs text-mute">No tasks in progress.</p>
          )}

          {featured && (
            <div className="flex flex-col gap-2 rounded-lg border border-ink bg-ink p-3.5 text-paper">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-paper/55">
                {featured.sectionName}
              </span>
              <p className="text-[15px] font-medium leading-snug">{featured.text}</p>
              {featured.due_date && (
                <div className="font-mono text-[10px] text-paper/60">
                  <span className="text-accent">● Due {featured.due_date}</span>
                </div>
              )}
              <div className="mt-1 flex gap-1.5">
                <button
                  onClick={() => { onToggleDone(featured); onClose() }}
                  className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white"
                >
                  Mark done
                </button>
                <button
                  onClick={() => onToggleInProgress(featured)}
                  className="rounded bg-white/10 px-2 py-1 text-[11px] font-medium text-paper"
                >
                  Remove
                </button>
              </div>
            </div>
          )}

          {others.map(t => (
            <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-line bg-paper p-3.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-mute">
                {t.sectionName}
              </span>
              <p className="text-sm font-medium leading-snug text-ink">{t.text}</p>
              {t.due_date && (
                <div className="font-mono text-[10px] text-mute">Due {t.due_date}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
