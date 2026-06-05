import { useState, useMemo } from 'react'
import clsx from 'clsx'
import { ChevronLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useFlows } from '../hooks/useFlows'
import AppShell from '../components/editorial/AppShell'
import { Kicker, Pill } from '../components/editorial/atoms'
import FlowGraph from '../components/flows/FlowGraph'
import FlowStepList from '../components/flows/FlowStepList'

const STATUS_LABEL = { done: 'DONE', in_progress: 'IN PROGRESS', pending: 'PENDING' }
const STATUS_DOT = { done: 'bg-[#4ade80]', in_progress: 'bg-accent', pending: 'bg-line' }

function FlowCard({ flow, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left rounded-xl border p-3.5 transition-colors',
        active ? 'bg-paper border-line shadow-sm' : 'border-line-2 hover:bg-surf-2',
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[flow.status])} />
        <span className="flex-1 text-[13.5px] font-semibold text-ink truncate">{flow.name}</span>
        {flow.projectPrefix && <span className="font-mono text-[9.5px] text-mute shrink-0">{flow.projectPrefix}</span>}
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-mute-2 tracking-[0.04em] pl-3.5">
        <span>{flow.stepCount} STEPS</span>
        <span>·</span>
        <span>{flow.doneCount}/{flow.stepCount} DONE</span>
      </div>
    </button>
  )
}

function FlowDetail({ flow, onBack, listOpen, onToggleList }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-3 border-b border-line-2 shrink-0">
        <button onClick={onBack} className="md:hidden flex items-center gap-1 text-[12px] text-mute mb-2">
          <ChevronLeft size={13} /> All flows
        </button>
        <button
          onClick={onToggleList}
          title={listOpen ? 'Hide flow list' : 'Show flow list'}
          className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-mute hover:text-ink mb-2 transition-colors"
        >
          {listOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          <span>{listOpen ? 'Hide list' : 'Show list'}</span>
        </button>
        <Kicker>{flow.projectName}{flow.projectPrefix ? ` · ${flow.projectPrefix}` : ''}</Kicker>
        <h2 className="text-h2 mt-1">{flow.name}</h2>
        <div className="font-mono text-[10px] text-mute-2 tracking-[0.06em] mt-1">
          {flow.stepCount} STEPS · {flow.doneCount}/{flow.stepCount} DONE · {STATUS_LABEL[flow.status]}
        </div>
      </div>
      <div className="shrink-0 border-b border-line-2" style={{ height: 320 }}>
        <FlowGraph steps={flow.steps} prefix={flow.projectPrefix} />
      </div>
      <div className="flex-1 overflow-auto px-4 py-3 no-scrollbar">
        <FlowStepList steps={flow.steps} prefix={flow.projectPrefix} />
      </div>
    </div>
  )
}

export default function FlowsPage() {
  const { flows, projects, loading } = useFlows()
  const [projectFilter, setProjectFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [listOpen, setListOpen] = useState(true)

  const filtered = useMemo(
    () => projectFilter === 'all' ? flows : flows.filter(f => f.projectId === projectFilter),
    [flows, projectFilter],
  )

  const projCounts = useMemo(() => {
    const c = {}
    flows.forEach(f => { c[f.projectId] = (c[f.projectId] || 0) + 1 })
    return c
  }, [flows])

  const selected = filtered.find(f => f.id === selectedId) || null

  return (
    <AppShell active="flows">
      <div className="h-full flex">
        {/* List column */}
        <div className={clsx('flex-col border-r border-line-2 shrink-0 w-full md:w-[340px]', selected ? 'hidden' : 'flex', listOpen ? 'md:flex' : 'md:hidden')}>
          <div className="px-5 pt-7 pb-3 shrink-0">
            <Kicker className="mb-2">FLOWS</Kicker>
            <h1 className="text-h1 m-0">Flows.</h1>
            <div className="flex gap-1.5 mt-4 flex-wrap">
              <Pill active={projectFilter === 'all'} count={flows.length} onClick={() => setProjectFilter('all')}>All</Pill>
              {projects.filter(p => projCounts[p.id]).map(p => (
                <Pill key={p.id} active={projectFilter === p.id} count={projCounts[p.id]} onClick={() => setProjectFilter(p.id)}>
                  {p.prefix || p.name}
                </Pill>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-3 pb-6 flex flex-col gap-2 no-scrollbar">
            {loading ? (
              <p className="text-[13px] text-mute px-2 py-10 text-center">Loading…</p>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-12 text-center">
                <p className="text-[24px] mb-2">◇</p>
                <p className="text-[13px] font-semibold text-ink mb-1">No flows yet</p>
                <p className="text-[12px] text-mute leading-relaxed">Link tasks with input/output, or run <span className="font-mono">build_new_flow</span> via the MCP.</p>
              </div>
            ) : filtered.map(f => (
              <FlowCard key={f.id} flow={f} active={selected?.id === f.id} onClick={() => setSelectedId(f.id)} />
            ))}
          </div>
        </div>

        {/* Detail column */}
        <div className={clsx('flex-1 min-w-0', selected ? 'block' : 'hidden md:block')}>
          {selected ? (
            <FlowDetail flow={selected} onBack={() => setSelectedId(null)} listOpen={listOpen} onToggleList={() => setListOpen(o => !o)} />
          ) : (
            <div className="hidden md:flex items-center justify-center h-full text-[13px] text-mute">
              {loading ? '' : 'Select a flow to view it.'}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
