import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Crosshair, ChevronDown } from 'lucide-react'
import { useAllTasks } from '../hooks/useAllTasks'
import { useGoogleCalendar } from '../hooks/useGoogleCalendar'
import { rankTasks } from '../lib/scoring'
import AppShell from '../components/editorial/AppShell'
import { Kicker, Chip, Pill, TaskRow, SectionHead, MiniCalendar } from '../components/editorial/atoms'
import TaskDetailSheet from '../components/board/TaskDetailSheet'
import FocusOverlay from '../components/focus/FocusOverlay'

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return week
}

function dateKicker(d) {
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
  const mo = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
  return `${wd} · ${mo} ${d.getDate()} · ${d.getFullYear()} · WEEK ${isoWeek(d)}`
}

// ── Bucket: editorial kicker + hairline + rows ──
function Bucket({ kicker, accent, tasks, onToggleDone, onToggleInProgress, onOpenTask, onStar }) {
  if (!tasks.length) return null
  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2.5 mb-1.5">
        <Kicker count={tasks.length} accent={accent}>{kicker}</Kicker>
        <span className="flex-1 h-px bg-line-2" />
      </div>
      <div className="flex flex-col gap-px">
        {tasks.map(t => (
          <TaskRow key={t.id} task={t} onToggle={onToggleDone} onToggleInProgress={onToggleInProgress} onOpen={onOpenTask} onStar={onStar} />
        ))}
      </div>
    </section>
  )
}

// ── Today's Focus hero card ──
function FocusCard({ task, rank, total, onBeginFocus, onMarkDone, onSkip }) {
  if (!task) return null
  const why = task.detail
    ? task.detail.slice(0, 180)
    : 'Highest-ranked task in your queue right now — clearing it first sets the day’s momentum.'
  return (
    <section className="relative overflow-hidden border border-line rounded-2xl bg-paper p-[18px] mb-7">
      <div className="absolute top-0 left-0 w-[3px] h-full bg-accent" />
      <div className="flex justify-between items-start mb-2.5">
        <Kicker>TODAY'S FOCUS{task.project?.prefix ? ` · ${task.project.prefix}` : ''}</Kicker>
        <span className="font-mono text-[9.5px] text-mute tracking-[0.1em]">
          RANKED · {String(rank).padStart(2, '0')} OF {String(total).padStart(2, '0')}
        </span>
      </div>
      <h2 className="text-h2 my-1 mb-2.5">{task.text}</h2>
      <p className="m-0 text-ink-2 max-w-[580px] text-[13px] leading-5">{why}</p>
      <div className="flex items-center gap-2.5 mt-4">
        <button className="btn-focus" onClick={() => onBeginFocus(task)}>
          <Crosshair size={13} /> Begin focus
        </button>
        <button className="btn btn-sm" onClick={() => onMarkDone(task)}>Mark done</button>
        <button className="btn btn-sm btn-ghost" onClick={() => onSkip(task)}>Skip</button>
        <div className="flex-1" />
        {task.priority && <Chip level={task.priority} />}
      </div>
    </section>
  )
}


function meetingTime(e) {
  if (e.start?.dateTime) return new Date(e.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return 'ALL DAY'
}
function meetingIsLive(e) {
  if (!e.start?.dateTime || !e.end?.dateTime) return false
  const n = Date.now()
  return new Date(e.start.dateTime) <= n && n <= new Date(e.end.dateTime)
}

function ActivitySection({ doneToday, onToggleDone, onOpenTask, onStar }) {
  const [open, setOpen] = useState(false)
  if (!doneToday.length) return null
  return (
    <section className="mt-2">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 py-2.5 w-full text-left">
        <ChevronDown size={12} className={clsx('text-mute transition-transform', !open && '-rotate-90')} />
        <Kicker count={doneToday.length}>ACTIVITY · COMPLETED TODAY</Kicker>
      </button>
      {open && (
        <div className="flex flex-col gap-px pl-4">
          {doneToday.map(t => (
            <TaskRow key={t.id} task={t} onToggle={onToggleDone} onOpen={onOpenTask} onStar={onStar} />
          ))}
        </div>
      )}
    </section>
  )
}

export default function TodayPage() {
  const { tasks, projects, toggleDone, toggleInProgress, setFocusDate, setPinned, loading } = useAllTasks()
  const { isConnected, fetchEvents } = useGoogleCalendar()
  const [calEvents, setCalEvents] = useState([])

  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null
  const openTask = (task) => setSelectedTaskId(task.id)
  const closeTask = () => setSelectedTaskId(null)

  const [focusTaskId, setFocusTaskId] = useState(null)
  const focusTask = focusTaskId ? tasks.find(t => t.id === focusTaskId) : null
  const openFocus = (taskId) => { setSelectedTaskId(null); setFocusTaskId(taskId) }
  const closeFocus = () => setFocusTaskId(null)

  const [skippedIds, setSkippedIds] = useState(() => new Set())
  const [projectFilter, setProjectFilter] = useState('all')

  const [undoToast, setUndoToast] = useState(null)
  useEffect(() => {
    if (!undoToast) return
    const id = setTimeout(() => setUndoToast(null), 6000)
    return () => clearTimeout(id)
  }, [undoToast])

  function handleToggleDone(task) {
    const wasPending = task.status !== 'done'
    toggleDone(task)
    if (wasPending) setUndoToast({ taskId: task.id, taskText: task.text })
    else if (undoToast?.taskId === task.id) setUndoToast(null)
  }
  function handleUndo() {
    if (!undoToast) return
    const live = tasks.find(t => t.id === undoToast.taskId)
    if (live) toggleDone(live)
    setUndoToast(null)
  }

  useEffect(() => {
    if (!isConnected) return
    const start = new Date(); start.setDate(start.getDate() - 7)
    const end = new Date(); end.setDate(end.getDate() + 90)
    fetchEvents(start.toISOString(), end.toISOString()).then(setCalEvents).catch(() => {})
  }, [isConnected, fetchEvents])

  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  const doneToday = tasks
    .filter(t => t.status === 'done' && t.completed_at?.slice(0, 10) === today)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))

  // Buckets with dedup — each task appears once, in its highest-priority bucket.
  const shownIds = new Set()
  const pick = (predicate) => {
    const picked = tasks.filter(t => !shownIds.has(t.id) && predicate(t))
    picked.forEach(t => shownIds.add(t.id))
    return picked
  }
  const overdueTasks    = pick(t => t.status !== 'done' && t.due_date && t.due_date < today)
  const carriedTasks    = pick(t => t.status !== 'done' && t.focus_date && t.focus_date < today)
  const dueTodayTasks   = pick(t => t.status !== 'done' && t.due_date === today)
  const inProgressTasks = pick(t => t.status === 'in_progress')
  const pinnedTasks     = pick(t => t.pinned && t.status !== 'done')
  const addedTodayTasks = pick(t => t.focus_date === today && t.status !== 'done')
  const queuedTasks     = tasks.filter(t => !shownIds.has(t.id) && t.status === 'pending')

  // Project filter applied to every bucket
  const pf = (list) => projectFilter === 'all' ? list : list.filter(t => t.project_id === projectFilter)

  // Top focus task for the hero + masthead
  const ranked = rankTasks(tasks.filter(t => t.status !== 'done'))
  const topIndex = ranked.findIndex(t => !skippedIds.has(t.id))
  const topFocus = topIndex >= 0 ? ranked[topIndex] : null

  // Progress glance numbers
  const doneCount = doneToday.length
  const inProgressCount = inProgressTasks.length
  const queuedCount = tasks.filter(t => t.status === 'pending').length
  const totalActive = tasks.filter(t => t.status !== 'done').length

  // Project filter pill counts (non-done per project)
  const nonDone = tasks.filter(t => t.status !== 'done')
  const projCounts = {}
  nonDone.forEach(t => { projCounts[t.project_id] = (projCounts[t.project_id] || 0) + 1 })

  // Right-rail data
  const todayMeetings = calEvents
    .filter(e => !e.extendedProperties?.private?.taskerId)
    .filter(e => (e.start?.date || e.start?.dateTime?.slice(0, 10)) === today)
    .sort((a, b) => (a.start?.dateTime || a.start?.date || '').localeCompare(b.start?.dateTime || b.start?.date || ''))

  const monthPrefix = today.slice(0, 7)
  const calHighlights = [...new Set(
    tasks.filter(t => t.status !== 'done' && t.due_date?.startsWith(monthPrefix))
      .map(t => Number(t.due_date.slice(8, 10)))
  )]
  const firstDow = (new Date(now.getFullYear(), now.getMonth(), 1).getDay() + 6) % 7
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  const rightRail = (
    <aside className="w-80 shrink-0 border-l border-line-2 bg-surf-2 px-6 py-8 overflow-auto no-scrollbar">
      <SectionHead kicker="TODAY'S MEETINGS" count={todayMeetings.length} />
      <div className="flex flex-col gap-0.5 mb-7">
        {todayMeetings.length === 0 ? (
          <p className="text-[12px] text-mute-2 px-2.5">No meetings today.</p>
        ) : todayMeetings.map(m => {
          const live = meetingIsLive(m)
          return (
            <div key={m.id} className={clsx(
              'relative flex items-center gap-3 px-2.5 py-2 rounded-lg border',
              live ? 'bg-paper border-line-2' : 'border-transparent',
            )}>
              {live && <span className="absolute left-[-3px] top-3 bottom-3 w-0.5 bg-accent rounded-sm" />}
              <span className="font-mono text-[11px] text-ink-2 font-bold min-w-[38px]">{meetingTime(m)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold text-ink truncate">{m.summary}</div>
                {live && <div className="font-mono text-[9.5px] text-accent tracking-[0.06em]">NOW</div>}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mb-7">
        <MiniCalendar
          today={now.getDate()}
          month={now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
          year={now.getFullYear()}
          highlights={calHighlights}
          daysInMonth={daysInMonth}
          firstDow={firstDow}
        />
      </div>
    </aside>
  )

  return (
    <>
      <AppShell active="today" rightRail={!loading && tasks.length > 0 ? rightRail : null}>
        <div className="max-w-[760px] mx-auto px-7 pt-8 pb-20">
          {loading ? (
            <p className="text-[13px] text-mute py-20 text-center">Loading…</p>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <p className="text-[32px] mb-3">◎</p>
              <p className="text-[15px] font-semibold text-ink mb-1">Start planning</p>
              <p className="text-[13px] text-mute mb-5">Create your first project to start tracking tasks here.</p>
              <Link to="/projects" className="btn">Go to Projects →</Link>
            </div>
          ) : (
            <>
              {/* Masthead */}
              <header className="mb-7">
                <Kicker className="mb-2.5">{dateKicker(now)}</Kicker>
                <div className="flex items-baseline justify-between">
                  <h1 className="text-h1 m-0">Today.</h1>
                  {topFocus && (
                    <button className="btn btn-sm" onClick={() => openFocus(topFocus.id)}>
                      <Crosshair size={12} /> Focus
                    </button>
                  )}
                </div>
                <div className="mt-3.5 flex items-center gap-[22px] font-mono text-[11px] text-mute tracking-[0.06em]">
                  <span><span className="text-ink font-bold">{String(doneCount).padStart(2, '0')}</span> done today</span>
                  <span><span className="text-ink font-bold">{String(inProgressCount).padStart(2, '0')}</span> in progress</span>
                  <span><span className="text-ink font-bold">{String(queuedCount).padStart(2, '0')}</span> queued</span>
                  <span className="flex-1 h-px bg-line-2" />
                  <span className="text-mute-2">{doneCount} / {doneCount + totalActive} today</span>
                </div>
              </header>

              {/* Today's Focus hero */}
              <FocusCard
                task={topFocus}
                rank={topIndex + 1}
                total={ranked.length}
                onBeginFocus={t => openFocus(t.id)}
                onMarkDone={handleToggleDone}
                onSkip={t => setSkippedIds(prev => new Set(prev).add(t.id))}
              />

              {/* Project filter pills */}
              <div className="flex gap-1.5 mb-5 flex-wrap">
                <Pill active={projectFilter === 'all'} count={nonDone.length} onClick={() => setProjectFilter('all')}>All</Pill>
                {projects.filter(p => projCounts[p.id]).map(p => (
                  <Pill key={p.id} active={projectFilter === p.id} count={projCounts[p.id]} onClick={() => setProjectFilter(p.id)}>
                    {p.prefix || p.name}
                  </Pill>
                ))}
              </div>

              {/* Buckets */}
              <Bucket kicker="OVERDUE" accent tasks={pf(overdueTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="CARRIED FROM YESTERDAY" tasks={pf(carriedTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="DUE TODAY" tasks={pf(dueTodayTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="IN PROGRESS" tasks={pf(inProgressTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="PINNED" tasks={pf(pinnedTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="ADDED TO TODAY" tasks={pf(addedTodayTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
              <Bucket kicker="QUEUED" tasks={pf(queuedTasks)} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />

              <ActivitySection doneToday={doneToday} onToggleDone={handleToggleDone} onToggleInProgress={toggleInProgress} onOpenTask={openTask} onStar={setPinned} />
            </>
          )}
        </div>
      </AppShell>

      {selectedTask && (
        <TaskDetailSheet taskId={selectedTask.id} onClose={closeTask} project={selectedTask.project} onFocus={openFocus} compact />
      )}

      {focusTask && (
        <FocusOverlay tasks={tasks} project={focusTask.project} onClose={closeFocus} onToggleDone={handleToggleDone} initialTaskId={focusTask.id} />
      )}

      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3.5 rounded-[10px] bg-ink text-paper px-3.5 py-2.5 shadow-lg">
          <span className="text-[12px] truncate max-w-[260px]">Marked done — {undoToast.taskText}</span>
          <button onClick={handleUndo} className="font-mono text-[10px] tracking-[0.1em] uppercase text-accent font-bold">Undo</button>
        </div>
      )}
    </>
  )
}
