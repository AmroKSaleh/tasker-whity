import { useState } from 'react'
import Chip from '../ui/Chip'
import EditTaskModal from './EditTaskModal'

const NON_DISPLAY_TAGS = ['reference']

const stripeStyle = {
  backgroundImage: 'repeating-linear-gradient(45deg, #111 0 2px, #fff 2px 4px)',
}

export default function TaskItem({ task, onToggleDone, onToggleInProgress, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const isReference = task.tags?.includes('reference')
  const isInProgress = task.in_progress && !task.done
  const displayTags = (task.tags || []).filter(t => !NON_DISPLAY_TAGS.includes(t))

  if (isInProgress) return null

  return (
    <>
      <div
        style={{ borderBottom: '1px dashed #e6e6e6', opacity: task.done ? 0.5 : 1 }}
        className={`flex items-start gap-2.5 px-3 py-2.5 last:border-b-0 transition-colors group ${
          !task.done ? 'hover:bg-surf' : ''
        }`}
      >
        {/* Checkbox */}
        <button
          onClick={() => !isReference && onToggleDone(task)}
          disabled={isReference}
          aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}
          style={{
            width: 16, height: 16, borderRadius: 3,
            border: '1.25px solid #111',
            background: task.done ? '#111111' : '#ffffff',
            flexShrink: 0, marginTop: 2,
            cursor: isReference ? 'default' : 'pointer',
            opacity: isReference ? 0.3 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {task.done && (
            <span style={{ color: '#ffffff', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>✓</span>
          )}
        </button>

        {/* In-progress toggle */}
        <button
          onClick={() => !isReference && !task.done && onToggleInProgress(task)}
          disabled={isReference || task.done}
          title="Mark as in progress"
          style={{
            width: 16, height: 16, borderRadius: 3,
            border: '1.25px solid #cfcfcf',
            color: '#9a9a9a',
            background: '#ffffff',
            flexShrink: 0, marginTop: 2,
            cursor: isReference || task.done ? 'default' : 'pointer',
            opacity: isReference || task.done ? 0.3 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 7,
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
              <span className="font-mono text-[9.5px] text-mute" style={{ letterSpacing: '0.4px' }}>
                ◷ {task.due_date}
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

          {expanded && task.detail && (
            <p className="mt-1 text-[12px] text-mute leading-relaxed">
              {task.detail}
            </p>
          )}
        </div>

        {/* Edit / Delete buttons */}
        {!isReference && (
          <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => setEditing(true)}
              title="Edit task"
              className="text-mute hover:text-ink text-xs px-1 mt-0.5"
            >
              ✎
            </button>
            {onDelete && (
              <button
                onClick={() => onDelete(task.id)}
                title="Delete task"
                className="btn-delete"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {editing && <EditTaskModal task={task} onClose={() => setEditing(false)} />}
    </>
  )
}
