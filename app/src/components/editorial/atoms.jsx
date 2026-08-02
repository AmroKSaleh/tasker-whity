import { useState } from 'react'
import clsx from 'clsx'
import { Star, Play, ChevronLeft, ChevronRight } from 'lucide-react'

// ── Kicker — the editorial mono section label ──
export function Kicker({ children, count, total, className = '', accent = false }) {
  return (
    <span className={clsx('kicker', className)} style={accent ? { color: 'var(--color-priority-rush)' } : undefined}>
      <span>{children}</span>
      {total != null ? (
        <span className="ml-1.5 font-medium text-mute" title="Completed / total tasks">{count ?? 0}/{total}</span>
      ) : count != null && (
        <span className="ml-1.5 font-medium text-mute">{String(count).padStart(2, '0')}</span>
      )}
    </span>
  )
}

// ── Priority chip ──
const CHIP = {
  rush:   { cls: 'bg-ink text-paper',                              label: 'RUSH' },
  high:   { cls: 'bg-ink-2 text-paper',                            label: 'HIGH' },
  medium: { cls: 'text-ink-2 border border-line',                 label: 'MED'  },
  low:    { cls: 'text-mute border border-dashed border-mute-2',  label: 'LOW'  },
}
export function Chip({ level }) {
  const m = CHIP[level]
  if (!m) return null
  return (
    <span className={clsx(
      'inline-flex items-center justify-center h-4 px-1.5 min-w-[32px] rounded-[4px]',
      'font-mono text-[9px] font-bold tracking-[0.08em] uppercase whitespace-nowrap',
      m.cls,
    )}>{m.label}</span>
  )
}

// ── Filter pill ──
export function Pill({ active, count, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-pill border',
        'font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase transition-colors',
        active
          ? 'bg-ink text-paper border-ink'
          : 'bg-transparent text-mute border-line hover:text-ink-2 hover:border-mute-2',
      )}
    >
      <span>{children}</span>
      {count != null && (
        <span className={active ? 'text-line' : 'text-mute'}>{String(count).padStart(2, '0')}</span>
      )}
    </button>
  )
}

// ── Task row (compact, editorial) ──
function formatDue(task) {
  if (task.dueLabel) return task.dueLabel
  if (!task.due_date) return null
  const d = new Date(task.due_date)
  if (isNaN(d)) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

export function TaskRow({ task, onToggle, onToggleInProgress, onOpen, onStar, dense = false, showProject = true, envBadge = null }) {
  const done = task.status === 'done'
  const ip = task.status === 'in_progress'
  const due = formatDue(task)
  const projectLabel = task.project?.prefix || task.projectLabel
  return (
    <div
      onClick={() => onOpen?.(task)}
      className={clsx(
        'group flex items-center gap-2.5 rounded-lg cursor-pointer transition-colors hover:bg-surf-2',
        dense ? 'px-2.5 py-1.5' : 'px-3 py-2',
      )}
    >
      <input
        type="checkbox"
        className="tcheck"
        checked={done}
        onClick={e => e.stopPropagation()}
        onChange={() => onToggle?.(task)}
      />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className={clsx(
          'flex-1 min-w-0 truncate text-[13px] font-medium',
          done ? 'text-mute-2 line-through' : 'text-ink',
        )}>{task.text}</span>
        {envBadge && (
          <span
            className="inline-flex items-center gap-1 shrink-0 font-mono text-[9px] tracking-[0.04em] text-mute uppercase"
            title={`Environment: ${envBadge.name}`}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: envBadge.color }} />
            {envBadge.name}
          </span>
        )}
        {showProject && projectLabel && (
          <span className="font-mono text-[10px] tracking-[0.04em] text-mute shrink-0">{projectLabel}</span>
        )}
      </div>
      {task.priority && <Chip level={task.priority} />}
      {due && (
        <span className="font-mono text-[10px] text-mute min-w-[44px] text-right">{due}</span>
      )}
      {onToggleInProgress && !done && (
        <button
          onClick={e => { e.stopPropagation(); onToggleInProgress(task) }}
          title={ip ? 'Stop progress' : 'Mark in progress'}
          className={clsx(
            'w-[22px] h-[22px] inline-flex items-center justify-center transition-opacity',
            ip ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100 text-mute-2 hover:text-ink',
          )}
        >
          <Play size={11} fill={ip ? 'currentColor' : 'none'} />
        </button>
      )}
      <button
        onClick={e => { e.stopPropagation(); onStar?.(task) }}
        title={task.pinned ? 'Unpin' : 'Pin to top'}
        className={clsx(
          'w-[22px] h-[22px] inline-flex items-center justify-center transition-opacity',
          task.pinned ? 'opacity-100 text-star' : 'opacity-0 group-hover:opacity-100 text-mute-2 hover:text-star',
        )}
      >
        <Star size={13} fill={task.pinned ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

// ── Section head (kicker + count + optional action) ──
export function SectionHead({ kicker, count, action, children }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <div className="flex items-baseline gap-2.5">
        <Kicker count={count}>{kicker}</Kicker>
        {children}
      </div>
      {action}
    </div>
  )
}

// ── Mini month calendar ──
const DOWS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
export function MiniCalendar({ today, month, year, highlights = [], daysInMonth = 30, firstDow = 2 }) {
  const cells = []
  for (let i = 0; i < 35; i++) {
    const day = i - firstDow + 1
    const valid = day >= 1 && day <= daysInMonth
    const isToday = valid && day === today
    const hot = valid && highlights.includes(day)
    cells.push(
      <div
        key={i}
        className={clsx(
          'h-[26px] flex items-center justify-center rounded-md relative font-mono text-[11px] font-medium',
          !valid ? 'text-transparent' : isToday ? 'text-paper bg-ink' : hot ? 'text-ink' : 'text-mute',
        )}
      >
        {valid ? day : ''}
        {hot && !isToday && (
          <span className="absolute bottom-0.5 w-[3px] h-[3px] rounded-full bg-accent" />
        )}
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Kicker>{month} {year}</Kicker>
        <div className="flex gap-0.5">
          <button className="icon-btn w-5 h-5"><ChevronLeft size={11} /></button>
          <button className="icon-btn w-5 h-5"><ChevronRight size={11} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {DOWS.map((d, i) => (
          <div key={i} className="font-mono text-[9px] text-center text-mute-2 tracking-[0.1em] uppercase">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">{cells}</div>
    </div>
  )
}
