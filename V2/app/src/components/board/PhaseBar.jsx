import clsx from 'clsx'
import { phaseTint } from '../../hooks/usePhases'

// TDE-804. Two readouts in one component, chosen by where the user IS:
//   * whole-project — the aggregate, segmented per phase plus an explicit unphased segment
//   * inside a phase — that phase alone
// Navigation is the disclosure mechanism: entering a phase IS the split, so there is no
// click-to-expand state to own.
//
// The aggregate must stay reachable and honest. A phase reading 85% while the project sits
// at 30% is the failure mode; hiding the total is what turns a progress readout into a
// morale trick, so the total is always one click away and always counts everything.

function pctOf(done, total) { return total ? Math.round((done / total) * 100) : 0 }

// Flow steps left every denominator in TDE-320 and the /projects card was fixed to match in
// TDE-806 — callers pass already-filtered tasks, so this only splits by phase.
export function phaseTally(tasks, phases) {
  const byPhase = new Map(phases.map(p => [p.id, { done: 0, total: 0 }]))
  const unphased = { done: 0, total: 0 }
  for (const t of tasks) {
    const bucket = (t.phase_id && byPhase.get(t.phase_id)) || (t.phase_id ? null : unphased)
    if (!bucket) continue // phase_id pointing at a phase we don't have loaded
    bucket.total++
    if (t.status === 'done') bucket.done++
  }
  return { byPhase, unphased }
}

export default function PhaseBar({
  phases, tasks, viewingPhaseId, activePhaseId, onSelectPhase, onManage, animate = true,
}) {
  const { byPhase, unphased } = phaseTally(tasks, phases)

  // No phases: the project isn't using the feature. Render nothing and let the board's own
  // readout stand — an empty phase strip on every project would be pure noise.
  if (!phases.length) return null

  const viewing = viewingPhaseId ? phases.find(p => p.id === viewingPhaseId) : null

  if (viewing) {
    const c = byPhase.get(viewing.id) ?? { done: 0, total: 0 }
    const pct = pctOf(c.done, c.total)
    return (
      <div className="pb-4">
        <PhaseNav
          phases={phases} byPhase={byPhase} unphased={unphased}
          viewingPhaseId={viewingPhaseId} activePhaseId={activePhaseId}
          onSelectPhase={onSelectPhase} onManage={onManage}
        />
        <div className="mt-3 flex items-end justify-between gap-8">
          <div className="min-w-0">
            <div className="font-mono text-[9.5px] tracking-[0.12em] text-mute uppercase">Phase progress</div>
            <div className="font-display font-semibold text-[26px] leading-tight tracking-[-0.02em] truncate">{viewing.name}</div>
            {viewing.exit_condition
              ? <p className="m-0 mt-1 text-[12px] text-ink-2 max-w-[62ch]">Ends when: {viewing.exit_condition}</p>
              : <p className="m-0 mt-1 text-[12px] text-mute-2 max-w-[62ch]">No exit condition — until this phase says what must be true to end, it is only a bucket.</p>}
            {viewing.due_date && <p className="m-0 mt-0.5 font-mono text-[10px] text-mute">Target {viewing.due_date} (optional)</p>}
          </div>
          <div className="text-right shrink-0" title={`${c.done} of ${c.total} tasks in this phase complete`}>
            <div className="font-display font-semibold text-[30px] leading-none tracking-[-0.02em] tabular-nums">{pct}%</div>
            <span className="inline-block h-[5px] w-44 rounded-full bg-surf overflow-hidden mt-2 mb-1.5">
              <span className="block h-full bg-ink rounded-full transition-[width] duration-1000 ease-out"
                    style={{ width: animate ? `${pct}%` : '0%' }} />
            </span>
            <div className="font-mono text-[9.5px] text-mute tracking-[0.08em]">{c.done} / {c.total} IN PHASE</div>
          </div>
        </div>
      </div>
    )
  }

  // ── Whole-project aggregate ──
  const total = tasks.length
  const done = tasks.filter(t => t.status === 'done').length
  const segments = [
    ...phases.map((p, i) => {
      const c = byPhase.get(p.id) ?? { done: 0, total: 0 }
      return { key: p.id, name: p.name, ...c, tint: phaseTint(i), phase: p }
    }),
    // Unphased is a SEGMENT, never a silent residual. Dropping it would make the aggregate
    // disagree with the board by exactly the unphased count — the TDE-806 bug, rebuilt.
    { key: 'unphased', name: 'Unphased', ...unphased, tint: 'var(--color-surf)', phase: null },
  ].filter(s => s.total > 0)

  return (
    <div className="pb-4">
      <PhaseNav
        phases={phases} byPhase={byPhase} unphased={unphased}
        viewingPhaseId={null} activePhaseId={activePhaseId}
        onSelectPhase={onSelectPhase} onManage={onManage}
      />
      <div className="mt-3 flex items-end justify-between gap-8">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9.5px] tracking-[0.12em] text-mute uppercase mb-2">
            Whole project — {phases.length} phase{phases.length !== 1 ? 's' : ''}
            {unphased.total > 0 && ` · ${unphased.total} unphased`}
          </div>
          <div className="flex gap-1 h-[9px] w-full max-w-[520px]">
            {segments.map(s => {
              const pct = pctOf(s.done, s.total)
              return (
                <button
                  key={s.key}
                  onClick={() => onSelectPhase(s.phase?.id ?? 'unphased')}
                  title={`${s.name} — ${s.done}/${s.total} done (${pct}%)`}
                  className="relative rounded-full overflow-hidden border-0 p-0 cursor-pointer"
                  style={{ background: s.tint, flexGrow: s.total, flexBasis: 0 }}
                >
                  <span className="absolute inset-0 bg-ink/15" />
                  <span className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-1000 ease-out"
                        style={{ width: animate ? `${pct}%` : '0%' }} />
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {segments.map(s => (
              <span key={s.key} className="inline-flex items-center gap-1.5 font-mono text-[9.5px] text-mute tracking-[0.06em]">
                <span className="w-2 h-2 rounded-full border border-line-2" style={{ background: s.tint }} />
                {s.name.toUpperCase()} {s.done}/{s.total}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right shrink-0" title={`${done} of ${total} tasks complete across every phase`}>
          <div className="font-display font-semibold text-[30px] leading-none tracking-[-0.02em] tabular-nums">{pctOf(done, total)}%</div>
          <div className="font-mono text-[9.5px] text-mute tracking-[0.08em] mt-1.5">{done} / {total} TOTAL</div>
        </div>
      </div>
    </div>
  )
}

function PhaseNav({ phases, byPhase, unphased, viewingPhaseId, activePhaseId, onSelectPhase, onManage }) {
  const tab = (key, label, count, isOn, tint) => (
    <button
      key={key}
      onClick={() => onSelectPhase(key)}
      className={clsx(
        'appearance-none border rounded-full cursor-pointer px-3 py-1 font-mono text-[9.5px] tracking-[0.1em] uppercase transition-colors inline-flex items-center gap-1.5',
        isOn ? 'border-ink text-ink' : 'border-line-2 text-mute hover:text-ink hover:border-line',
      )}
    >
      {tint && <span className="w-2 h-2 rounded-full border border-line-2" style={{ background: tint }} />}
      {label}
      {count != null && <span className="text-mute-2 tabular-nums">{count}</span>}
    </button>
  )

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {tab('all', 'All phases', null, !viewingPhaseId, null)}
      {phases.map((p, i) => {
        const c = byPhase.get(p.id) ?? { done: 0, total: 0 }
        return (
          <span key={p.id} className="inline-flex items-center">
            {tab(p.id, p.name, c.total, viewingPhaseId === p.id, phaseTint(i))}
            {/* The ACTIVE phase is what the agent's queue scopes to — a different fact from
                which phase you are currently looking at, so it gets its own marker. */}
            {p.id === activePhaseId && (
              <span className="ml-1 font-mono text-[8.5px] text-accent tracking-[0.1em]" title="Active phase — get_ready_work scopes the agent queue to this">● NOW</span>
            )}
          </span>
        )
      })}
      {unphased.total > 0 && tab('unphased', 'Unphased', unphased.total, viewingPhaseId === 'unphased', 'var(--color-surf)')}
      <button
        onClick={onManage}
        className="appearance-none border border-line-2 rounded-full cursor-pointer px-3 py-1 font-mono text-[9.5px] tracking-[0.1em] uppercase text-mute hover:text-ink hover:border-line transition-colors"
      >Phases…</button>
    </div>
  )
}
