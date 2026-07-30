import { useRef } from 'react'
import clsx from 'clsx'

// The Foundation — fixed core first (the load-bearing fields every project needs),
// then extended. Flexible/agent-added keys render separately (see below). Order here
// mirrors the MCP foundation render + the bootstrap_project interview order.
export const CONTEXT_FIELDS = [
  { key: 'goal',               label: 'Goal',                     placeholder: 'What is this project trying to achieve?' },
  { key: 'why',                label: 'Why (intent)',             placeholder: 'The real problem behind it — why does this exist?' },
  { key: 'scope',              label: 'Scope (in / out)',         placeholder: "What's included — and explicitly what isn't?" },
  { key: 'definition_of_done', label: 'Success looks like',       placeholder: 'The concrete end-state when this is done.' },
  { key: 'failure',            label: 'Failure looks like',       placeholder: 'Anti-goals — what must this avoid?' },
  { key: 'quality_bar',        label: 'Quality bar',              placeholder: 'Throwaway prototype, or production-grade?' },
  { key: 'success_metrics',    label: 'Success metrics',          placeholder: 'How is success measured?' },
  { key: 'audience',           label: 'Audience',                 placeholder: 'Who is this for?' },
  { key: 'constraints',        label: 'Constraints',              placeholder: 'Deadlines, budget, stack, platform…' },
  { key: 'risks',              label: 'Known risks',              placeholder: 'What could go wrong?' },
  { key: 'ai_behavior',        label: 'AI working style / autonomy', placeholder: 'Decide alone or check with me? Flag proactively?' },
  { key: 'assumptions',        label: 'Assumptions & open questions', placeholder: 'What was assumed, and what is still unknown?' },
]

const KNOWN_KEYS = new Set(CONTEXT_FIELDS.map(f => f.key).concat('done_looks_like'))
const humanize = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Coerce any stored value to readable text — fields may be saved by the agent as a
// nested object (e.g. scope: { in, out }) or an array; never show "[object Object]".
function toDisplay(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.filter(Boolean).join('; ')
  if (typeof v === 'object') {
    return Object.entries(v)
      .filter(([, x]) => x != null && String(x).trim())
      .map(([k, x]) => `${humanize(k)}: ${Array.isArray(x) ? x.filter(Boolean).join('; ') : x}`)
      .join('\n')
  }
  return String(v)
}

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
      value={toDisplay(value)}
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
  // Flexible / agent-added keys (per project type) — not part of the fixed schema.
  const extra  = Object.keys(points).filter(k => !KNOWN_KEYS.has(k) && points[k])

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

      {/* Flexible / agent-added fields (per project type) */}
      {extra.map(key => (
        <div key={key} className="rounded-lg border border-line-2 bg-surf-2 px-3 py-2.5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mute mb-1.5">{humanize(key)}</div>
          <AutoTextarea
            value={points[key]}
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
