import { useRef } from 'react'
import clsx from 'clsx'

export const CONTEXT_FIELDS = [
  { key: 'goal',               label: 'Goal',              placeholder: 'What is this project trying to achieve?' },
  { key: 'why',                label: 'Why it matters',    placeholder: 'Why does this project exist?' },
  { key: 'scope',              label: 'Scope',             placeholder: "What's included — and what isn't?" },
  { key: 'risks',              label: 'Known risks',       placeholder: 'What could go wrong?' },
  { key: 'definition_of_done', label: 'Definition of done', placeholder: 'What does success look like?' },
  { key: 'constraints',        label: 'Constraints',       placeholder: 'Deadlines, budget, team size…' },
  { key: 'ai_behavior',        label: 'AI working style',  placeholder: 'Flag things proactively, or wait until I ask?' },
]

function AutoTextarea({ value, placeholder, onChange, readOnly }) {
  const ref = useRef(null)

  function handleChange(e) {
    const el = e.target
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
    onChange?.(e.target.value)
  }

  return (
    <textarea
      ref={ref}
      value={value || ''}
      placeholder={placeholder}
      onChange={handleChange}
      readOnly={readOnly}
      rows={2}
      className={clsx(
        'w-full resize-none overflow-hidden bg-transparent text-[13px] leading-relaxed outline-none',
        value ? 'text-ink-2' : 'text-mute-2',
        readOnly && 'cursor-default'
      )}
    />
  )
}

export default function ContextPoints({ points = {}, onChange, readOnly = false }) {
  const filled = CONTEXT_FIELDS.filter(f => points[f.key])
  const empty  = CONTEXT_FIELDS.filter(f => !points[f.key])

  function update(key, value) {
    onChange?.({ ...points, [key]: value || null })
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Filled fields */}
      {filled.map(({ key, label, placeholder }) => (
        <div key={key} className="rounded-lg border border-line-2 bg-surf-2 px-3 py-2.5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mute mb-1.5">{label}</div>
          <AutoTextarea
            value={points[key]}
            placeholder={placeholder}
            onChange={val => update(key, val)}
            readOnly={readOnly}
          />
        </div>
      ))}

      {/* Empty fields — compact, not hidden */}
      {!readOnly && empty.length > 0 && (
        <div className="flex flex-col gap-1 pt-1">
          <p className="font-mono text-[9px] uppercase tracking-widest text-mute-2 pb-0.5">Not covered</p>
          {empty.map(({ key, label, placeholder }) => (
            <div key={key} className="rounded-lg border border-dashed border-line px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-mute-2 mb-1">{label}</div>
              <AutoTextarea
                value={points[key]}
                placeholder={placeholder}
                onChange={val => update(key, val)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
