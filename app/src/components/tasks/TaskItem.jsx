import { useState, useEffect, useRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Chip from '../ui/Chip'
import EditTaskModal from './EditTaskModal'

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

const NON_DISPLAY_TAGS = ['reference']

export default function TaskItem({
  task,
  prefix,
  isDraggable = false,
  onToggleDone,
  onToggleInProgress,
  onDelete,
  onSelect,
  onFocus,
  onPin,
  hideWhenInProgress = true,
  progress = 0,
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [tapped, setTapped] = useState(false)
  const itemRef = useRef(null)

  useEffect(() => {
    if (!tapped) return
    function onOutside(e) {
      if (itemRef.current && !itemRef.current.contains(e.target)) setTapped(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    return () => document.removeEventListener('pointerdown', onOutside, true)
  }, [tapped])

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !isDraggable,
    data: { type: 'task', sectionId: task.section_id, groupId: task.group_id },
  })

  const isReference = task.tags?.includes('reference')
  const isDone = task.status === 'done'
  const isInProgress = task.status === 'in_progress'
  const displayTags = (task.tags || []).filter(t => !NON_DISPLAY_TAGS.includes(t))
  const today = new Date().toISOString().split('T')[0]
  const isOverdue = !isDone && task.due_date && task.due_date < today

  if (isInProgress && hideWhenInProgress) return null

  const showProgress = progress > 0 && !isDone

  return (
    <>
      <div
        ref={node => { setNodeRef(node); itemRef.current = node }}
        style={{
          position: 'relative',
          opacity: isDragging ? 0.35 : isDone ? 0.5 : 1,
          transform: CSS.Transform.toString(transform),
          transition,
        }}
        className="group border-b border-line-2"
      >

        {/* Full-height progress background fill */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0, top: 0, bottom: 0,
            width: showProgress ? `${progress}%` : '0%',
            background: 'rgba(217,119,87,0.18)',
            transition: 'width 0.4s ease',
            zIndex: 0,
            pointerEvents: 'none',
          }}
        />

        {/* Content */}
        <div
          className={`relative flex items-start gap-2.5 px-3 pt-2.5 pb-2 transition-colors ${
            !isDone && !showProgress ? 'hover:bg-surf' : ''
          }`}
          style={{ zIndex: 1 }}
        >
          {/* Drag handle */}
          {isDraggable && (
            <button
              {...attributes}
              {...listeners}
              tabIndex={-1}
              style={{ cursor: 'grab', touchAction: 'none' }}
              className="shrink-0 mt-2 opacity-0 group-hover:opacity-100 transition-opacity text-mute hover:text-ink-2 text-[11px] leading-none px-0.5"
            >
              ⠿
            </button>
          )}

          {/* Checkbox */}
          <button
            onClick={() => !isReference && onToggleDone(task)}
            disabled={isReference}
            aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
            style={{
              width: 16, height: 16, borderRadius: 3,
              border: '1.25px solid var(--color-ink)',
              background: isDone ? 'var(--color-ink)' : 'var(--color-paper)',
              flexShrink: 0, marginTop: 2,
              cursor: isReference ? 'default' : 'pointer',
              opacity: isReference ? 0.3 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {isDone && (
              <span style={{ color: 'var(--color-paper)', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>✓</span>
            )}
          </button>

          {/* In-progress toggle */}
          <button
            onClick={() => !isReference && !isDone && onToggleInProgress(task)}
            disabled={isReference || isDone}
            title="Mark as in progress"
            style={{
              width: 16, height: 16, borderRadius: 3,
              border: '1.25px solid var(--color-line)',
              color: 'var(--color-mute-2)',
              background: 'transparent',
              flexShrink: 0, marginTop: 2,
              cursor: isReference || isDone ? 'default' : 'pointer',
              opacity: isReference || isDone ? 0.3 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 7,
            }}
            className="hover:border-ink hover:text-ink transition-colors"
          >
            ▶
          </button>

          {/* Text + bottom row */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {task.task_statuses?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {task.task_statuses.map(ts => ts.status).filter(Boolean).map(s => (
                  <span key={s.id} style={{ backgroundColor: s.color, color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 3 }}>
                    {s.name}
                  </span>
                ))}
              </div>
            )}
            {/* Task text — full width */}
            <span
              onClick={() => {
                if (onSelect) { onSelect(task.id) }
                else if (task.detail || task.relay_context) { setExpanded(e => !e) }
              }}
              className={`text-[13px] font-medium leading-snug line-clamp-3 ${(task.detail || task.relay_context || onSelect) ? 'cursor-pointer' : ''} ${
                isDone ? 'line-through text-mute' : 'text-ink'
              }`}
            >
              {task.text}
            </span>

            {expanded && task.relay_context && (
              <div className="bg-surf rounded-md p-2 mb-0.5 border border-line-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-mute mb-1 block">[Recording context for the task]</span>
                <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">{task.relay_context}</p>
              </div>
            )}

            {expanded && task.detail && (
              <p className="text-[12px] text-mute leading-relaxed whitespace-pre-wrap">{task.detail}</p>
            )}

            {/* Bottom row: priority/tags on left, actions on right */}
            <div className="flex items-center justify-between gap-2 mt-0.5 min-h-[28px]">
              {/* Left: short ID + priority chip + due date + tags */}
              <div className="flex items-center gap-1 flex-wrap">
                {prefix && task.short_id != null && (
                  <span className="font-mono text-[9px] text-mute-2 border border-line rounded px-1 py-px shrink-0">
                    {prefix}-{task.short_id}
                  </span>
                )}
                {task.review_verdict && (
                  <span
                    className="font-mono text-[9px] rounded px-1 py-px shrink-0 border"
                    title={`Task-level review ${(task.review_verdict.overall || '').toUpperCase()}`}
                    style={{
                      color: task.review_verdict.overall === 'pass' ? '#16a34a' : '#dc2626',
                      borderColor: task.review_verdict.overall === 'pass' ? '#86efac' : '#fca5a5',
                    }}
                  >
                    {task.review_verdict.overall === 'pass' ? '✓ review' : '✗ review'}
                  </span>
                )}
                {task.priority && <Chip priority={task.priority} />}
                {task.due_date && !isDone && (
                  <span
                    className="font-mono text-[9.5px]"
                    style={{ letterSpacing: '0.4px', color: isOverdue ? '#ef4444' : 'var(--color-mute-2)', fontWeight: isOverdue ? 600 : 400 }}
                  >
                    {isOverdue ? '⚠ ' : '◷ '}{task.due_date}
                  </span>
                )}
                {displayTags.map(tag => (
                  <span
                    key={tag}
                    className="font-mono text-[9px] text-ink"
                    style={{ border: '1px solid #cfcfcf', padding: '1px 5px', borderRadius: 10 }}
                  >
                    #{tag === 'here' ? 'you-are-here' : tag === 'abed' ? 'needs-abed' : tag}
                  </span>
                ))}
              </div>

              {/* Right: 2×2 action grid */}
              {!isReference && (
                <div className={`relative shrink-0 transition-opacity ${
                  task.pinned || tapped ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}>
                  {isTouch && !tapped && (
                    <div
                      className="absolute inset-0"
                      style={{ zIndex: 10 }}
                      onClick={e => { e.stopPropagation(); setTapped(true) }}
                    />
                  )}
                  <div className="grid grid-cols-2 gap-0.5">
                    {onPin && (
                      <button
                        onClick={() => onPin(task.id)}
                        title={task.pinned ? 'Remove top priority' : 'Set as top priority'}
                        className={`w-7 h-7 flex items-center justify-center rounded text-[13px] transition-colors ${
                          task.pinned ? 'text-star' : 'text-mute hover:text-star'
                        }`}
                      >
                        ★
                      </button>
                    )}
                    {onFocus && (
                      <button
                        onClick={() => onFocus(task.id)}
                        title="Focus on this task"
                        className="icon-btn-focus text-[13px]"
                      >
                        ◎
                      </button>
                    )}
                    {onDelete && (
                      <button
                        onClick={() => onDelete(task.id)}
                        title="Delete task"
                        className="w-7 h-7 flex items-center justify-center rounded text-[13px] text-mute hover:text-red-500 transition-colors"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {editing && <EditTaskModal task={task} onClose={() => setEditing(false)} />}
    </>
  )
}
