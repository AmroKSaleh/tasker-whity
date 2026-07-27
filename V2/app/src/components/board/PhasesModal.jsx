import { useState } from 'react'
import { phaseTint } from '../../hooks/usePhases'

// TDE-804 phase management. The exit condition is the load-bearing field, so the form asks
// for it as prominently as the name and the list calls out phases missing one — a phase
// without an exit condition can't tell you when it ends, which is the whole primitive.
export default function PhasesModal({
  phases, activePhaseId, taskCounts, onClose,
  onCreate, onUpdate, onDelete, onSetActive, onReorder,
}) {
  const [name, setName] = useState('')
  const [exit, setExit] = useState('')
  const [due, setDue] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    await onCreate({ name: name.trim(), exit_condition: exit.trim() || null, due_date: due || null })
    setName(''); setExit(''); setDue('')
    setBusy(false)
  }

  async function move(index, delta) {
    const next = [...phases]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    await onReorder(next)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4" style={{ background: 'rgba(26,25,22,0.45)' }} onClick={onClose}>
      <div className="bg-paper border border-line rounded-2xl w-full max-w-[680px] p-6 shadow-panel" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-1">
          <h2 className="font-display font-semibold text-[24px] tracking-[-0.02em] m-0">Phases</h2>
          <button onClick={onClose} className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">Close</button>
        </div>
        <p className="m-0 mb-5 text-[12.5px] text-ink-2 max-w-[60ch]">
          A phase is a stage bounded by a condition, not a date — "ends when we launch". A deadline is
          optional. Tasks in no phase stay unphased, which is a valid resting state, not a backlog.
        </p>

        {phases.length === 0 && (
          <p className="m-0 mb-5 text-[12.5px] text-mute-2">No phases yet. The first one you create becomes the active phase.</p>
        )}

        <div className="flex flex-col gap-2 mb-6">
          {phases.map((p, i) => {
            const c = taskCounts.get(p.id) ?? { done: 0, total: 0 }
            const isEditing = editingId === p.id
            return (
              <div key={p.id} className="border border-line-2 rounded-xl p-3">
                <div className="flex items-start gap-3">
                  <span className="w-3 h-3 rounded-full border border-line-2 mt-1 shrink-0" style={{ background: phaseTint(i) }} />
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <PhaseEditor
                        phase={p}
                        onCancel={() => setEditingId(null)}
                        onSave={async (patch) => { await onUpdate(p.id, patch); setEditingId(null) }}
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[14px] font-semibold text-ink">{p.name}</span>
                          {p.id === activePhaseId && <span className="font-mono text-[8.5px] text-accent tracking-[0.1em]">● ACTIVE</span>}
                          <span className="font-mono text-[9.5px] text-mute tabular-nums">{c.done}/{c.total}</span>
                        </div>
                        {p.exit_condition
                          ? <p className="m-0 mt-1 text-[12px] text-ink-2">Ends when: {p.exit_condition}</p>
                          : <p className="m-0 mt-1 text-[12px] text-mute-2">⚠ No exit condition — add one, or this is just a bucket.</p>}
                        {p.due_date && <p className="m-0 mt-0.5 font-mono text-[10px] text-mute">Target {p.due_date}</p>}
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => move(i, -1)} disabled={i === 0} title="Move earlier"
                              className="btn btn-sm font-mono text-[10px] text-mute hover:text-ink disabled:opacity-30">↑</button>
                      <button onClick={() => move(i, 1)} disabled={i === phases.length - 1} title="Move later"
                              className="btn btn-sm font-mono text-[10px] text-mute hover:text-ink disabled:opacity-30">↓</button>
                      {p.id !== activePhaseId && (
                        <button onClick={() => onSetActive(p.id)} title="Make this the active phase — the agent queue scopes to it"
                                className="btn btn-sm font-mono text-[9.5px] tracking-[0.1em] uppercase text-mute hover:text-ink">Set now</button>
                      )}
                      <button onClick={() => setEditingId(p.id)}
                              className="btn btn-sm font-mono text-[9.5px] tracking-[0.1em] uppercase text-mute hover:text-ink">Edit</button>
                      <button onClick={() => setConfirmDelete(p.id)}
                              className="btn btn-sm font-mono text-[9.5px] tracking-[0.1em] uppercase text-mute hover:text-ink">Delete</button>
                    </div>
                  )}
                </div>
                {confirmDelete === p.id && (
                  <div className="mt-3 pt-3 border-t border-line-2">
                    <p className="m-0 mb-2 text-[12.5px] text-ink-2">
                      Delete "{p.name}"?{' '}
                      {c.total > 0
                        ? <>Its <b className="text-ink">{c.total} task{c.total !== 1 ? 's' : ''}</b> are not deleted — they become unphased.</>
                        : <>It has no tasks.</>}
                    </p>
                    <div className="flex gap-2">
                      <button onClick={async () => { await onDelete(p.id); setConfirmDelete(null) }}
                              className="btn-primary btn-sm font-mono text-[10px] tracking-[0.12em] uppercase">Delete phase</button>
                      <button onClick={() => setConfirmDelete(null)}
                              className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <form onSubmit={submit} className="border-t border-line-2 pt-5">
          <div className="font-mono text-[9.5px] tracking-[0.12em] text-mute uppercase mb-3">Add a phase</div>
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="Phase name — e.g. Phase 1 — Core app"
            className="w-full bg-transparent border border-line rounded-md px-3 py-2 text-[13.5px] outline-none focus:border-accent text-ink mb-2"
          />
          <input
            value={exit} onChange={e => setExit(e.target.value)}
            placeholder="Ends when… — e.g. the app is live and the MCP is documented"
            className="w-full bg-transparent border border-line rounded-md px-3 py-2 text-[13.5px] outline-none focus:border-accent text-ink mb-2"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <label className="font-mono text-[9.5px] tracking-[0.1em] text-mute uppercase">
              Optional deadline{' '}
              <input type="date" value={due} onChange={e => setDue(e.target.value)}
                     className="ml-2 bg-transparent border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-accent text-ink" />
            </label>
            <button type="submit" disabled={!name.trim() || busy}
                    className="btn-primary btn-sm font-mono text-[10px] tracking-[0.12em] uppercase disabled:opacity-40">
              {busy ? 'Adding…' : '+ Add phase'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PhaseEditor({ phase, onSave, onCancel }) {
  const [name, setName] = useState(phase.name)
  const [exit, setExit] = useState(phase.exit_condition ?? '')
  const [due, setDue] = useState(phase.due_date ?? '')
  return (
    <div className="flex flex-col gap-2">
      <input value={name} onChange={e => setName(e.target.value)}
             className="w-full bg-transparent border border-line rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-accent text-ink" />
      <input value={exit} onChange={e => setExit(e.target.value)} placeholder="Ends when…"
             className="w-full bg-transparent border border-line rounded-md px-2 py-1.5 text-[12.5px] outline-none focus:border-accent text-ink" />
      <div className="flex items-center gap-2 flex-wrap">
        <input type="date" value={due} onChange={e => setDue(e.target.value)}
               className="bg-transparent border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-accent text-ink" />
        <button
          onClick={() => onSave({ name: name.trim() || phase.name, exit_condition: exit.trim() || null, due_date: due || null })}
          className="btn-primary btn-sm font-mono text-[10px] tracking-[0.12em] uppercase">Save</button>
        <button onClick={onCancel} className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">Cancel</button>
      </div>
    </div>
  )
}
