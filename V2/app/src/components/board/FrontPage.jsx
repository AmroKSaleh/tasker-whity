import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Play, Pause } from 'lucide-react'
import { rankTasks } from '../../lib/scoring'
import { Kicker } from '../editorial/atoms'
import AwaitingInputStrip from './AwaitingInputStrip'

// ── Masthead constellation ──
// One mote per standalone task: grey pending, green done, orange in flight
// (drifts faster, breathes), indigo escalated (waiting on the human).
// Data-true ambient presence — not decoration. Honors prefers-reduced-motion.
function hexToRgba(hex, a) {
  const h = hex.replace('#', '').trim()
  if (h.length !== 6) return `rgba(107,104,103,${a})`
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

export function MastheadSky({ tasks }) {
  const ref = useRef(null)
  const counts = useMemo(() => {
    let done = 0, flight = 0, you = 0, pending = 0
    for (const t of tasks) {
      if (t.review_verdict?.escalated) you++
      else if (t.status === 'done') done++
      else if (t.status === 'in_progress') flight++
      else pending++
    }
    return { done, flight, you, pending }
  }, [tasks])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const css = getComputedStyle(document.documentElement)
    const COLORS = {
      done:    hexToRgba(css.getPropertyValue('--color-priority-done') || '#5C7A5F', 0.34),
      pending: hexToRgba(css.getPropertyValue('--color-mute') || '#6B6867', 0.30),
      flight:  hexToRgba(css.getPropertyValue('--color-accent') || '#D97757', 0.85),
      you:     hexToRgba(css.getPropertyValue('--color-review') || '#4B57D8', 0.95),
    }
    let w = 0, h = 0, raf = 0, t = 0
    let mx = 0.5, my = 0.5
    const motes = []

    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth; h = canvas.clientHeight
      canvas.width = w * dpr; canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    function seed() {
      motes.length = 0
      const total = Math.min(counts.done + counts.pending + counts.flight + counts.you, 400)
      const kinds = []
      for (let i = 0; i < counts.you; i++) kinds.push('you')
      for (let i = 0; i < counts.flight; i++) kinds.push('flight')
      for (let i = 0; i < counts.pending; i++) kinds.push('pending')
      for (let i = 0; i < counts.done; i++) kinds.push('done')
      for (let i = 0; i < total; i++) {
        const kind = kinds[i]
        const fast = kind === 'flight' || kind === 'you'
        motes.push({
          x: Math.random() * w, y: Math.random() * h, kind,
          r: kind === 'you' ? 2.6 : kind === 'flight' ? 2.2 : 1.2 + Math.random() * 0.7,
          vx: (Math.random() - 0.5) * (fast ? 0.22 : 0.07),
          vy: (Math.random() - 0.5) * (fast ? 0.16 : 0.05),
          ph: Math.random() * Math.PI * 2,
        })
      }
    }
    function frame() {
      t += 0.016
      ctx.clearRect(0, 0, w, h)
      const px = (mx - 0.5) * 7, py = (my - 0.5) * 5
      for (const m of motes) {
        if (!reduced) {
          m.x += m.vx; m.y += m.vy
          if (m.x < -4) m.x = w + 4; if (m.x > w + 4) m.x = -4
          if (m.y < -4) m.y = h + 4; if (m.y > h + 4) m.y = -4
        }
        const depth = m.kind === 'done' ? 0.35 : m.kind === 'pending' ? 0.6 : 1
        const breathe = (m.kind === 'flight' || m.kind === 'you') && !reduced
          ? 0.65 + 0.35 * Math.sin(t * 2 + m.ph) : 1
        ctx.globalAlpha = breathe
        ctx.fillStyle = COLORS[m.kind]
        ctx.beginPath()
        ctx.arc(m.x + px * depth, m.y + py * depth, m.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      if (!reduced) raf = requestAnimationFrame(frame)
    }
    function onMove(e) { mx = e.clientX / window.innerWidth; my = e.clientY / window.innerHeight }
    function onResize() { size(); seed(); if (reduced) frame() }

    size(); seed(); frame()
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', onResize)
    }
  }, [counts.done, counts.pending, counts.flight, counts.you])

  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
}

// ── Front Page pieces ──
function agoLabel(iso) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'TODAY'
  if (days === 1) return 'YESTERDAY'
  if (days < 14) return `${days}D AGO`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

const PRI_LABEL = { rush: 'RUSH', high: 'HIGH', medium: 'MED', low: 'LOW' }

function NextUpList({ ranked, sectionName, onOpenTask }) {
  return (
    <ol className="list-none m-0 p-0">
      {ranked.map((t, i) => (
        <li key={t.id}>
          <button
            onClick={() => onOpenTask(t.id)}
            className="group w-full text-left flex items-baseline gap-3 py-2.5 px-0.5 border-b border-line-2"
          >
            <span className="font-mono text-[10px] text-mute-2 min-w-[18px] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
            <span className="flex-1 text-[13px] font-medium leading-snug text-ink group-hover:text-accent-dark transition-colors">{t.text}</span>
            <span className="flex flex-col items-end gap-0.5 shrink-0">
              {t.priority && (
                <span className={clsx('font-mono text-[9px] tracking-[0.1em]', t.priority === 'rush' ? 'text-priority-rush font-bold' : 'text-mute')}>{PRI_LABEL[t.priority]}</span>
              )}
              <span className="font-mono text-[8.5px] tracking-[0.08em] text-mute-2 uppercase">{sectionName(t.section_id)}</span>
            </span>
          </button>
        </li>
      ))}
      {ranked.length === 0 && <li className="text-[12px] text-mute-2 py-2">Nothing ranked — the backlog is quiet.</li>}
    </ol>
  )
}

function InFlightCard({ task, prefix, sectionName, onOpenTask, onPause }) {
  return (
    <article
      onClick={() => onOpenTask(task.id)}
      className="border border-line-2 bg-paper rounded-xl px-4 py-3.5 cursor-pointer shadow-sm transition-all duration-150 hover:-translate-y-[1px] hover:shadow-card hover:border-line"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-[7px] h-[7px] rounded-full bg-accent dot-live shrink-0" />
        <span className="font-mono text-[9.5px] tracking-[0.08em] text-mute">{prefix}-{task.short_id}</span>
        <span className="font-mono text-[9px] tracking-[0.1em] text-mute-2 uppercase ml-auto">{sectionName(task.section_id)}</span>
      </div>
      <p className="text-[13px] font-medium leading-snug text-ink m-0">{task.text}</p>
      <div className="flex gap-3 mt-2.5">
        <button
          onClick={e => { e.stopPropagation(); onOpenTask(task.id) }}
          className="font-mono text-[9px] tracking-[0.12em] text-mute-2 hover:text-ink transition-colors"
        >OPEN</button>
        <button
          onClick={e => { e.stopPropagation(); onPause(task) }}
          className="font-mono text-[9px] tracking-[0.12em] text-mute-2 hover:text-ink transition-colors inline-flex items-center gap-1"
        ><Pause size={8} /> PAUSE</button>
      </div>
    </article>
  )
}

function LeadCard({ task, prefix, onOpenTask }) {
  const [showCritique, setShowCritique] = useState(false)
  const fails = (task.review_verdict?.results || []).filter(r => r.status === 'fail')
  const narrative = task.review_verdict?.narrative
  const deck = narrative?.core || fails[0]?.note || task.review_verdict?.critique || 'The judge escalated this task to you after exhausting its self-revision budget.'
  return (
    <article className="rounded-xl border border-review/30 bg-review-soft px-6 py-5 mb-4 transition-colors hover:border-review/60">
      <div className="font-mono text-[9.5px] tracking-[0.15em] text-review font-bold mb-2.5 uppercase">
        ◆ Needs you — judge escalated after {task.review_verdict?.attempt ?? 3} attempts
      </div>
      <h2
        onClick={() => onOpenTask(task.id)}
        className="font-display font-semibold text-[24px] leading-[1.18] tracking-[-0.01em] text-ink m-0 mb-2 cursor-pointer"
        style={{ textWrap: 'balance' }}
      >{task.text}</h2>
      <p className="text-[13px] text-ink-2 leading-relaxed m-0 mb-3.5 max-w-[58ch]">{deck}</p>
      {showCritique && (
        <div className="border-l-2 border-review pl-3.5 py-1 mb-3.5 flex flex-col gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.12em] text-mute-2 uppercase">Validator notes</span>
          {narrative?.sections?.length
            ? narrative.sections.map((s, i) => <p key={i} className="text-[12.5px] text-ink-2 leading-snug m-0">{s.point}{s.consequence ? ` — ${s.consequence}` : ''}</p>)
            : fails.length > 0
              ? fails.map((f, i) => <p key={i} className="text-[12.5px] text-ink-2 leading-snug m-0">FAIL — {f.note || f.rule || 'no note recorded'}</p>)
              : <p className="text-[12.5px] text-ink-2 m-0">{task.review_verdict?.critique || 'No detailed critique recorded.'}</p>}
          {narrative?.secondary && <p className="text-[11px] text-mute-2 leading-snug m-0 mt-1">{narrative.secondary}</p>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onOpenTask(task.id)}
          className="btn btn-sm hover:brightness-110"
          style={{ background: 'var(--color-review)', borderColor: 'var(--color-review)', color: '#fff' }}
        >Open task</button>
        <button onClick={() => setShowCritique(s => !s)} className="btn btn-sm">{showCritique ? 'Hide the critique' : 'Read the critique'}</button>
        <span className="font-mono text-[9px] tracking-[0.08em] text-mute-2 ml-1">{prefix}-{task.short_id}</span>
      </div>
    </article>
  )
}

// ── The Front Page ──
// Attention-first landing for the project: lead slot (escalations, then in-flight),
// ranked Next Up (lib/scoring), Just Shipped, and the sections digest.
// Recomposes when the lead is empty: Next Up takes the lead column.
export default function FrontPage({ project, tasks, sections, onOpenTask, onPause, onFocusSection }) {
  const sectionById = useMemo(() => new Map(sections.map(s => [s.id, s])), [sections])
  const sectionName = (id) => sectionById.get(id)?.name ?? ''

  const needsYou = useMemo(() => tasks.filter(t => t.review_verdict?.escalated), [tasks])
  const inFlight = useMemo(() => tasks.filter(t => t.status === 'in_progress' && !t.review_verdict?.escalated), [tasks])
  const ranked = useMemo(() => rankTasks(tasks).slice(0, 5), [tasks])
  const shipped = useMemo(() =>
    tasks
      .filter(t => t.status === 'done' && t.completed_at)
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
      .slice(0, 5),
    [tasks])

  const hasLead = needsYou.length > 0 || inFlight.length > 0

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-paper">
      <div className="px-7 pb-16">

        <AwaitingInputStrip tasks={tasks} prefix={project.prefix} onOpenTask={onOpenTask} />

        <div className="grid grid-cols-1 lg:grid-cols-12 lg:gap-x-9 py-6">
          {/* Lead column */}
          <section className="lg:col-span-8">
            {hasLead ? (
              <>
                <div className="flex items-baseline justify-between mb-4">
                  <Kicker>Happening now</Kicker>
                  <Kicker>{inFlight.length + needsYou.length} in flight{needsYou.length > 0 ? ` · ${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` : ''}</Kicker>
                </div>
                {needsYou.map(t => <LeadCard key={t.id} task={t} prefix={project.prefix} onOpenTask={onOpenTask} />)}
                {inFlight.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    {inFlight.map(t => (
                      <InFlightCard key={t.id} task={t} prefix={project.prefix} sectionName={sectionName} onOpenTask={onOpenTask} onPause={onPause} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <Kicker>Next up</Kicker>
                  <Kicker>All quiet — ranked queue</Kicker>
                </div>
                <NextUpList ranked={ranked} sectionName={sectionName} onOpenTask={onOpenTask} />
              </>
            )}
          </section>

          {/* Rail */}
          <aside className="lg:col-span-4 lg:border-l lg:border-line-2 lg:pl-9 mt-8 lg:mt-0 pt-8 lg:pt-0 border-t border-line-2 lg:border-t-0">
            {hasLead ? (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <Kicker>Next up</Kicker>
                  <span title="Priority + due date + pins, with skip-decay"><Kicker>Ranked</Kicker></span>
                </div>
                <NextUpList ranked={ranked} sectionName={sectionName} onOpenTask={onOpenTask} />
              </>
            ) : (
              <>
                <div className="mb-2"><Kicker>Just shipped</Kicker></div>
                <ShippedList shipped={shipped} onOpenTask={onOpenTask} />
              </>
            )}
          </aside>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 lg:gap-x-9 py-6 border-t border-line-2">
          {hasLead && (
            <section className="lg:col-span-4">
              <div className="mb-2"><Kicker>Just shipped</Kicker></div>
              <ShippedList shipped={shipped} onOpenTask={onOpenTask} />
            </section>
          )}
          <section className={clsx(hasLead ? 'lg:col-span-8 lg:border-l lg:border-line-2 lg:pl-9 mt-8 lg:mt-0' : 'lg:col-span-12')}>
            <div className="flex items-baseline justify-between mb-2">
              <Kicker count={sections.length}>Sections</Kicker>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-9">
              {sections.map(s => {
                const pctS = s.totalCount ? Math.round((s.completedCount / s.totalCount) * 100) : 0
                const untouched = s.totalCount > 0 && s.completedCount === 0
                return (
                  <button
                    key={s.id}
                    onClick={() => onFocusSection(s.id)}
                    className="group flex items-center gap-3 py-2 border-b border-line-2 text-left"
                    title={`${s.completedCount}/${s.totalCount} done — open ${s.name}`}
                  >
                    <span className="flex-1 text-[12.5px] font-medium text-ink group-hover:text-accent-dark transition-colors truncate">{s.name}</span>
                    {untouched && <span className="font-mono text-[8.5px] tracking-[0.1em] border border-line rounded px-1.5 py-0.5 text-mute shrink-0">UNTOUCHED</span>}
                    <span className="w-[74px] h-[3px] rounded-full bg-surf overflow-hidden shrink-0">
                      <span className="block h-full bg-ink rounded-full" style={{ width: `${pctS}%` }} />
                    </span>
                    <span className="font-mono text-[10px] text-mute tabular-nums min-w-[44px] text-right shrink-0">{s.completedCount}/{s.totalCount}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>

      </div>
    </div>
  )
}

function ShippedList({ shipped, onOpenTask }) {
  return (
    <ul className="list-none m-0 p-0">
      {shipped.map(t => (
        <li key={t.id}>
          <button onClick={() => onOpenTask(t.id)} className="group w-full text-left flex items-baseline gap-2.5 py-2">
            <span className="text-priority-done text-[12px] leading-none translate-y-px">✓</span>
            <span className="flex-1 text-[12.5px] text-ink-2 group-hover:text-ink transition-colors leading-snug">{t.text}</span>
            <span className="font-mono text-[9px] tracking-[0.08em] text-mute-2 whitespace-nowrap">{agoLabel(t.completed_at)}</span>
          </button>
        </li>
      ))}
      {shipped.length === 0 && <li className="text-[12px] text-mute-2 py-2">Nothing shipped yet.</li>}
    </ul>
  )
}
