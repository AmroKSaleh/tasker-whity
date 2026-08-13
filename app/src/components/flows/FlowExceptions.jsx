import { useState, useMemo } from 'react'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { Kicker } from '../editorial/atoms'
import { deriveFlowExceptions } from '../../lib/flowExceptions'

// TDE-816 / TDE-382. The page used to open with every contract expanded and nothing
// about what needs a human. This opens with the exceptions instead: failed checks WITH
// the observed value, judgment criteria nothing could check, and the terminal output.
// Passing checks and step artifacts are deliberately absent — showing everything is what
// produces rubber-stamping (Q7), and a rubber-stamped output is worse than an ungated one.
//
// The exceptions come from the MCP's own derivation (lib/flowExceptions), not a mirror,
// so this panel and get_flow_exceptions cannot disagree about what needs you.

const GROUPS = [
  { kind: 'failed_check', glyph: '✗', title: 'FAILED CHECKS', sub: 'a gate rejected something', tone: 'text-[#C0432D]' },
  { kind: 'judgment_residue', glyph: '?', title: 'JUDGMENT RESIDUE', sub: 'nothing could check these for you', tone: 'text-accent' },
  { kind: 'terminal', glyph: '◆', title: 'TERMINAL OUTPUT', sub: 'unconditional gate', tone: 'text-ink-2' },
]

function BlastTag({ blast }) {
  if (!blast) return null
  return (
    <span
      title={`${blast} later step${blast !== 1 ? 's' : ''} build${blast === 1 ? 's' : ''} on this one — a problem here contaminates all of them.`}
      className="font-mono text-[9px] text-mute-2 border border-line-2 rounded px-1 py-px shrink-0"
    >
      ↓{blast}
    </span>
  )
}

function ExceptionRow({ exc, step, onTaskClick }) {
  const { task, failure, residue, kind } = exc
  return (
    <button
      onClick={() => onTaskClick?.(task.id)}
      className="w-full text-left rounded-md border border-line-2 px-2.5 py-2 hover:bg-surf-2 hover:border-line transition-colors"
    >
      <div className="flex items-center gap-2">
        {step != null && <span className="font-mono text-[10px] text-mute-2 shrink-0">{String(step).padStart(2, '0')}</span>}
        <span className="flex-1 min-w-0 text-[12.5px] font-medium text-ink truncate">{task.text}</span>
        <BlastTag blast={exc.blast} />
        <span className="font-mono text-[9.5px] text-mute shrink-0">{task.ref}</span>
      </div>

      {kind === 'failed_check' && (
        <div className="mt-1 pl-[26px]">
          <p className="text-[11.5px] text-ink-2 leading-snug">
            <span className="font-mono text-[8.5px] font-bold tracking-[0.06em] bg-ink-2 text-paper rounded px-1 mr-1.5 align-[1px]">
              {failure.severity === 'warning' ? 'WARN' : 'BLOCK'}
            </span>
            {failure.label}
            <span className="text-mute-2 font-mono text-[9px] ml-1.5">{failure.ruleKind}</span>
          </p>
          {/* The observed value IS the review. A claim that something failed is not
              reviewable; what was actually seen is. */}
          <p className={clsx(
            'font-mono text-[10px] whitespace-pre-wrap leading-snug mt-1 rounded border px-1.5 py-1',
            failure.observedValue ? 'text-ink-2 border-line-2 bg-surf-2' : 'text-mute-2 border-dashed border-line-2',
          )}>
            {failure.observedValue || 'no observed value recorded — the check was asserted, not run'}
          </p>
          {failure.note && <p className="text-[11px] text-mute leading-snug mt-1">{failure.note}</p>}
          <p className="text-[10.5px] text-mute-2 leading-snug mt-1">
            gate into {failure.gateInto ? `${failure.gateInto.ref} “${failure.gateInto.text}”` : failure.gateIntoKey}
            {failure.retryCount ? ` · ${failure.retryCount} retr${failure.retryCount === 1 ? 'y' : 'ies'} so far` : ''}
          </p>
        </div>
      )}

      {kind === 'judgment_residue' && (
        <div className="mt-1 pl-[26px]">
          <p className="text-[11.5px] text-ink-2 leading-snug">{residue.rule}</p>
          <p className="text-[10.5px] text-mute-2 leading-snug mt-0.5">
            This could not be reduced to a check, so no check has verified it.
          </p>
        </div>
      )}

      {kind === 'terminal' && (
        <div className="mt-1 pl-[26px]">
          <p className="text-[10.5px] text-mute-2 leading-snug">
            {task.status === 'done'
              ? 'Nothing downstream consumes this, so no later step can catch a problem in it.'
              : 'The operation ends here — this output is yours to gate once the step completes.'}
            {task.executor && task.executor !== 'agent' ? ` · executor: ${task.executor}` : ''}
          </p>
        </div>
      )}
    </button>
  )
}

export default function FlowExceptions({ flow, onTaskClick }) {
  const tasks = useMemo(() => flow.steps.map(s => s.task), [flow.steps])
  const excs = useMemo(() => deriveFlowExceptions(tasks, flow.projectPrefix), [tasks, flow.projectPrefix])
  const stepByTaskId = useMemo(() => new Map(flow.steps.map(s => [s.task.id, s.step])), [flow.steps])

  const failedCount = excs.filter(e => e.kind === 'failed_check').length
  // Failures are the thing you came for, so they open. Everything else collapses behind
  // a count when a failure exists — the review list should not compete with itself.
  const [collapsed, setCollapsed] = useState(() => failedCount > 0)

  if (!excs.length) {
    return (
      <div className="rounded-lg border border-line-2 px-3 py-2.5">
        <Kicker className="mb-1">WHAT NEEDS YOU</Kicker>
        <p className="text-[12px] text-mute leading-snug">
          Nothing. Every declared check passed and no judgment criterion is unverified.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Kicker className="flex-1">WHAT NEEDS YOU · {excs.length}</Kicker>
        <span
          title="Ordered by blast radius — how much downstream work builds on the step."
          className="font-mono text-[9px] text-mute-2 tracking-[0.06em]"
        >
          BY BLAST RADIUS
        </span>
      </div>

      {GROUPS.map(g => {
        const items = excs.filter(e => e.kind === g.kind)
        if (!items.length) return null
        const isCollapsible = g.kind !== 'failed_check' && failedCount > 0
        const isOpen = !isCollapsible || !collapsed
        return (
          <div key={g.kind} className="flex flex-col gap-1.5">
            {isCollapsible ? (
              <button
                onClick={() => setCollapsed(c => !c)}
                className="flex items-center gap-1.5 rounded border border-line-2 px-1.5 py-1 text-left hover:border-line transition-colors"
              >
                <ChevronRight size={12} className={clsx('shrink-0 text-mute-2 transition-transform', isOpen && 'rotate-90')} />
                <span className={clsx('font-mono text-[9.5px] font-bold tracking-[0.08em]', g.tone)}>{g.glyph} {g.title}</span>
                <span className="font-mono text-[9.5px] text-mute-2">{items.length}</span>
              </button>
            ) : (
              <div className="flex items-baseline gap-1.5">
                <span className={clsx('font-mono text-[9.5px] font-bold tracking-[0.08em]', g.tone)}>{g.glyph} {g.title}</span>
                <span className="font-mono text-[9.5px] text-mute-2">{items.length}</span>
                <span className="text-[10.5px] text-mute-2">— {g.sub}</span>
              </div>
            )}
            {isOpen && items.map((e, i) => (
              <ExceptionRow key={`${e.kind}-${e.task.id}-${i}`} exc={e} step={stepByTaskId.get(e.task.id)} onTaskClick={onTaskClick} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
