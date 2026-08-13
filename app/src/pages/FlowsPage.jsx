import { useState, useMemo, useEffect } from 'react'
import clsx from 'clsx'
import { ChevronLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useFlows } from '../hooks/useFlows'
import AppShell from '../components/editorial/AppShell'
import { Kicker, Pill } from '../components/editorial/atoms'
import FlowGraph from '../components/flows/FlowGraph'
import FlowStepList from '../components/flows/FlowStepList'
import FlowExceptions from '../components/flows/FlowExceptions'
import FlowTaskPanel from '../components/flows/FlowTaskPanel'

const STATUS_LABEL = { done: 'DONE', in_progress: 'IN PROGRESS', pending: 'PENDING' }
const STATUS_DOT = { done: 'bg-[#4ade80]', in_progress: 'bg-accent', pending: 'bg-line' }

// Contract-gate trust badge (TDE-287). Four states: legacy pre-TDE-820 finalization,
// ungated (nothing declared to gate), blessed (every declared contract is blessed), or
// N contracts still to sharpen/bless.
function GateBadge({ flow, size = 'sm' }) {
  const { gate, gateBypassed, gateBypassReason } = flow
  if (!gate) return null
  const pad = size === 'lg' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-px text-[10px]'
  // TDE-820: contracts no longer block finalization, so nothing is "bypassed" any more.
  // This flag only survives on flows named BEFORE that change, and back then the sole way
  // to create a legitimately ungated flow WAS to bypass — so most of these are not
  // wrongdoing. Kept visible for provenance (and TDE-784 analytics) but no longer styled
  // as a violation: neutral, not alarm-red, and worded as history rather than weakness.
  if (gateBypassed) {
    return (
      <span title={`Finalized before contracts became optional (TDE-820)${gateBypassReason ? ` — recorded reason: ${gateBypassReason}` : ''}. Under the current definition an ungated flow is valid, so this is history, not a defect.`}
        className={clsx('inline-flex items-center gap-1 rounded border font-semibold border-line text-mute bg-surf-2', pad)}>
        ◷ Pre-gate-change
      </span>
    )
  }
  // No declared handoffs — a legitimate state, not a pass and not a failure. Showing
  // "Contracts blessed" here would claim a guarantee nothing is actually providing.
  if (gate.edgeCount === 0) {
    return (
      <span title="No gates — nothing here hands work over in a way the next step takes on trust. Gates belong only at seams, so a flow can hold none."
        className={clsx('inline-flex items-center gap-1 rounded border font-semibold border-line text-mute bg-surf-2', pad)}>
        ○ Ungated
      </span>
    )
  }
  if (gate.ok) {
    return (
      <span title="Every handoff has a non-trivial, human-blessed contract"
        className={clsx('inline-flex items-center gap-1 rounded border font-semibold border-[#4ade80]/40 text-[#3a9d57] bg-[#4ade80]/5', pad)}>
        ✓ Contracts blessed
      </span>
    )
  }
  const label = gate.weak > 0
    ? `${gate.total} contract${gate.total !== 1 ? 's' : ''} to sharpen`
    : `${gate.unblessed} to bless`
  return (
    // TDE-820: these no longer block anything — the flow exists and runs. Worded as
    // outstanding work on declared contracts, not as a gate refusing the flow.
    <span title={`${gate.unblessed} AI-QA'd but not human-blessed, ${gate.weak} vague or empty. Nothing is blocked — bless a contract before relying on it as a gate.`}
      className={clsx('inline-flex items-center gap-1 rounded border font-semibold border-accent/40 text-accent bg-surf-2', pad)}>
      ⊘ {label}
    </span>
  )
}

// TDE-811: with an open step list the total is not knowable, so the progress readout
// carries no denominator rather than a made-up one, and "every known step is done" is
// reported as its own state — it is not the same as finished.
function progressLine(flow) {
  return flow.stepListOpen
    ? `${flow.doneCount} DONE · ${flow.stepCount} STEP${flow.stepCount !== 1 ? 'S' : ''} SO FAR`
    : `${flow.doneCount}/${flow.stepCount} DONE`
}

// How far through the operation am I, and is it moving. The other cockpit question —
// where does it need me — is answered by FlowExceptions, so this no longer duplicates it
// by naming unblessed contracts (the header's GateBadge already carries that count).
function LiveStatusBanner({ flow }) {
  const activeSteps = flow.steps.filter(s => s.task.status === 'in_progress')
  const isRunning = activeSteps.length > 0
  const allKnownDone = flow.doneCount === flow.stepCount

  let tone, head, body
  if (flow.status === 'done') {
    tone = 'text-[#3a9d57]'
    head = '✓ FLOW COMPLETE'
    body = <span className="text-mute-2">All {flow.stepCount} steps have been executed and verified.</span>
  } else if (flow.stepListOpen && allKnownDone) {
    tone = 'text-mute'
    head = '◷ MORE STEPS TO COME'
    body = <span className="text-mute-2">Every known step is done, but the step list is still open — this operation is not finished until it closes.</span>
  } else if (isRunning) {
    tone = 'text-accent'
    head = 'OPERATION IN PROGRESS'
    body = <span className="text-ink">Currently executing step{activeSteps.length !== 1 ? 's' : ''}: {activeSteps.map(s => String(s.step).padStart(2, '0')).join(', ')}</span>
  } else {
    tone = 'text-mute'
    head = '⏸ WAITING FOR EXECUTION'
    body = <span className="text-mute-2">Flow is ready. Start the agent in Claude Code to continue.</span>
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className={clsx('font-mono text-[10px] font-bold tracking-wider flex items-center gap-1.5', tone)}>
        {isRunning && flow.status !== 'done' && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
          </span>
        )}
        {head}
        <span className="flex-1" />
        <span className="text-mute-2 font-semibold tracking-[0.06em]">{progressLine(flow)}</span>
      </span>
      <span className="text-[12px] leading-snug">{body}</span>
    </div>
  )
}

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
        {flow.shortId
          ? <span className="font-mono text-[9.5px] text-accent shrink-0">{flow.shortId}</span>
          : flow.projectPrefix && <span className="font-mono text-[9.5px] text-mute shrink-0">{flow.projectPrefix}</span>
        }
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-mute-2 tracking-[0.04em] pl-3.5">
        <span>{flow.stepCount} STEPS{flow.stepListOpen ? ' SO FAR' : ''}</span>
        <span>·</span>
        <span title={flow.stepListOpen ? 'The step list is open — more steps may still be added, so there is no total to count against.' : undefined}>
          {flow.stepListOpen ? `${flow.doneCount} DONE` : `${flow.doneCount}/${flow.stepCount} DONE`}
        </span>
        <span className="flex-1" />
        <GateBadge flow={flow} />
      </div>
    </button>
  )
}

function FlowDetail({ flow, onBack, listOpen, onToggleList, onChanged, onDeleted }) {
  const [listWidth, setListWidth] = useState(420)
  const [panel, setPanel] = useState(null) // 'is' | 'kb' | null
  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const [flowIs, setFlowIs] = useState(null)
  const [flowKb, setFlowKb] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [editingShortId, setEditingShortId] = useState(false)
  const [shortIdDraft, setShortIdDraft] = useState('')
  const [shortIdError, setShortIdError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateSaved, setTemplateSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  async function doSaveAsTemplate() {
    if (!flow.flowRecordId) return
    setSavingTemplate(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: tmpl } = await supabase.from('flow_templates')
      .insert({ user_id: user.id, name: flow.name, description: `Template from flow "${flow.name}"` })
      .select('id').single()
    if (tmpl) {
      await Promise.all(
        flow.steps
          .sort((a, b) => a.step - b.step)
          .map(({ task, step }) =>
            supabase.from('flow_template_steps').insert({
              template_id: tmpl.id, step_order: step,
              title: task.text, detail_scaffold: task.detail ?? null,
              input_contract: task.input ? JSON.stringify(task.input) : null,
              output_contract: task.output ? JSON.stringify(task.output) : null,
            })
          )
      )
      setTemplateSaved(true)
      setTimeout(() => setTemplateSaved(false), 3000)
    }
    setSavingTemplate(false)
  }

  async function doDuplicate() {
    setBusy(true)
    setDuplicating(false)
    const { data: { user } } = await supabase.auth.getUser()
    // Find the last section to append a new one after
    const { data: secs } = await supabase.from('sections')
      .select('sort_order').eq('project_id', flow.projectId).order('sort_order', { ascending: false }).limit(1)
    const sortOrder = ((secs?.[0]?.sort_order) ?? -1) + 1
    const { data: newSec } = await supabase.from('sections')
      .insert({ project_id: flow.projectId, name: `${flow.name} (copy)`, sort_order: sortOrder })
      .select('id').single()
    if (!newSec) { setBusy(false); return }
    // Create a new flow record
    const dupName = `${flow.name} (copy)`
    const { data: newFlow } = await supabase.from('flows')
      .insert({ user_id: user.id, project_id: flow.projectId, name: dupName })
      .select('id').single()
    if (!newFlow) { setBusy(false); return }
    // Create duplicate tasks preserving step order; remap old IDs → new IDs for edge rebuilding
    const idMap = {}
    const sortedSteps = [...flow.steps].sort((a, b) => a.step - b.step)
    for (const { task, step } of sortedSteps) {
      const { data: newTask } = await supabase.from('tasks')
        .insert({
          user_id: user.id, project_id: flow.projectId,
          section_id: newSec.id, text: task.text, detail: task.detail ?? null,
          priority: task.priority ?? null, status: 'pending',
          flow_id: newFlow.id, flow_step: step,
          output: task.output ?? null,
        })
        .select('id').single()
      if (newTask) idMap[task.id] = newTask.id
    }
    // Rebuild input edges using remapped IDs
    for (const { task } of sortedSteps) {
      const newId = idMap[task.id]
      if (!newId || !task.input?.edges?.length) continue
      const newEdges = task.input.edges
        .filter(e => idMap[e.source_task_id])
        .map(e => ({ ...e, source_task_id: idMap[e.source_task_id] }))
      if (newEdges.length) {
        await supabase.from('tasks').update({ input: { edges: newEdges } }).eq('id', newId)
      }
    }
    setBusy(false)
    onChanged?.()
  }

  async function doRename() {
    const name = nameDraft.trim()
    if (!name || name === flow.name) { setRenaming(false); return }
    setBusy(true)
    if (flow.flowRecordId) {
      await supabase.from('flows').update({ name }).eq('id', flow.flowRecordId)
    } else {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: rec } = await supabase.from('flows')
        .insert({ user_id: user.id, project_id: flow.projectId, name }).select('id').single()
      if (rec) {
        await Promise.all(flow.steps.map((s, i) =>
          supabase.from('tasks').update({ flow_id: rec.id, flow_step: i + 1 }).eq('id', s.task.id)))
      }
    }
    setBusy(false)
    setRenaming(false)
    onChanged?.()
  }

  async function doDelete() {
    setBusy(true)
    // New parking section: "[Flow name] - Flow Tasks"
    const { data: secs } = await supabase.from('sections')
      .select('sort_order').eq('project_id', flow.projectId).order('sort_order', { ascending: false }).limit(1)
    const sortOrder = ((secs?.[0]?.sort_order) ?? -1) + 1
    const { data: newSec } = await supabase.from('sections')
      .insert({ project_id: flow.projectId, name: `${flow.name} - Flow Tasks`, sort_order: sortOrder })
      .select('id').single()
    // Move tasks to it (ungrouped) and dissolve the flow by clearing their input edges.
    if (newSec) {
      await Promise.all(flow.steps.map(s =>
        supabase.from('tasks').update({ section_id: newSec.id, group_id: null, input: { edges: [] } }).eq('id', s.task.id)))
    }
    // Delete the named-flow record (cascades flow IS/KB; tasks.flow_id is set null by FK).
    if (flow.flowRecordId) {
      await supabase.from('flows').delete().eq('id', flow.flowRecordId)
    }
    setBusy(false)
    setConfirmDelete(false)
    onDeleted?.()
  }

  async function autoAssignShortId() {
    if (!flow.flowRecordId) return
    setBusy(true)
    // Compute next short_id on the client using the same rules as the MCP
    const prefix = flow.projectPrefix
    let shortId
    if (prefix) {
      const { data: existing } = await supabase.from('flows').select('short_id').eq('user_id', (await supabase.auth.getUser()).data.user.id).like('short_id', `${prefix}-F%`)
      const usedNums = (existing || []).map(f => { const m = f.short_id?.match(/^.+-F(\d+)$/); return m ? parseInt(m[1], 10) : 0 })
      const nextN = usedNums.length ? Math.max(...usedNums) + 1 : 1
      shortId = `${prefix}-F${nextN}`
    } else {
      const { count } = await supabase.from('flows').select('id', { count: 'exact', head: true }).not('short_id', 'is', null)
      shortId = `${flow.name} - F${(count ?? 0) + 1}`
    }
    await supabase.from('flows').update({ short_id: shortId }).eq('id', flow.flowRecordId)
    setBusy(false)
    onChanged?.()
  }

  async function saveShortId() {
    const val = shortIdDraft.trim()
    setEditingShortId(false)
    setShortIdError('')
    if (!flow.flowRecordId) return
    if (!val || val === flow.shortId) return
    setBusy(true)
    const { error } = await supabase.from('flows').update({ short_id: val }).eq('id', flow.flowRecordId)
    if (error) setShortIdError('That ID is already in use.')
    setBusy(false)
    onChanged?.()
  }

  // Load the flow's IS + KB (named-flow records). Only present once a flow is named.
  useEffect(() => {
    setPanel(null); setFlowIs(null); setFlowKb(null)
    if (!flow.flowRecordId) return
    let cancelled = false
    ;(async () => {
      const [{ data: is }, { data: kb }] = await Promise.all([
        supabase.from('flow_instructions').select('id, title, content').eq('flow_id', flow.flowRecordId).order('created_at'),
        supabase.from('flow_knowledge').select('id, title, content').eq('flow_id', flow.flowRecordId).order('created_at'),
      ])
      if (cancelled) return
      setFlowIs(is || []); setFlowKb(kb || [])
    })()
    return () => { cancelled = true }
  }, [flow.flowRecordId, flow.id])

  const panelEntries = panel === 'is' ? flowIs : panel === 'kb' ? flowKb : null
  const hasGraph = (flow.gate?.edgeCount ?? 0) > 0

  function startResizeX(e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = listWidth
    function onMove(ev) {
      setListWidth(Math.max(250, Math.min(800, startW - (ev.clientX - startX))))
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="flex flex-col h-full relative">
      <div className="px-6 pt-6 pb-3 border-b border-line-2 shrink-0">
        <button onClick={onBack} className="md:hidden flex items-center gap-1 text-[12px] text-mute mb-2">
          <ChevronLeft size={13} /> All flows
        </button>
        {!listOpen && (
          <button
            onClick={onToggleList}
            title="Show flow list"
            className="inline-flex items-center gap-1.5 text-[11px] text-mute hover:text-ink mb-2 transition-colors"
          >
            <PanelLeftOpen size={14} />
            <span>Show list</span>
          </button>
        )}
        <Kicker>{flow.projectName}{flow.projectPrefix ? ` · ${flow.projectPrefix}` : ''}</Kicker>
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(false) }}
            onBlur={doRename}
            className="text-h2 mt-1 w-full bg-paper border border-accent rounded-md px-2 py-1 outline-none"
          />
        ) : (
          <h2 className="text-h2 mt-1">{flow.name}</h2>
        )}
        <div className="flex items-center gap-2.5 mt-1">
          <span className="font-mono text-[10px] text-mute-2 tracking-[0.06em]">
            {flow.stepCount} STEPS{flow.stepListOpen ? ' SO FAR' : ''} · {progressLine(flow)} · {STATUS_LABEL[flow.status]}
          </span>
          <GateBadge flow={flow} size="lg" />
        </div>
        {flow.gateBypassed && flow.gateBypassReason && (
          <p className="text-[11px] text-mute mt-1.5 leading-snug">
            Finalized before contracts became optional — recorded reason: <span className="italic">{flow.gateBypassReason}</span>
          </p>
        )}
        {/* Short ID row */}
        <div className="flex items-center gap-2 mt-1.5">
          {editingShortId ? (
            <input
              autoFocus
              value={shortIdDraft}
              onChange={e => setShortIdDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveShortId(); if (e.key === 'Escape') { setEditingShortId(false); setShortIdError('') } }}
              onBlur={saveShortId}
              placeholder="e.g. BKT-F1"
              className="font-mono text-[11px] bg-paper border border-accent rounded px-1.5 py-0.5 outline-none w-28"
            />
          ) : flow.shortId ? (
            <button
              onClick={() => { setShortIdDraft(flow.shortId); setEditingShortId(true) }}
              title="Edit short ID"
              className="font-mono text-[10.5px] text-accent border border-accent/30 rounded px-1.5 py-0.5 hover:border-accent transition-colors"
            >
              {flow.shortId}
            </button>
          ) : flow.flowRecordId ? (
            <button
              onClick={autoAssignShortId}
              disabled={busy}
              className="font-mono text-[10px] text-mute border border-line-2 rounded px-1.5 py-0.5 hover:text-ink hover:border-line transition-colors disabled:opacity-50"
            >
              + Assign ID
            </button>
          ) : null}
          {shortIdError && <span className="text-[10.5px] text-[#C0432D]">{shortIdError}</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          {['is', 'kb'].map(kind => {
            const entries = kind === 'is' ? flowIs : flowKb
            const count = entries?.length ?? null
            return (
              <button
                key={kind}
                onClick={() => setPanel(p => (p === kind ? null : kind))}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  panel === kind ? 'border-accent text-accent bg-surf-2' : 'border-line-2 text-mute hover:text-ink hover:border-line',
                )}
              >
                {kind === 'is' ? 'IS' : 'KB'}
                {count != null && <span className="font-mono text-[10px] text-mute-2">{count}</span>}
              </button>
            )
          })}
          <span className="flex-1" />
          {flow.flowRecordId && (
            <button
              onClick={doSaveAsTemplate}
              disabled={savingTemplate || busy}
              className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-line transition-colors disabled:opacity-50"
            >
              {templateSaved ? '✓ Saved as template' : savingTemplate ? 'Saving…' : 'Save as template'}
            </button>
          )}
          <button
            onClick={() => { setNameDraft(flow.name); setRenaming(true); setConfirmDelete(false); setDuplicating(false) }}
            className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-line transition-colors"
          >
            Rename
          </button>
          <button
            onClick={() => { setDuplicating(d => !d); setConfirmDelete(false); setRenaming(false) }}
            className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-line transition-colors"
          >
            Duplicate
          </button>
          <button
            onClick={() => { setConfirmDelete(true); setRenaming(false); setDuplicating(false) }}
            className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] font-semibold text-mute hover:text-[#C0432D] hover:border-[#C0432D] transition-colors"
          >
            Delete flow
          </button>
        </div>
        {duplicating && (
          <div className="mt-2.5 rounded-md border border-line-2 bg-surf-2 px-3 py-2.5">
            <p className="text-[12px] text-ink leading-relaxed">
              Duplicate <span className="font-semibold">{flow.name}</span>? Creates a copy with all {flow.stepCount} task{flow.stepCount !== 1 ? 's' : ''}, contracts, and edge structure in a new section <span className="font-mono text-[11px]">"{flow.name} (copy)"</span>. Tasks start as pending.
            </p>
            <div className="flex gap-2 mt-2.5">
              <button disabled={busy} onClick={doDuplicate}
                className="rounded-md bg-ink text-paper px-3 py-1 text-[11px] font-semibold disabled:opacity-60">
                {busy ? 'Duplicating…' : 'Duplicate flow'}
              </button>
              <button disabled={busy} onClick={() => setDuplicating(false)}
                className="rounded-md border border-line-2 px-3 py-1 text-[11px] font-semibold text-mute hover:text-ink">
                Cancel
              </button>
            </div>
          </div>
        )}
        {confirmDelete && (
          <div className="mt-2.5 rounded-md border border-[#C0432D]/40 bg-[#C0432D]/5 px-3 py-2.5">
            <p className="text-[12px] text-ink leading-relaxed">
              Delete <span className="font-semibold">{flow.name}</span>? Its {flow.stepCount} task{flow.stepCount !== 1 ? 's' : ''} will be moved to a new section{' '}
              <span className="font-mono text-[11px]">“{flow.name} - Flow Tasks”</span>, and the flow{flow.flowRecordId ? ' — its edges, name, IS & KB' : ' (its edges)'} will be removed. The tasks themselves are kept.
            </p>
            <div className="flex gap-2 mt-2.5">
              <button
                disabled={busy}
                onClick={doDelete}
                className="rounded-md bg-[#C0432D] text-paper px-3 py-1 text-[11px] font-semibold disabled:opacity-60"
              >
                {busy ? 'Deleting…' : 'Delete flow'}
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-line-2 px-3 py-1 text-[11px] font-semibold text-mute hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {/* IS / KB drawer — full width, because the pane it used to live in is conditional now. */}
      {panel && (
        <div className="shrink-0 border-b border-line-2 bg-surf-2 max-h-[38vh] overflow-auto px-6 py-3 no-scrollbar z-10 shadow-md">
          <Kicker>{panel === 'is' ? 'Flow Instruction Set' : 'Flow Knowledge Base'}</Kicker>
          {!flow.flowRecordId ? (
            <p className="text-[12px] text-mute mt-2 leading-relaxed">
              This flow isn’t named yet, so it has no {panel === 'is' ? 'Instruction Set' : 'Knowledge Base'}.
              Name it via the MCP (<span className="font-mono">name_flow</span>) to attach one.
            </p>
          ) : panelEntries == null ? (
            <p className="text-[12px] text-mute mt-2">Loading…</p>
          ) : panelEntries.length === 0 ? (
            <p className="text-[12px] text-mute mt-2 leading-relaxed">
              {panel === 'is'
                ? 'No flow IS — tasks in this flow use the project Instruction Set.'
                : 'No flow Knowledge Base entries.'}
            </p>
          ) : (
            <div className="flex flex-col gap-3 mt-2">
              {panelEntries.map(e => (
                <div key={e.id}>
                  <p className="text-[12.5px] font-semibold text-ink">{e.title}</p>
                  <p className="text-[12px] text-ink-2 whitespace-pre-wrap leading-relaxed mt-0.5">{e.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* The graph draws the I/O DAG, so it earns the larger pane only when there are
            edges to draw. Contracts are optional (TDE-792) — a gateless flow rendered a
            scatter of disconnected nodes over a third of the screen, saying nothing. When
            there is no DAG the cockpit is not demoted to a sidebar; it IS the page. */}
        {hasGraph && (
          <>
            <div className="flex-1 flex flex-col min-w-0 bg-surf relative">
              <div className="flex-1 relative min-h-0">
                <FlowGraph steps={flow.steps} prefix={flow.projectPrefix} onTaskClick={setSelectedTaskId} />
              </div>
            </div>
            <div
              onPointerDown={startResizeX}
              title="Drag to resize"
              className="group shrink-0 w-1.5 flex flex-col items-center justify-center cursor-col-resize border-l border-line-2 bg-surf-2 hover:bg-surf transition-colors z-20"
            >
              <span className="w-0.5 h-8 rounded-full bg-line group-hover:bg-mute-2 transition-colors" />
            </div>
          </>
        )}

        {/* Cockpit: what needs me, then how far through am I. */}
        <div
          className={clsx('flex flex-col min-w-0 bg-paper z-10', hasGraph ? 'shrink-0' : 'flex-1')}
          style={hasGraph ? { width: listWidth } : undefined}
        >
          <div className="shrink-0 border-b border-line-2 bg-surf-2 px-5 py-3">
            <div className={clsx(!hasGraph && 'max-w-[860px] mx-auto w-full')}>
              <LiveStatusBanner flow={flow} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 no-scrollbar relative">
            <div className={clsx('flex flex-col gap-5', !hasGraph && 'max-w-[860px] mx-auto w-full')}>
              <FlowExceptions flow={flow} onTaskClick={setSelectedTaskId} />
              <div>
                <Kicker className="mb-1 px-2">STEPS</Kicker>
                <FlowStepList steps={flow.steps} prefix={flow.projectPrefix} onTaskClick={setSelectedTaskId} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedTaskId && (() => {
        const stepObj = flow.steps.find(s => s.task.id === selectedTaskId)
        if (!stepObj) return null
        return (
          <FlowTaskPanel
            task={stepObj.task}
            stepIndex={stepObj.step}
            totalSteps={flow.stepCount}
            prefix={flow.projectPrefix}
            onClose={() => setSelectedTaskId(null)}
            onTaskUpdated={onChanged}
          />
        )
      })()}
    </div>
  )
}

export default function FlowsPage() {
  const { flows, projects, loading, refetch } = useFlows()
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
            <div className="flex items-start justify-between gap-2">
              <Kicker className="mb-2">FLOWS</Kicker>
              <button
                onClick={() => setListOpen(false)}
                title="Hide list"
                className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-mute hover:text-ink transition-colors -mt-0.5"
              >
                <PanelLeftClose size={14} />
                <span>Hide list</span>
              </button>
            </div>
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
                <p className="text-[12px] text-mute leading-relaxed">
                  A flow is one operation too big for a single sitting. Run <span className="font-mono">build_new_flow</span> via the MCP — contracts are optional, so it does not need gates to be a flow.
                </p>
              </div>
            ) : filtered.map(f => (
              <FlowCard key={f.id} flow={f} active={selected?.id === f.id} onClick={() => setSelectedId(f.id)} />
            ))}
          </div>
        </div>

        {/* Detail column */}
        <div className={clsx('flex-1 min-w-0', selected ? 'block' : 'hidden md:block')}>
          {selected ? (
            <FlowDetail
              flow={selected}
              onBack={() => setSelectedId(null)}
              listOpen={listOpen}
              onToggleList={() => setListOpen(o => !o)}
              onChanged={refetch}
              onDeleted={() => { setSelectedId(null); refetch() }}
            />
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
