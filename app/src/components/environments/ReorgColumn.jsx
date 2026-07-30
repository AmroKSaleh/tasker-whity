import { useState } from 'react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { Trash2, Check } from 'lucide-react'
import { ENV_COLORS, envColor } from '../../lib/envColor'

// compact=true renders a smaller tile for the flat "all projects" grid below the board (drag-only
// there, same drop contract, so dropping on any env column works unchanged).
// envBadge = { name, color } shows which environment the project currently sits in.
//
// dragId must be unique PER RENDERED INSTANCE, not per project: the same project renders twice
// (once in its env column, once in the flat grid below), and dnd-kit's useDraggable keys its
// active-drag transform purely by id — two instances sharing one id both animate together when
// either is dragged. The real project id travels separately via data.projectId for onDragEnd.
export function ProjectCard({ project, dragId, compact = false, envBadge = null }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId ?? project.id, data: { projectId: project.id, fromEnv: project.environment_id ?? null },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, opacity: isDragging ? 0.4 : 1, cursor: 'grab', touchAction: 'none' }}
      className={compact
        ? 'w-32 shrink-0 rounded-md border border-line-2 bg-paper px-2 py-1.5 shadow-sm'
        : 'rounded-lg border border-line-2 bg-paper px-2.5 py-2 mb-1.5 shadow-sm'}
    >
      <div className={compact ? 'text-[11px] font-medium text-ink truncate' : 'text-[12px] font-medium text-ink truncate'}>{project.name}</div>
      {project.prefix && <div className="font-mono text-[9px] text-mute-2 mt-0.5">{project.prefix}</div>}
      {compact && (
        <div className="flex items-center gap-1 mt-1">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: envBadge?.color ?? 'var(--color-mute-2)' }} />
          <span className="text-[9px] text-mute-2 truncate">{envBadge?.name ?? 'Unassigned'}</span>
        </div>
      )}
    </div>
  )
}

export default function ReorgColumn({ env, projects, owners, onRename, onRecolor, onMoveOwner, onDelete }) {
  const { setNodeRef, isOver } = useDroppable({ id: `env-${env.id}`, data: { envId: env.id } })
  const [name, setName] = useState(env.name)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const color = envColor(env)

  return (
    <div className="shrink-0 w-56 flex flex-col rounded-xl border border-line-2 bg-surf-2">
      {/* Header */}
      <div className="p-2.5 border-b border-line-2">
        <div className="flex items-center gap-2 mb-2">
          <div className="relative shrink-0">
            <button onClick={() => setPaletteOpen(o => !o)} className="w-3.5 h-3.5 rounded-full border border-line" style={{ background: color }} title="Change color" />
            {paletteOpen && (
              <div className="absolute left-0 top-5 z-50 flex flex-wrap gap-1.5 p-2 w-[124px] bg-paper border border-line rounded-lg shadow-card">
                {ENV_COLORS.map(c => (
                  <button key={c} onClick={() => { onRecolor(env.id, c); setPaletteOpen(false) }} className="w-5 h-5 rounded-full border border-line flex items-center justify-center" style={{ background: c }}>
                    {color.toLowerCase() === c.toLowerCase() && <Check size={11} className="text-white" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => { const t = name.trim(); if (t && t !== env.name) onRename(env.id, t); else setName(env.name) }}
            className="flex-1 min-w-0 text-[13px] font-semibold text-ink bg-transparent border-b border-transparent focus:border-line outline-none"
          />
          <button onClick={() => onDelete(env)} className="btn-delete shrink-0" title="Delete environment (must be empty)"><Trash2 size={12} /></button>
        </div>
        <select
          value={env.org_id ?? ''}
          onChange={e => onMoveOwner(env.id, e.target.value || null)}
          className="w-full text-[11px] border border-line rounded-md px-2 py-1 bg-paper text-ink-2 outline-none focus:border-ink"
          title="Move this environment to another owner"
        >
          {owners.map(o => <option key={o.id ?? 'personal'} value={o.id ?? ''}>{o.name}</option>)}
        </select>
      </div>
      {/* Droppable body */}
      <div ref={setNodeRef} className={`flex-1 min-h-[80px] p-2 transition-colors ${isOver ? 'bg-accent/10' : ''}`}>
        {projects.length === 0
          ? <p className="text-[11px] text-mute-2 px-1 py-2">Drop projects here</p>
          : projects.map(p => <ProjectCard key={p.id} project={p} dragId={`col-${p.id}`} />)}
      </div>
    </div>
  )
}
