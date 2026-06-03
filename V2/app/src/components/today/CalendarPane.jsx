import { useState, useMemo } from 'react'
import CellDetailPopover from './CellDetailPopover'
import AddTaskModal from './AddTaskModal'
import EditTaskModal from '../tasks/EditTaskModal'

const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function toISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function startOfWeekMon(d) {
  const wd = d.getDay()
  const diff = wd === 0 ? -6 : 1 - wd
  return addDays(d, diff)
}

function weekRange(anchor) {
  const start = startOfWeekMon(anchor)
  const end = addDays(start, 6)
  const startStr = `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()}`
  const endStr = start.getMonth() === end.getMonth()
    ? `${end.getDate()}`
    : `${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}`
  return `${startStr} – ${endStr}`
}

export default function CalendarPane({ tasks, events }) {
  const [view, setView] = useState('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(null)
  const [addingForDate, setAddingForDate] = useState(null)
  const [editingTask, setEditingTask] = useState(null)

  const today = toISO(new Date())

  const handleCellClick = (iso) => setSelectedDate(iso)
  const handleTaskClick = (task) => { setSelectedDate(null); setEditingTask(task) }

  const tasksForSelected = selectedDate ? tasks.filter(t => t.due_date === selectedDate) : []
  const eventsForSelected = selectedDate ? events.filter(e => {
    const d = e.start?.date || e.start?.dateTime?.slice(0, 10)
    return d === selectedDate
  }) : []

  const tasksByDate = useMemo(() => {
    const map = {}
    for (const t of tasks) {
      if (t.due_date && t.status !== 'done') {
        (map[t.due_date] ??= []).push(t)
      }
    }
    return map
  }, [tasks])

  // Filter out events that are synced from tasks (extendedProperties.private.taskerId)
  // — those would double-count with the deadline dots.
  const eventsByDate = useMemo(() => {
    const map = {}
    for (const e of events) {
      if (e.extendedProperties?.private?.taskerId) continue
      const d = e.start?.date || e.start?.dateTime?.slice(0, 10)
      if (d) (map[d] ??= []).push(e)
    }
    return map
  }, [events])

  function navigate(delta) {
    if (view === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
    } else {
      setAnchor(addDays(anchor, delta * 7))
    }
  }

  const headerLabel = view === 'month'
    ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
    : weekRange(anchor)

  return (
    <>
    <div className="bg-paper border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line-2">
        <button
          onClick={() => navigate(-1)}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-surf-2 text-mute hover:text-ink leading-none"
        >
          ‹
        </button>
        <span className="font-mono text-[11px] font-semibold text-ink">{headerLabel}</span>
        <button
          onClick={() => navigate(1)}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-surf-2 text-mute hover:text-ink leading-none"
        >
          ›
        </button>
      </div>

      <div className="px-3 py-2">
        {view === 'month' ? (
          <MonthGrid
            anchor={anchor}
            today={today}
            tasksByDate={tasksByDate}
            eventsByDate={eventsByDate}
            onCellClick={handleCellClick}
          />
        ) : (
          <WeekStrip
            anchor={anchor}
            today={today}
            tasksByDate={tasksByDate}
            eventsByDate={eventsByDate}
            onCellClick={handleCellClick}
            onTaskClick={handleTaskClick}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-1 px-3 py-2 border-t border-line-2">
        <div className="flex items-center gap-2 font-mono text-[8px] text-mute-2 uppercase tracking-widest">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#C0432D' }} />deadline</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#D97757' }} />event</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('month')}
            className={`font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${view === 'month' ? 'bg-ink text-paper' : 'text-mute-2 hover:bg-surf-2'}`}
          >
            Month
          </button>
          <button
            onClick={() => setView('week')}
            className={`font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${view === 'week' ? 'bg-ink text-paper' : 'text-mute-2 hover:bg-surf-2'}`}
          >
            Week
          </button>
        </div>
      </div>
    </div>

    {selectedDate && (
      <CellDetailPopover
        date={selectedDate}
        tasks={tasksForSelected}
        events={eventsForSelected}
        onAddTask={() => { setAddingForDate(selectedDate); setSelectedDate(null) }}
        onClose={() => setSelectedDate(null)}
        onTaskClick={handleTaskClick}
      />
    )}

    {addingForDate && (
      <AddTaskModal
        initialDueDate={addingForDate}
        onClose={() => setAddingForDate(null)}
      />
    )}

    {editingTask && (
      <EditTaskModal
        task={editingTask}
        onClose={() => setEditingTask(null)}
      />
    )}
    </>
  )
}

function MonthGrid({ anchor, today, tasksByDate, eventsByDate, onCellClick }) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = startOfWeekMon(monthStart)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  return (
    <div>
      <div className="grid grid-cols-7 mb-1">
        {DAY_LABELS.map(d => (
          <span key={d} className="text-center font-mono text-[8px] text-mute-2 uppercase">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((date, i) => {
          const iso = toISO(date)
          const isToday = iso === today
          const inMonth = date.getMonth() === anchor.getMonth()
          const hasDeadline = (tasksByDate[iso]?.length ?? 0) > 0
          const hasEvent = (eventsByDate[iso]?.length ?? 0) > 0
          return (
            <button
              key={i}
              onClick={() => onCellClick?.(iso)}
              className={`aspect-square flex flex-col items-center justify-center rounded text-[10px] transition-colors ${
                isToday ? 'bg-ink text-paper font-semibold'
                : inMonth ? 'text-ink hover:bg-surf-2'
                : 'text-mute-2 hover:bg-surf-2'
              }`}
            >
              <span className="leading-none">{date.getDate()}</span>
              <div className="flex gap-0.5 mt-1 h-[4px]">
                {hasDeadline && <span className="w-1 h-1 rounded-full" style={{ background: isToday ? 'var(--color-paper)' : '#C0432D' }} />}
                {hasEvent && <span className="w-1 h-1 rounded-full" style={{ background: isToday ? 'var(--color-paper)' : '#D97757' }} />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function formatEventTime(event) {
  if (event.start?.dateTime) {
    return new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return null
}

function WeekStrip({ anchor, today, tasksByDate, eventsByDate, onCellClick, onTaskClick }) {
  const weekStart = startOfWeekMon(anchor)
  const cells = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="flex flex-col gap-0.5">
      {cells.map((date, i) => {
        const iso = toISO(date)
        const isToday = iso === today
        const dayTasks = tasksByDate[iso] ?? []
        const dayEvents = eventsByDate[iso] ?? []
        const empty = dayTasks.length === 0 && dayEvents.length === 0
        return (
          <div key={i} className={`flex items-stretch rounded border ${isToday ? 'border-ink' : 'border-line-2'}`}>
            <button
              onClick={() => onCellClick?.(iso)}
              className={`flex flex-col items-center justify-center px-1.5 py-1.5 w-12 shrink-0 rounded-l transition-colors ${
                isToday ? 'bg-ink text-paper' : 'hover:bg-surf-2 text-ink'
              }`}
            >
              <span className="font-mono text-[8px] uppercase opacity-70 leading-none">{DAY_LABELS[i]}</span>
              <span className="text-[14px] font-semibold leading-tight mt-0.5">{date.getDate()}</span>
            </button>
            <div className="flex-1 min-w-0 px-2 py-1 flex flex-col justify-center gap-0.5">
              {empty ? (
                <span className="text-[10px] text-mute-2">—</span>
              ) : (
                <>
                  {dayTasks.map(t => (
                    <button
                      key={t.id}
                      onClick={() => onTaskClick?.(t)}
                      title={t.text}
                      className="text-[11px] text-ink text-left truncate leading-tight hover:underline flex items-center gap-1"
                    >
                      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: '#C0432D' }} />
                      <span className="truncate">{t.text}</span>
                    </button>
                  ))}
                  {dayEvents.map(e => {
                    const time = formatEventTime(e)
                    return (
                      <span key={e.id} title={e.summary} className="text-[11px] text-mute-2 truncate leading-tight flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full shrink-0" style={{ background: '#D97757' }} />
                        {time && <span className="font-mono text-[9px] shrink-0">{time}</span>}
                        <span className="truncate">{e.summary}</span>
                      </span>
                    )
                  })}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}