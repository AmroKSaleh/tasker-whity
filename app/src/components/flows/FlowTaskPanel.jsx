import { useState, useEffect } from 'react'
import { X, CheckSquare, Square, Pencil, ShieldCheck, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { Kicker } from '../editorial/atoms'
import { inputEdges, outputRules, isConfirmed, lintRule } from '../../lib/flowGraph'
import EditTaskModal from '../tasks/EditTaskModal'
import ContractEditor from './ContractEditor'

const STATUS_DOT = { done: 'bg-[#4ade80]', in_progress: 'bg-accent', pending: 'bg-line' }
const STATUS_LABEL = { done: 'Done', in_progress: 'In Progress', pending: 'Pending' }
const PRIORITY_COLOR = { rush: 'text-[#C0432D]', high: 'text-accent', medium: 'text-mute', low: 'text-mute-2' }

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
          <span title={issue} className="inline-flex items-center gap-0.5 text-[#C0432D] ml-1.5 align-middle">
            <AlertTriangle size={10} />
          </span>
        )}
      </span>
    </div>
  )
}

// The blessing state of one contract + the action to bless it (TDE-287 cockpit).
function BlessRow({ confirmed, confirmedBy, hasRules, busy, onBless }) {
  if (!hasRules) return null
  if (confirmed) {
    return (
      <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-line-2 text-[10.5px] font-semibold text-[#3a9d57]">
        <ShieldCheck size={12} /> Human-blessed{confirmedBy ? ` · ${confirmedBy}` : ''}
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-line-2">
      <span className="text-[10.5px] font-semibold text-accent">⊘ AI-QA'd — needs review</span>
      <button
        disabled={busy}
        onClick={onBless}
        className="rounded border border-[#4ade80]/50 px-2 py-0.5 text-[10.5px] font-semibold text-[#3a9d57] hover:bg-[#4ade80]/10 transition-colors disabled:opacity-50"
      >
        {busy ? 'Blessing…' : 'Bless'}
      </button>
    </div>
  )
}

export default function FlowTaskPanel({ task, stepIndex, totalSteps, prefix, onClose, onTaskUpdated }) {
  const [milestones, setMilestones] = useState(null)
  const [checkedSteps, setCheckedSteps] = useState([])
  const [editing, setEditing] = useState(false)
  const [editingContracts, setEditingContracts] = useState(false)
  const [saving, setSaving] = useState(false)

  const [inputEdgesState, setInputEdgesState] = useState([])
  const [outputRulesState, setOutputRulesState] = useState([])
  const [outputConfirmed, setOutputConfirmed] = useState(false)
  const [outputConfirmedBy, setOutputConfirmedBy] = useState(null)
  const [blessing, setBlessing] = useState(null)

  useEffect(() => {
    if (!task?.id) return
    let cancelled = false
    supabase
      .from('task_discussions')
      .select('steps, checked_steps')
      .eq('task_id', task.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setMilestones(data?.steps ?? [])
        setCheckedSteps(data?.checked_steps ?? [])
      })
    return () => { cancelled = true }
  }, [task?.id])

  useEffect(() => {
    setInputEdgesState(inputEdges(task?.input))
    setOutputRulesState(outputRules(task?.output))
    setOutputConfirmed(isConfirmed(task?.output?.contract))
    setOutputConfirmedBy(task?.output?.contract?.confirmed_by ?? null)
    setEditingContracts(false)
  }, [task?.id])

  if (!task) return null

  const stepLabel = stepIndex != null ? `Step ${stepIndex} of ${totalSteps}` : null

  async function saveContracts() {
    setSaving(true)
    // Re-authoring a contract resets it to AI-QA'd (must be re-blessed) — mirrors the
    // server (set_task_input/output reset confirmed). Keeps the blessing honest.
    const newInput = { edges: inputEdgesState.map(e => ({ ...e, contract: { ...e.contract, confirmed: false } })) }
    const prevOutput = (task.output && typeof task.output === 'object') ? task.output : {}
    const newOutput = { ...prevOutput, contract: { rules: outputRulesState, confirmed: false } }
    await supabase.from('tasks').update({ input: newInput, output: newOutput }).eq('id', task.id)
    setSaving(false)
    setEditingContracts(false)
    onTaskUpdated?.()
  }

  async function blessOutput() {
    setBlessing('output')
    const prev = (task.output && typeof task.output === 'object') ? task.output : {}
    const prevC = prev.contract || {}
    await supabase.from('tasks').update({
      output: { ...prev, contract: { ...prevC, confirmed: true, confirmed_at: new Date().toISOString(), confirmed_by: 'human' } },
    }).eq('id', task.id)
    setOutputConfirmed(true)
    setOutputConfirmedBy('human')
    setBlessing(null)
    onTaskUpdated?.()
  }

  async function blessInput(sourceTaskId) {
    setBlessing('in:' + sourceTaskId)
    const edges = inputEdges(task.input)
    const updated = edges.map(e => e.source_task_id === sourceTaskId
      ? { ...e, contract: { ...e.contract, confirmed: true, confirmed_at: new Date().toISOString(), confirmed_by: 'human' } }
      : e)
    await supabase.from('tasks').update({ input: { edges: updated } }).eq('id', task.id)
    setInputEdgesState(updated)
    setBlessing(null)
    onTaskUpdated?.()
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 z-40 w-full max-w-[440px] bg-paper border-l border-line-2 flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-line-2 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {stepLabel && (
                <Kicker className="mb-1">{stepLabel}{prefix && task.short_id != null ? ` · ${prefix}-${task.short_id}` : ''}</Kicker>
              )}
              <h3 className="text-[15px] font-semibold text-ink leading-snug">{task.text}</h3>
              <div className="flex items-center gap-2 mt-1.5">
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[task.status])} />
                <span className="text-[11.5px] text-mute">{STATUS_LABEL[task.status]}</span>
                {task.priority && (
                  <span className={clsx('font-mono text-[10px] uppercase tracking-[0.06em]', PRIORITY_COLOR[task.priority])}>
                    · {task.priority}
                  </span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="rounded-md p-1.5 text-mute hover:text-ink hover:bg-surf-2 transition-colors shrink-0">
              <X size={16} />
            </button>
          </div>
          <div className="flex gap-2 mt-2.5">
            <button
              onClick={() => setEditing(true)}
              className="rounded-md border border-line-2 px-3 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-line transition-colors"
            >
              Edit task
            </button>
            <button
              onClick={() => setEditingContracts(c => !c)}
              className={clsx(
                'rounded-md border px-3 py-1 text-[11px] font-semibold transition-colors flex items-center gap-1.5',
                editingContracts ? 'border-accent text-accent bg-surf-2' : 'border-line-2 text-mute hover:text-ink hover:border-line',
              )}
            >
              <Pencil size={11} />
              {editingContracts ? 'Editing contracts' : 'Edit contracts'}
            </button>
            {editingContracts && (
              <button
                onClick={saveContracts}
                disabled={saving}
                className="rounded-md border border-[#4ade80]/60 px-3 py-1 text-[11px] font-semibold text-[#4ade80] hover:bg-[#4ade80]/10 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-5 no-scrollbar">
          {/* Context */}
          <div>
            <Kicker className="mb-1.5">Context</Kicker>
            {task.detail ? (
              <p className="text-[12.5px] text-ink-2 leading-relaxed whitespace-pre-wrap">{task.detail}</p>
            ) : (
              <p className="text-[12px] text-mute-2">No context set.</p>
            )}
          </div>

          {/* Input contracts */}
          {editingContracts ? (
            <div className="flex flex-col gap-3">
              {inputEdgesState.map((e, i) => (
                <ContractEditor
                  key={i}
                  title={`Input contract ${inputEdgesState.length > 1 ? i + 1 : ''}`}
                  rules={e.contract?.rules ?? []}
                  onChange={newRules => {
                    setInputEdgesState(prev => prev.map((edge, j) =>
                      j === i ? { ...edge, contract: { ...edge.contract, rules: newRules } } : edge
                    ))
                  }}
                />
              ))}
            </div>
          ) : inputEdgesState.length > 0 && (
            <div>
              <Kicker className="mb-1.5">Input contracts</Kicker>
              <div className="flex flex-col gap-3">
                {inputEdgesState.map((e, i) => {
                  const rules = e.contract?.rules ?? []
                  return (
                    <div key={i} className="rounded-lg border border-line-2 px-3 py-2.5">
                      {rules.length
                        ? rules.map((r, j) => <RuleRow key={j} rule={r} />)
                        : <p className="text-[11px] text-mute-2">Ungated — this step takes the handoff as-is.</p>}
                      <BlessRow
                        confirmed={isConfirmed(e.contract)}
                        confirmedBy={e.contract?.confirmed_by}
                        hasRules={rules.length > 0}
                        busy={blessing === 'in:' + e.source_task_id}
                        onBless={() => blessInput(e.source_task_id)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Output contract */}
          {editingContracts ? (
            <ContractEditor
              title="Output · Definition of Done"
              rules={outputRulesState}
              onChange={setOutputRulesState}
            />
          ) : (
            <div>
              <Kicker className="mb-1.5">Output · Definition of Done</Kicker>
              {outputRulesState.length ? (
                <div className="rounded-lg border border-line-2 px-3 py-2.5">
                  {outputRulesState.map((r, i) => <RuleRow key={i} rule={r} />)}
                  <BlessRow
                    confirmed={outputConfirmed}
                    confirmedBy={outputConfirmedBy}
                    hasRules={outputRulesState.length > 0}
                    busy={blessing === 'output'}
                    onBless={blessOutput}
                  />
                </div>
              ) : (
                <p className="text-[12px] text-mute-2">No definition of done — fine unless a later step builds on this without re-checking it.</p>
              )}
            </div>
          )}

          {/* Milestones */}
          <div>
            <Kicker className="mb-1.5">Milestones</Kicker>
            {milestones == null ? (
              <p className="text-[12px] text-mute-2">Loading…</p>
            ) : milestones.length === 0 ? (
              <p className="text-[12px] text-mute-2">No milestones.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {milestones.map((m, i) => {
                  // Steps may be plain strings or objects { summary, detail } — render
                  // safely either way (mirrors get_task); rendering a raw object crashes React.
                  const label = typeof m === 'string' ? m : (m?.summary ?? '')
                  const done = checkedSteps[i] === true
                  return (
                    <div key={i} className="flex items-start gap-2">
                      {done
                        ? <CheckSquare size={14} className="text-[#4ade80] shrink-0 mt-0.5" />
                        : <Square size={14} className="text-mute-2 shrink-0 mt-0.5" />}
                      <span className={clsx('text-[12.5px] leading-snug', done ? 'text-mute-2 line-through' : 'text-ink-2')}>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <EditTaskModal
          task={task}
          onClose={() => { setEditing(false); onTaskUpdated?.() }}
        />
      )}
    </>
  )
}
