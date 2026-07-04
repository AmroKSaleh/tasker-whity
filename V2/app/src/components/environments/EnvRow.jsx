import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trash2, Check } from 'lucide-react'
import { ENV_COLORS, envColor } from '../../lib/envColor'

export default function EnvRow({ env, projectCount, isActive, onRename, onRecolor, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: env.id })
  const [name, setName] = useState(env.name)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const color = envColor(env)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-center gap-3 px-3 py-2.5 border border-line-2 rounded-lg bg-paper mb-2"
    >
      <button
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', touchAction: 'none' }}
        className="text-mute text-[15px] leading-none shrink-0"
        title="Drag to reorder"
      >
        ⠿
      </button>

      {/* Color swatch + palette */}
      <div className="relative shrink-0">
        <button
          onClick={() => setPaletteOpen(o => !o)}
          className="w-5 h-5 rounded-full border border-line"
          style={{ background: color }}
          title="Change color"
        />
        {paletteOpen && (
          <div className="absolute left-0 top-7 z-50 flex flex-wrap gap-1.5 p-2 w-[132px] bg-paper border border-line rounded-lg shadow-card">
            {ENV_COLORS.map(c => (
              <button
                key={c}
                onClick={() => { onRecolor(env.id, c); setPaletteOpen(false) }}
                className="w-5 h-5 rounded-full border border-line flex items-center justify-center"
                style={{ background: c }}
                title={c}
              >
                {color.toLowerCase() === c.toLowerCase() && <Check size={11} className="text-white" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={() => {
          const trimmed = name.trim()
          if (trimmed && trimmed !== env.name) onRename(env.id, trimmed)
          else setName(env.name)
        }}
        className="flex-1 min-w-0 text-[14px] text-ink bg-transparent border-b border-transparent focus:border-line outline-none py-0.5 transition-colors"
      />

      {isActive && (
        <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-accent shrink-0">Active</span>
      )}
      <span className="font-mono text-[11px] text-mute-2 shrink-0">
        {projectCount} project{projectCount === 1 ? '' : 's'}
      </span>
      <button onClick={() => onDelete(env)} className="btn-delete shrink-0" title="Delete environment">
        <Trash2 size={13} />
      </button>
    </div>
  )
}
