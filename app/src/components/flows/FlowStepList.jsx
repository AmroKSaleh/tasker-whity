import { useState, useMemo } from 'react'
import clsx from 'clsx'
import { ChevronRight, ShieldCheck, AlertTriangle, Bot, User, Link } from 'lucide-react'
import { Kicker } from '../editorial/atoms'
import { inputEdges, outputRules, isConfirmed, lintRule } from '../../lib/flowGraph'
import { flowTerminalIds } from '../../lib/flowExceptions'

const EXECUTOR_CONFIG = {
  agent:    { Icon: Bot,  label: 'AGENT',    cls: 'text-mute-2 border-mute-2/40' },
  user:     { Icon: User, label: 'USER',     cls: 'text-accent border-accent/50' },
  external: { Icon: Link, label: 'EXTERNAL', cls: 'text-[#c08030] border-[#c08030]/50' },
}

function ExecutorBadge({ executor }) {
  const cfg = EXECUTOR_CONFIG[executor] || EXECUTOR_CONFIG.agent
  const { Icon, label, cls } = cfg
  return (
    <span className={clsx('inline-flex items-center gap-1 font-mono text-[9px] font-semibold px-1.5 py-px rounded border shrink-0', cls)}>
      <Icon size={9} />
      {label}
    </span>
  )
}

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

// One validator critique line — pass/fail glyph + rule label + the validator's note.
function CritiqueRuleRow({ rule, ok }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={clsx('mt-[1px] text-[11px] font-bold shrink-0', ok ? 'text-[#3a9d57]' : 'text-[#C0432D]')}>{ok ? '✓' : '✗'}</span>
      <span className="text-[11.5px] text-ink-2 leading-snug">
        <span className="font-medium">{rule.label || rule.rule_id}</span>
        {rule.note && <span className="text-mute-2"> — {rule.note}</span>}
        {rule.observed_value && <span className="block font-mono text-[9.5px] text-mute-2 mt-0.5 whitespace-pre-wrap">{rule.observed_value}</span>}
      </span>
    </div>
  )
}

// The validator subagent's critique for one handoff edge (TDE-215): overall verdict +
// per-rule fails (first) and passes. Reads output.critiques written by submit_validation_result.
function CritiqueBlock({ critique, toStep }) {
  const fails = critique.fails ?? []
  const passes = critique.passes ?? []
  const pass = critique.overall === 'pass'
  return (
    <div>
      <Kicker className="mb-1">
        VALIDATION{toStep ? ` · → STEP ${String(toStep).padStart(2, '0')}` : ''} ·{' '}
        <span className={pass ? 'text-[#3a9d57]' : 'text-[#C0432D]'}>{pass ? 'PASS' : 'FAIL'}</span>
        {critique.validator && critique.validator !== 'unverified' ? ` · ${critique.validator}` : ''}
      </Kicker>
      {(fails.length || passes.length)
        ? <>{fails.map((r, i) => <CritiqueRuleRow key={`f${i}`} rule={r} ok={false} />)}
            {passes.map((r, i) => <CritiqueRuleRow key={`p${i}`} rule={r} ok />)}</>
        : <p className="text-[11px] text-mute-2">No per-rule notes recorded.</p>}
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
  // TDE-816 / Q7: the terminal output is the one gate that is unconditional — nothing
  // downstream can catch a problem in it — so it is marked where the steps are, not only
  // in the exceptions list. Same derivation the MCP uses, so the two cannot disagree.
  const terminalIds = useMemo(() => flowTerminalIds(steps.map(s => s.task)), [steps])

  return (
    <div className="flex flex-col">
      {steps.map(({ task, step }) => {
        const isOpen = open.has(task.id)
        const edges = inputEdges(task.input)
        const oRules = outputRules(task.output)
        const critiques = (task.output?.critiques && typeof task.output.critiques === 'object')
          ? Object.entries(task.output.critiques)
          : []
        const deps = edges
          .map(e => stepByTaskId.get(e.source_task_id))
          .filter(Boolean)
          .sort((a, b) => a - b)
        const isTerminal = terminalIds.has(task.id)
        return (
          <div key={task.id} className={clsx("border-b border-line-2 last:border-b-0 relative", task.status === 'in_progress' && "bg-accent/5")}>
            {task.status === 'in_progress' && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent z-10" />}
            <div className={clsx("w-full flex items-center gap-2.5 py-2.5 px-2 rounded-md transition-colors", task.status !== 'in_progress' && "hover:bg-surf-2")}>
              {/* Chevron toggles the INLINE contract view; the row body opens the full panel. */}
              <button
                onClick={() => toggle(task.id)}
                title={isOpen ? 'Hide contracts' : 'Show contracts inline'}
                className="shrink-0 p-0.5 -m-0.5 text-mute-2 hover:text-ink transition-colors z-10"
              >
                <ChevronRight size={13} className={clsx('transition-transform', isOpen && 'rotate-90')} />
              </button>
              <button
                onClick={() => onTaskClick ? onTaskClick(task.id) : toggle(task.id)}
                className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
              >
                <span className="font-mono text-[10px] text-mute-2 shrink-0 w-5">{String(step).padStart(2, '0')}</span>
                <span className={clsx("flex-1 text-[13px] font-medium truncate", task.status === 'in_progress' ? 'text-accent' : 'text-ink')}>{task.text}</span>
                {isTerminal && (
                  <span
                    title="Terminal output — nothing inside the flow consumes this, so no later step can catch a problem in it. This gate is unconditional."
                    className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold px-1.5 py-px rounded border shrink-0 text-ink-2 border-ink-2/40"
                  >
                    ◆ TERMINAL
                  </span>
                )}
                {(task.executor === 'user' || task.executor === 'external') && (
                  <ExecutorBadge executor={task.executor} />
                )}
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
                {task.human_guidance && (
                  <div>
                    <Kicker className="mb-1">GUIDE INSTRUCTIONS · {(task.executor || 'user').toUpperCase()}</Kicker>
                    <p className="text-[11.5px] text-ink-2 leading-snug whitespace-pre-wrap">{task.human_guidance}</p>
                  </div>
                )}
                {edges.map((e, i) => {
                  const srcStep = stepByTaskId.get(e.source_task_id)
                  const rules = e.contract?.rules ?? []
                  return (
                    <div key={i}>
                      <Kicker className="mb-1">INPUT{srcStep ? ` · FROM STEP ${String(srcStep).padStart(2, '0')}` : ''}</Kicker>
                      {rules.length
                        ? rules.map((r, j) => <RuleRow key={j} rule={r} />)
                        : <p className="text-[11px] text-mute-2">Ungated — this step takes the handoff as-is.</p>}
                      <BlessTag contract={e.contract} hasRules={rules.length > 0} />
                    </div>
                  )
                })}
                <div>
                  <Kicker className="mb-1">OUTPUT · DEFINITION OF DONE{isTerminal ? ' · TERMINAL' : ''}</Kicker>
                  {oRules.length
                    ? oRules.map((r, j) => <RuleRow key={j} rule={r} />)
                    : <p className="text-[11px] text-mute-2">
                        {isTerminal
                          ? 'No definition of done — and nothing downstream will catch a problem here, so this output reaches you unchecked.'
                          : 'No definition of done — fine unless a later step builds on this without re-checking it.'}
                      </p>}
                  <BlessTag contract={task.output?.contract} hasRules={oRules.length > 0} />
                </div>
                {critiques.map(([edgeKey, c]) => (
                  <CritiqueBlock key={edgeKey} critique={c} toStep={stepByTaskId.get(edgeKey)} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
