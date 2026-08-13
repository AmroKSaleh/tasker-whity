import { useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import { ENV_COLORS, envColor } from '../../lib/envColor'

// A row for an org-owned environment on the Organizations page. Like EnvRow but without drag
// reorder — recolor, rename, delete (only when empty).
export default function OrgEnvRow({ env, projectCount, onRename, onRecolor, onDelete }) {
  const [name, setName] = useState(env.name)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const color = envColor(env)

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line-2 last:border-b-0">
      <div className="relative shrink-0">
        <button
          onClick={() => setPaletteOpen(o => !o)}
          className="w-4 h-4 rounded-full border border-line"
          style={{ background: color }}
          title="Change color"
        />
        {paletteOpen && (
          <div className="absolute left-0 top-6 z-50 flex flex-wrap gap-1.5 p-2 w-[132px] bg-paper border border-line rounded-lg shadow-card">
            {ENV_COLORS.map(c => (
              <button
                key={c}
                onClick={() => { onRecolor(env.id, c); setPaletteOpen(false) }}
                className="w-5 h-5 rounded-full border border-line flex items-center justify-center"
                style={{ background: c }}
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
          const t = name.trim()
          if (t && t !== env.name) onRename(env.id, t); else setName(env.name)
        }}
        className="flex-1 min-w-0 text-[13px] text-ink bg-transparent border-b border-transparent focus:border-line outline-none py-0.5"
      />
      <span className="font-mono text-[11px] text-mute-2 shrink-0">{projectCount} proj</span>
      <button onClick={() => onDelete(env)} className="btn-delete shrink-0" title="Delete environment">
        <Trash2 size={12} />
      </button>
    </div>
  )
}
