import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { fetchTaskSessions } from '../../lib/agentLedger'

// TDE-374/375: the durable, human-inspectable record of what an agent did on a task.
// Immutable — this view is read-only by design (append-only ledger, no edit/delete).

const STATE_STYLE = {
  awaiting_input: { label: 'awaiting input', cls: 'border-review/40 text-review' },
  active:         { label: 'active',         cls: 'border-accent/40 text-accent' },
  error:          { label: 'error',          cls: 'border-red-400/50 text-red-500' },
  stale:          { label: 'stale',          cls: 'border-line text-mute-2' },
  complete:       { label: 'complete',       cls: 'border-priority-done/40 text-priority-done' },
}

const TYPE_STYLE = {
  progress: 'text-mute',
  action:   'text-ink-2',
  question: 'text-review',
  result:   'text-priority-done',
  error:    'text-red-500',
}

function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export default function AgentActivityPanel({ taskId, taskDone, refreshKey = 0 }) {
  const [sessions, setSessions] = useState(null)

  useEffect(() => {
    let alive = true
    fetchTaskSessions(taskId, taskDone)
      .then(s => { if (alive) setSessions(s) })
      .catch(() => { if (alive) setSessions([]) })
    return () => { alive = false }
  }, [taskId, taskDone, refreshKey])

  if (sessions === null) return <p className="text-[11px] text-mute-2">Loading activity…</p>
  if (!sessions.length) {
    return <p className="text-[11px] text-mute-2 leading-snug">No agent activity yet. Agents log what they do here as they work — an immutable, session-by-session record.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {sessions.map(s => {
        const st = STATE_STYLE[s.state] ?? STATE_STYLE.active
        return (
          <div key={s.id} className="rounded-lg border border-line-2 bg-surf-2 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
              <span className="text-[11.5px] font-medium text-ink-2 truncate">{s.actor || 'Unattributed agent'}</span>
              <span className={clsx('ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider border', st.cls)}>
                {st.label}
              </span>
            </div>
            <ol className="list-none m-0 p-0">
              {s.activities.map((a, i) => (
                <li key={i} className="flex gap-2 px-3 py-1.5 border-b border-line-2 last:border-0">
                  <span className={clsx('shrink-0 font-mono text-[8.5px] uppercase tracking-wider mt-1 min-w-[46px]', TYPE_STYLE[a.type] ?? 'text-mute')}>
                    {a.type}
                  </span>
                  <span className="flex-1 text-[12px] leading-snug text-ink-2">{a.body}</span>
                  <span className="shrink-0 font-mono text-[9px] text-mute-2 mt-0.5">{ago(a.created_at)}</span>
                </li>
              ))}
              {s.activities.length === 0 && (
                <li className="px-3 py-1.5 text-[11px] text-mute-2">(session opened — no entries yet)</li>
              )}
            </ol>
          </div>
        )
      })}
    </div>
  )
}
