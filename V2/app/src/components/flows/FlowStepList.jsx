import { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { Kicker } from '../editorial/atoms'
import { inputEdges, outputRules } from '../../lib/flowGraph'

const STATUS_ICON = { done: '✓', in_progress: '▶', pending: '○' }

function statusTextColor(status) {
  if (status === 'done') return 'text-[#4ade80]'
  if (status === 'in_progress') return 'text-accent'
  return 'text-mute'
}

function RuleRow({ rule }) {
  const warn = rule.severity === 'warning'
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={clsx(
        'font-mono text-[8.5px] font-bold tracking-[0.06em] px-1 rounded mt-[3px] shrink-0',
        warn ? 'text-mute border border-dashed border-mute-2' : 'bg-ink-2 text-paper',
      )}>
        {warn ? 'WARN' : 'BLOCK'}
      </span>
      <span className="text-[11.5px] text-ink-2 leading-snug">
        {rule.rule}
        <span className="text-mute-2 font-mono text-[9px] ml-1.5">{rule.kind === 'check' ? 'check' : 'judgment'}</span>
      </span>
    </div>
  )
}

export default function FlowStepList({ steps, prefix }) {
  const [open, setOpen] = useState(() => new Set())
  const toggle = id => setOpen(prev => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const stepByTaskId = new Map(steps.map(s => [s.task.id, s.step]))

  return (
    <div className="flex flex-col">
      {steps.map(({ task, step }) => {
        const isOpen = open.has(task.id)
        const edges = inputEdges(task.input)
        const oRules = outputRules(task.output)
        const deps = edges
          .map(e => stepByTaskId.get(e.source_task_id))
          .filter(Boolean)
          .sort((a, b) => a - b)
        return (
          <div key={task.id} className="border-b border-line-2 last:border-b-0">
            <button
              onClick={() => toggle(task.id)}
              className="w-full flex items-center gap-2.5 py-2.5 px-2 text-left rounded-md hover:bg-surf-2 transition-colors"
            >
              <ChevronRight size={13} className={clsx('text-mute-2 transition-transform shrink-0', isOpen && 'rotate-90')} />
              <span className={clsx('font-mono text-[11px] shrink-0 w-3 text-center', statusTextColor(task.status))}>
                {STATUS_ICON[task.status] ?? '○'}
              </span>
              <span className="font-mono text-[10px] text-mute-2 shrink-0 w-5">{String(step).padStart(2, '0')}</span>
              <span className="flex-1 text-[13px] font-medium text-ink truncate">{task.text}</span>
              {prefix && task.short_id != null && (
                <span className="font-mono text-[10px] text-mute shrink-0">{prefix}-{task.short_id}</span>
              )}
              {deps.length > 0 && (
                <span className="font-mono text-[10px] text-mute-2 shrink-0">
                  ← {deps.map(d => String(d).padStart(2, '0')).join(', ')}
                </span>
              )}
            </button>

            {isOpen && (
              <div className="pl-[34px] pr-2 pb-3.5 flex flex-col gap-3">
                {edges.map((e, i) => {
                  const srcStep = stepByTaskId.get(e.source_task_id)
                  const rules = e.contract?.rules ?? []
                  return (
                    <div key={i}>
                      <Kicker className="mb-1">INPUT{srcStep ? ` · FROM STEP ${String(srcStep).padStart(2, '0')}` : ''}</Kicker>
                      {rules.length
                        ? rules.map((r, j) => <RuleRow key={j} rule={r} />)
                        : <p className="text-[11px] text-mute-2">No acceptance rules set.</p>}
                    </div>
                  )
                })}
                <div>
                  <Kicker className="mb-1">OUTPUT · DEFINITION OF DONE</Kicker>
                  {oRules.length
                    ? oRules.map((r, j) => <RuleRow key={j} rule={r} />)
                    : <p className="text-[11px] text-mute-2">No output contract set.</p>}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
