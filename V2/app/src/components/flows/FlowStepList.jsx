import { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, ShieldCheck, AlertTriangle } from 'lucide-react'
import { Kicker } from '../editorial/atoms'
import { inputEdges, outputRules, isConfirmed, lintRule } from '../../lib/flowGraph'

function RuleRow({ rule }) {
  const warn = rule.severity === 'warning'
  const issue = lintRule(rule)
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
        {issue && (
          <span title={issue} className="inline-flex items-center text-[#C0432D] ml-1.5 align-middle">
            <AlertTriangle size={10} />
          </span>
        )}
      </span>
    </div>
  )
}

// Read-only blessing indicator for the inline view (bless action lives in the panel).
function BlessTag({ contract, hasRules }) {
  if (!hasRules) return null
  return isConfirmed(contract) ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#3a9d57] mt-1">
      <ShieldCheck size={11} /> Human-blessed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-accent mt-1">
      ⊘ AI-QA'd
    </span>
  )
}

export default function FlowStepList({ steps, prefix, onTaskClick }) {
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
            <div className="w-full flex items-center gap-2.5 py-2.5 px-2 rounded-md hover:bg-surf-2 transition-colors">
              {/* Chevron toggles the INLINE contract view; the row body opens the full panel. */}
              <button
                onClick={() => toggle(task.id)}
                title={isOpen ? 'Hide contracts' : 'Show contracts inline'}
                className="shrink-0 p-0.5 -m-0.5 text-mute-2 hover:text-ink transition-colors"
              >
                <ChevronRight size={13} className={clsx('transition-transform', isOpen && 'rotate-90')} />
              </button>
              <button
                onClick={() => onTaskClick ? onTaskClick(task.id) : toggle(task.id)}
                className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
              >
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
            </div>

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
                      <BlessTag contract={e.contract} hasRules={rules.length > 0} />
                    </div>
                  )
                })}
                <div>
                  <Kicker className="mb-1">OUTPUT · DEFINITION OF DONE</Kicker>
                  {oRules.length
                    ? oRules.map((r, j) => <RuleRow key={j} rule={r} />)
                    : <p className="text-[11px] text-mute-2">No output contract set.</p>}
                  <BlessTag contract={task.output?.contract} hasRules={oRules.length > 0} />
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
