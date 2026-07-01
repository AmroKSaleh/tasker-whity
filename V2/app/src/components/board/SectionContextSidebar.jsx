import { AlertTriangle, CheckCircle2 } from 'lucide-react'

// Health signals mirror the MCP section_insights/analyze_section rules verbatim
// (imbalance >50%, stale >7d, backlog pressure) so the web view and the agent
// view of a section always agree. Keep in sync with supabase/functions/mcp.
function computeHealth(sectionTasks, groups) {
  const done = sectionTasks.filter(t => t.status === 'done').length
  const inProgress = sectionTasks.filter(t => t.status === 'in_progress').length
  const pending = sectionTasks.filter(t => t.status !== 'done' && t.status !== 'in_progress').length

  const total = sectionTasks.length
  const groupData = groups.map(g => {
    const count = sectionTasks.filter(t => t.group_id === g.id).length
    return { name: g.name, count, pct: total ? Math.round((count / total) * 100) : 0 }
  }).sort((a, b) => b.count - a.count)

  const maxGroup = groupData.reduce((a, b) => (a.pct > b.pct ? a : b), { pct: 0, name: '' })
  const isImbalanced = maxGroup.pct > 50

  const now = Date.now()
  const stale = sectionTasks.filter(t => {
    if (t.status === 'done') return false
    const days = Math.floor((now - new Date(t.created_at).getTime()) / 86400000)
    return days > 7
  })

  const attention = []
  if (isImbalanced) attention.push(`"${maxGroup.name}" holds ${maxGroup.pct}% of the workload`)
  if (stale.length) attention.push(`${stale.length} pending task${stale.length !== 1 ? 's' : ''} older than 7 days`)
  if (pending > inProgress && inProgress >= 0 && pending > 0)
    attention.push(`${pending} pending vs ${inProgress} in progress — move work forward`)

  return { done, inProgress, pending, total, groupData, stale, attention }
}

function Stat({ label, value }) {
  return (
    <div className="flex-1 text-center">
      <div className="text-h3 text-ink tabular-nums">{value}</div>
      <div className="text-3xs uppercase text-mute-2 font-bold tracking-widest mt-0.5">{label}</div>
    </div>
  )
}

export default function SectionContextSidebar({ section, groups, tasks, project, onClose }) {
  const sectionTasks = tasks.filter(t => t.section_id === section.id)
  const { done, inProgress, pending, groupData, stale, attention } = computeHealth(sectionTasks, groups)

  return (
    <aside className="w-96 shrink-0 border-l border-line bg-paper flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-line bg-surf shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-ink text-[14px]">{section.name}</h2>
          <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none">×</button>
        </div>
        <p className="text-[11px] text-mute font-mono tracking-wide">{project.prefix}</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 border-b border-line flex items-stretch gap-2">
          <Stat label="Done" value={done} />
          <Stat label="Active" value={inProgress} />
          <Stat label="Pending" value={pending} />
        </div>

        <div className="px-5 py-4 border-b border-line">
          <p className="text-3xs font-mono text-mute-2 uppercase tracking-widest mb-2.5 font-bold">Needs Attention</p>
          {attention.length ? (
            <ul className="space-y-2">
              {attention.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px] text-ink-2 leading-snug">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-start gap-2 text-[12px] text-mute leading-snug">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-mute-2" />
              <span>Section looks healthy — balanced groups, nothing stale.</span>
            </div>
          )}
          {stale.length > 0 && (
            <ul className="mt-3 space-y-1 pl-5.5">
              {stale.slice(0, 3).map(t => (
                <li key={t.id} className="text-[11px] text-mute truncate">
                  <span className="font-mono text-mute-2">{project.prefix}-{t.short_id}</span> {t.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {groupData.length > 0 && (
          <div className="px-5 py-4">
            <p className="text-3xs font-mono text-mute-2 uppercase tracking-widest mb-3 font-bold">Group Balance</p>
            <div className="space-y-2.5">
              {groupData.map(g => (
                <div key={g.name}>
                  <div className="flex items-baseline justify-between text-[11px] mb-1">
                    <span className="text-ink-2 truncate mr-2">{g.name}</span>
                    <span className="text-mute-2 font-mono shrink-0 tabular-nums">{g.count} · {g.pct}%</span>
                  </div>
                  <div className="h-1.5 rounded-pill bg-surf-2 overflow-hidden">
                    <div className={g.pct > 50 ? 'h-full bg-accent' : 'h-full bg-accent/40'} style={{ width: `${g.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
