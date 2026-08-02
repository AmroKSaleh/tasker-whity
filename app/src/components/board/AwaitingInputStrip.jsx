import { useEffect, useState } from 'react'
import { fetchAwaitingInputTaskIds } from '../../lib/agentLedger'
import { Kicker } from '../editorial/atoms'

// TDE-374 milestone 4: the Front Page strip of tasks where an agent is waiting on the human.
// Attention-first — sits above the lead so "an agent needs you" is the first thing you see.
export default function AwaitingInputStrip({ tasks, prefix, onOpenTask }) {
  const [ids, setIds] = useState(null)

  useEffect(() => {
    let alive = true
    const open = tasks.filter(t => t.status !== 'done').map(t => t.id)
    fetchAwaitingInputTaskIds(open)
      .then(s => { if (alive) setIds(s) })
      .catch(() => { if (alive) setIds(new Set()) })
    return () => { alive = false }
  }, [tasks])

  if (!ids || ids.size === 0) return null
  const waiting = tasks.filter(t => ids.has(t.id))
  if (!waiting.length) return null

  return (
    <div className="mt-6 rounded-xl border border-review/30 bg-review-soft px-5 py-3.5">
      <div className="flex items-baseline justify-between mb-2.5">
        <Kicker>◆ Agents waiting on you</Kicker>
        <Kicker>{waiting.length} awaiting input</Kicker>
      </div>
      <div className="flex flex-wrap gap-2">
        {waiting.map(t => (
          <button
            key={t.id}
            onClick={() => onOpenTask(t.id)}
            className="group flex items-center gap-2 rounded-lg border border-review/25 bg-paper px-3 py-2 text-left transition-colors hover:border-review/60"
          >
            <span className="w-[7px] h-[7px] rounded-full bg-review shrink-0" />
            <span className="max-w-[240px] truncate text-[12.5px] font-medium text-ink group-hover:text-review transition-colors">{t.text}</span>
            {t.short_id != null && (
              <span className="shrink-0 font-mono text-[9px] tracking-[0.08em] text-mute-2">{prefix}-{t.short_id}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
