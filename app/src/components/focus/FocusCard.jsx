import { useState } from 'react'
import Chip from '../ui/Chip'

export function FocusPrimaryCard({ task, onToggleDone, onToggleInProgress, onSkip }) {
  const [expanded, setExpanded] = useState(false)
  const projectLabel = task.project?.description || task.project?.name || ''

  return (
    <div
      style={{
        background: '#111111',
        color: '#ffffff',
        borderRadius: 14,
        padding: '16px 18px 18px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        marginBottom: 12,
      }}
    >
      {/* Top row */}
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono text-[10px] text-[#9a9a9a] tracking-wide">do this now →</span>
        <div className="flex-1" />
        {task.priority && <Chip priority={task.priority} light />}
      </div>

      {/* Title */}
      <div
        onClick={() => task.detail && setExpanded(e => !e)}
        className={`text-[17px] font-bold leading-snug mb-1 ${task.detail ? 'cursor-pointer' : ''} ${task.done ? 'line-through opacity-60' : ''}`}
      >
        {task.text}
      </div>

      {expanded && task.detail && (
        <p className="text-[12px] text-[#aaaaaa] leading-relaxed mb-2">{task.detail}</p>
      )}

      {/* Breadcrumb */}
      {projectLabel && (
        <div className="text-[11px] text-[#888888] mb-3">{projectLabel}</div>
      )}

      {/* Meta */}
      {task.due_date && (
        <div className="font-mono text-[9.5px] text-[#888888] mb-4 tracking-wide">
          ◷ {task.due_date}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {task.done ? (
          <button
            onClick={() => onToggleDone(task)}
            style={{ flex: 1, padding: '8px 0', textAlign: 'center', background: '#333', color: '#fff', borderRadius: 6, fontSize: 12, fontWeight: 600, border: 'none' }}
          >
            ✓ Done — Undo
          </button>
        ) : (
          <>
            <button
              onClick={() => onToggleInProgress(task)}
              style={{
                flex: 1, padding: '9px 0', textAlign: 'center',
                background: task.in_progress ? '#333' : '#ffffff',
                color: task.in_progress ? '#ffffff' : '#111111',
                borderRadius: 6, fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
              }}
            >
              {task.in_progress ? '▶ In Progress' : 'Start'}
            </button>
            <button
              onClick={() => onToggleDone(task)}
              style={{ padding: '9px 14px', border: '1px solid #444', color: '#ffffff', background: 'transparent', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Done
            </button>
            {onSkip && (
              <button
                onClick={() => onSkip(task)}
                style={{ padding: '9px 14px', border: '1px solid #444', color: '#aaaaaa', background: 'transparent', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
              >
                Skip
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function FocusQueueCard({ task, onToggleDone, onToggleInProgress }) {
  const [expanded, setExpanded] = useState(false)
  const projectLabel = task.project?.description || task.project?.name || ''

  return (
    <div
      style={{ borderBottom: '1px dashed #e6e6e6', opacity: task.done ? 0.5 : 1 }}
      className="flex items-start gap-2.5 px-3 py-2.5 last:border-b-0 hover:bg-surf transition-colors"
    >
      {/* Checkbox */}
      <button
        onClick={() => onToggleDone(task)}
        style={{
          width: 16, height: 16, borderRadius: 3,
          border: '1.25px solid #111',
          background: task.done ? '#111' : '#fff',
          flexShrink: 0, marginTop: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        {task.done && <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>✓</span>}
      </button>

      {/* In-progress toggle */}
      <button
        onClick={() => !task.done && onToggleInProgress(task)}
        disabled={task.done}
        style={{
          width: 16, height: 16, borderRadius: 3,
          border: '1.25px solid #cfcfcf',
          color: '#9a9a9a',
          background: '#fff',
          flexShrink: 0, marginTop: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 7, cursor: task.done ? 'default' : 'pointer',
          opacity: task.done ? 0.3 : 1,
        }}
        className="hover:border-ink hover:text-ink transition-colors"
      >
        ▶
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5 flex-wrap">
          <span
            onClick={() => task.detail && setExpanded(e => !e)}
            className={`flex-1 text-[13px] font-medium leading-snug ${task.detail ? 'cursor-pointer' : ''} ${
              task.done ? 'line-through text-mute' : 'text-ink'
            }`}
          >
            {task.text}
          </span>
          {task.priority && <Chip priority={task.priority} />}
          {task.due_date && !task.done && (
            <span className="font-mono text-[9.5px] text-mute" style={{ letterSpacing: '0.4px' }}>◷ {task.due_date}</span>
          )}
          {projectLabel && (
            <span className="font-mono text-[9px] text-mute-2" style={{ border: '1px solid #e6e6e6', padding: '1px 5px', borderRadius: 10 }}>
              {projectLabel}
            </span>
          )}
        </div>
        {expanded && task.detail && (
          <p className="mt-1 text-[12px] text-mute leading-relaxed">{task.detail}</p>
        )}
      </div>
    </div>
  )
}
