import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

// The agent work queue for a project: what the agent will execute (Queue) and what it has
// prepared and is waiting for the human to green-light (Awaiting confirmation).
const PRI = { rush: 0, high: 1, medium: 2, low: 3 }

export default function AgentQueuePanel({ projectId, prefix, onClose, onOpenTask }) {
  const [tab, setTab] = useState('queue')
  const [queue, setQueue] = useState([])
  const [awaiting, setAwaiting] = useState([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [{ data: q }, { data: a }] = await Promise.all([
      supabase.from('tasks').select('id, text, short_id, priority')
        .eq('project_id', projectId).eq('agent_ready', true).eq('status', 'pending'),
      supabase.from('tasks').select('id, text, short_id, agent_proposal, agent_proposal_at')
        .eq('project_id', projectId).not('agent_proposal', 'is', null)
        .order('agent_proposal_at', { ascending: false }),
    ])
    setQueue((q || []).sort((x, y) => (PRI[x.priority] ?? 2) - (PRI[y.priority] ?? 2)))
    setAwaiting(a || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  function open(id) { onOpenTask?.(id); onClose() }
  const list = tab === 'queue' ? queue : awaiting

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/[0.12]" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-paper shadow-xl">
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-5 pt-4 pb-0">
          <span className="text-[14px] font-semibold text-ink">Agent queue</span>
          <button onClick={onClose} className="text-lg leading-none text-mute transition-colors hover:text-ink">×</button>
        </header>

        <div className="flex gap-1 px-5 pt-3">
          {[['queue', 'Queue', queue.length], ['awaiting', 'Awaiting confirmation', awaiting.length]].map(([id, label, n]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-t-md px-3 py-2 text-[12px] font-medium transition-colors ${tab === id ? 'border-b-2 border-accent text-ink' : 'text-mute hover:text-ink-2'}`}
            >
              {label}{n > 0 ? <span className="ml-1.5 rounded-full bg-surf-2 px-1.5 py-px font-mono text-[9px] text-mute-2">{n}</span> : null}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-2 text-[10.5px] leading-snug text-mute-2">
            {tab === 'queue'
              ? 'Tasks you handed to the agent — it will work these in priority order when you run /work-ready.'
              : 'The agent prepared these and is waiting for your go-ahead. Confirm in your Claude Code session to execute.'}
          </p>
          {loading ? (
            <p className="py-4 text-[12px] text-mute-2">Loading…</p>
          ) : list.length === 0 ? (
            <p className="py-4 text-[12px] text-mute-2">{tab === 'queue' ? 'Nothing handed to the agent yet — flip “Hand to agent” on a task.' : 'Nothing awaiting confirmation.'}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {list.map(t => (
                <li key={t.id}>
                  <button onClick={() => open(t.id)} className="group w-full rounded-lg border border-line-2 bg-surf-2 px-3 py-2.5 text-left transition-colors hover:border-accent/40">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 text-[12.5px] font-medium leading-snug text-ink group-hover:text-accent-dark">{t.text}</span>
                      {t.short_id != null && <span className="shrink-0 font-mono text-[9px] text-mute-2">{prefix}-{t.short_id}</span>}
                    </div>
                    {tab === 'awaiting' && t.agent_proposal && (
                      <p className="mt-1 line-clamp-3 border-l-2 border-review/40 pl-2 text-[11px] leading-snug text-ink-2">{t.agent_proposal}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
