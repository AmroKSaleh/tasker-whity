import { useState } from 'react'
import { GripVertical, ChevronsLeft, MoreHorizontal } from 'lucide-react'
import { updateSectionFields } from '../../hooks/useTasks'

export default function ColumnHeader({ section, dragHandle, onCollapse, onSelect }) {
  const [descFocused, setDescFocused] = useState(false)
  const pct = section.totalCount > 0
    ? Math.round((section.doneCount / section.totalCount) * 100)
    : 0

  return (
    <div
      className="group/col-header relative flex cursor-grab items-start gap-2 border-b border-line-2 bg-paper px-3.5 py-3 active:cursor-grabbing"
      {...dragHandle}
    >
      <div className="mt-0.5 shrink-0 text-mute-2 opacity-0 transition-opacity group-hover/col-header:opacity-100">
        <GripVertical className="h-3.5 w-3.5" />
      </div>

      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-semibold leading-tight tracking-[-0.01em] text-ink hover:text-accent transition-colors cursor-pointer"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onSelect?.() }}
          title="View section details"
        >
          {section.name}
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
          <span className="text-ink-2">{section.doneCount}/{section.totalCount}</span>
          <div className="h-0.5 max-w-[60px] flex-1 overflow-hidden rounded-sm bg-line-2">
            <div className="h-full bg-ink-2" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="relative mt-1.5">
          <div
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onFocus={() => setDescFocused(true)}
            onBlur={e => {
              setDescFocused(false)
              const desc = e.currentTarget.textContent?.trim() || null
              if (desc !== (section.description ?? null)) {
                updateSectionFields(section.id, { description: desc })
              }
            }}
            className="min-h-[14px] text-[11px] leading-snug text-mute outline-none"
          >
            {section.description || ''}
          </div>
          {!section.description && !descFocused && (
            <span className="pointer-events-none absolute inset-0 text-[11px] leading-snug text-mute-2 opacity-0 transition-opacity group-hover/col-header:opacity-100">
              Add description…
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-0.5 opacity-0 transition-opacity group-hover/col-header:opacity-100">
        <button
          className="icon-btn !h-6 !w-6"
          title="Collapse"
          onClick={(e) => { e.stopPropagation(); onCollapse?.() }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn !h-6 !w-6"
          title="More"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
