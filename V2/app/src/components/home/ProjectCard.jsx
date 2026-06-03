import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { rankTasks } from '../../lib/scoring'
import { deleteProject } from '../../hooks/useProjects'
import { prefetchBoard } from '../../lib/prefetch'

export default function ProjectCard({ project, tasks = [], isDefault = false, onToggleDefault }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const total = tasks.length
  const doneCount = tasks.filter(t => t.status === 'done').length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0

  const pending = tasks.filter(t => t.status !== 'done')
  const overdueCount = pending.filter(t => {
    if (!t.due_date) return false
    return new Date(t.due_date) < today
  }).length
  const rushHighCount = pending.filter(t => t.priority === 'rush' || t.priority === 'high').length
  const nextTask = rankTasks(pending)[0] ?? null

  // Staleness: days since most recent task was created
  const mostRecentTs = tasks.reduce((max, t) => {
    const d = new Date(t.created_at).getTime()
    return d > max ? d : max
  }, 0)
  const staleDays = mostRecentTs > 0
    ? Math.floor((Date.now() - mostRecentTs) / 86400000)
    : null

  function handleClick(e) {
    // Don't navigate if this was a drag gesture
    if (e.defaultPrevented) return
    navigate(`/dashboard/${project.slug}`)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={handleClick}
      onMouseEnter={() => prefetchBoard(project.id)}
      className="group bg-paper border border-line-2 rounded-2xl p-5 cursor-pointer hover:border-line hover:shadow-panel transition-all select-none flex flex-col gap-3"
    >
      {/* Drag handle row */}
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink leading-tight tracking-[-0.01em] flex-1 flex items-center gap-2">
          {project.name}
          {project.prefix && (
            <>
              <span className="text-mute-2 font-normal select-none">|</span>
              <span className="text-[11px] font-mono font-medium text-mute tracking-widest">
                {project.prefix}
              </span>
            </>
          )}
        </h2>
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {confirming ? (
            <>
              <button
                onClick={async () => { await deleteProject(project.id) }}
                className="px-2 py-0.5 rounded border border-red-400 text-red-500 text-[11px] font-medium hover:bg-red-50 transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-2 py-0.5 rounded border border-line text-mute text-[11px] hover:bg-surf transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onToggleDefault?.()}
                className={`w-6 h-6 flex items-center justify-center rounded text-[14px] transition-all hover:bg-surf-2 ${isDefault ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                title={isDefault ? 'Remove default' : 'Set as default project'}
              >
                <span style={{ color: isDefault ? 'var(--color-star)' : '#9CA3AF' }}>★</span>
              </button>
              <button
                onClick={() => setConfirming(true)}
                className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded text-[13px] text-mute-2 hover:text-red-500 hover:bg-surf-2"
                title="Delete project"
              >
                ×
              </button>
            </>
          )}
          <div
            {...attributes}
            {...listeners}
            className="text-mute-2 hover:text-mute transition-colors cursor-grab active:cursor-grabbing pt-0.5 touch-none"
            title="Drag to reorder"
          >
            ⠿
          </div>
        </div>
      </div>

      {/* Progress */}
      <div className="flex flex-col gap-1.5">
        <div className="h-1 w-full overflow-hidden rounded-sm bg-line-2">
          <div className="h-full rounded-sm bg-ink transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-[10px] tracking-[0.04em] text-mute">
          {doneCount} of {total} · {pct}%
        </span>
      </div>

      {/* Intelligence signals */}
      {(overdueCount > 0 || rushHighCount > 0 || (staleDays !== null && staleDays > 7)) && (
        <div className="flex flex-wrap items-center gap-2">
          {overdueCount > 0 && (
            <span className="font-mono text-[10px] tracking-wide px-2 py-0.5 rounded-full bg-[#fdf0ee] text-[#C0432D]">
              {overdueCount} overdue
            </span>
          )}
          {rushHighCount > 0 && (
            <span className="font-mono text-[10px] tracking-wide px-2 py-0.5 rounded-full bg-surf-2 text-[#D97757]">
              {rushHighCount} high priority
            </span>
          )}
          {staleDays !== null && staleDays > 7 && overdueCount === 0 && (
            <span className="font-mono text-[10px] tracking-wide px-2 py-0.5 rounded-full bg-surf-2 text-mute">
              {staleDays}d inactive
            </span>
          )}
        </div>
      )}

      {/* What's next */}
      {nextTask && (
        <div className="border-t border-line-2 pt-3">
          <p className="font-mono text-[9px] tracking-widest uppercase text-mute-2 mb-1">Next</p>
          <p className="text-[13px] text-ink-2 leading-snug line-clamp-2">{nextTask.text}</p>
        </div>
      )}

      {total === 0 && (
        <p className="text-[12px] text-mute-2 italic">No tasks yet</p>
      )}
    </div>
  )
}
