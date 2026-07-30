import { useState, useEffect } from 'react'
import clsx from 'clsx'

// Prepare → confirm → execute (TDE-377 Path A): the human reviews the agent's prepared proposal,
// edits it (edits become the instructions the agent follows), and confirms. Confirming flips
// agent_proposal_confirmed; the agent executes the confirmed proposal on its next run.
export default function AgentProposal({ task, onPatch }) {
  const [draft, setDraft] = useState(task.agent_proposal || '')
  useEffect(() => { setDraft(task.agent_proposal || '') }, [task.id])

  if (!task.agent_proposal) return null
  const confirmed = task.agent_proposal_confirmed
  const dirty = draft.trim() !== (task.agent_proposal || '').trim()

  const saveEdits = () => { if (dirty && draft.trim()) onPatch({ agent_proposal: draft.trim() }) }
  const confirm = () => onPatch(dirty && draft.trim() ? { agent_proposal: draft.trim(), agent_proposal_confirmed: true } : { agent_proposal_confirmed: true })
  const unconfirm = () => onPatch({ agent_proposal_confirmed: false })
  const discard = () => onPatch({ agent_proposal: '' })

  return (
    <div className={clsx('rounded-lg border p-3', confirmed ? 'border-priority-done/40 bg-priority-done/[0.05]' : 'border-review/40 bg-review-soft')}>
      <div className="mb-2 font-mono text-[9px] font-bold uppercase tracking-[0.08em]">
        <span className={confirmed ? 'text-priority-done' : 'text-review'}>
          {confirmed ? '✓ Confirmed — the agent will execute this' : '◇ Proposed work — review, edit & confirm'}
        </span>
      </div>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={saveEdits}
        rows={5}
        className="w-full resize-y rounded-md border border-line-2 bg-paper p-2.5 text-[12px] leading-[1.5] text-ink-2 outline-none focus:border-accent"
      />
      {confirmed ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-[10.5px] text-mute-2">Runs on the agent's next pass. Edit above to change what it does.</span>
          <button onClick={unconfirm} className="ml-auto shrink-0 text-[11px] text-mute transition-colors hover:text-ink">Unconfirm</button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={confirm}
            disabled={!draft.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {dirty ? 'Save & confirm' : 'Confirm'}
          </button>
          {dirty && <button onClick={saveEdits} className="text-[11px] text-mute transition-colors hover:text-ink">Save edits only</button>}
          <button onClick={discard} className="ml-auto shrink-0 text-[11px] text-mute transition-colors hover:text-red-500">Discard</button>
        </div>
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-mute-2">Your edits become the instructions the agent follows.</p>
    </div>
  )
}
