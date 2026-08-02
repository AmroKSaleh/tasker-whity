function formatTime(event) {
  if (event.start?.dateTime) {
    return new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return 'All day'
}

function formatHeader(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

export default function CellDetailPopover({ date, tasks, events, onAddTask, onClose, onTaskClick }) {
  const realEvents = events.filter(e => !e.extendedProperties?.private?.taskerId)
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-[420px] mx-4 shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-line-2">
          <p className="text-[15px] font-semibold text-ink">{formatHeader(date)}</p>
        </div>

        <div className="px-5 py-3 max-h-[60vh] overflow-y-auto">
          {tasks.length === 0 && realEvents.length === 0 && (
            <p className="text-[13px] text-mute py-4 text-center">Nothing scheduled.</p>
          )}

          {tasks.length > 0 && (
            <div className="mb-3">
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-1.5">Tasks ({tasks.length})</p>
              <ul className="space-y-0.5">
                {tasks.map(t => (
                  <li key={t.id}>
                    <button
                      onClick={() => onTaskClick?.(t)}
                      className="w-full flex items-start gap-2 text-[13px] px-1.5 py-1 rounded hover:bg-surf-2 transition-colors text-left"
                    >
                      <span className="text-mute-2 mt-0.5">{t.status === 'done' ? '✓' : '○'}</span>
                      <span className={`flex-1 ${t.status === 'done' ? 'line-through text-mute' : 'text-ink'}`}>
                        {t.text}
                      </span>
                      {t.project?.name && (
                        <span className="font-mono text-[9px] uppercase text-mute-2 shrink-0 mt-0.5">{t.project.name}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {realEvents.length > 0 && (
            <div>
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-1.5">Events ({realEvents.length})</p>
              <ul className="space-y-1.5">
                {realEvents.map(e => (
                  <li key={e.id} className="flex items-start gap-2 text-[13px] px-1.5 py-1">
                    <span className="font-mono text-[10px] text-mute-2 w-12 shrink-0 mt-0.5">{formatTime(e)}</span>
                    <span className="flex-1 text-ink-2">{e.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[13px] text-mute hover:text-ink transition-colors">
            Close
          </button>
          <button onClick={onAddTask}
            className="px-3 py-1.5 rounded-lg bg-ink text-paper text-[13px] font-medium">
            + Add Task
          </button>
        </div>
      </div>
    </div>
  )
}